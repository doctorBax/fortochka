'use strict';
/*
 * netcore — сетевое ядро Fortochka (без Electron-зависимостей):
 *   - config.json / state.json в профиле + миграция старого профиля
 *   - список фронтов: конфиг > автообновление из репо > кэш > вшитый дефолт
 *   - health-check фронтов (реальный WS-upgrade до /apiws) с ранжированием
 *   - DNS-over-HTTPS с кэшем и фолбэком на системный DNS
 *   - allowlist хостов для CONNECT-шимма
 *
 * Почему фронтов нельзя вшивать намертво: домены сообщества умирают,
 * список обновляется без пересборки приложения (репо > кэш > дефолт).
 */
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const APP_NAME = 'fortochka';
const OLD_PROFILE_NAME = 'tgweb-desktop'; // профиль до публичного релиза

// Канонический список фронтов живёт в самом репо: PR с новым доменом = новый
// фронт у всех пользователей без релиза (health-check отсеет мёртвые).
const FRONT_LIST_URL = process.env.FORTOCHKA_FRONT_LIST_URL
  || 'https://raw.githubusercontent.com/doctorBax/fortochka/main/fronts.json';

// Вшитый дефолт — то, с чего всё начинается (совпадает с fronts.json в репо).
// Домены сообщества мрут регулярно — актуальный список едет из репо
// (refreshFromRepo), это только стартовый запас на случай мёртвого кэша.
// Порядок не важен — health-check перестраивает по живости и латентности.
const DEFAULT_FRONTS = [
  'pyatdesyatodin.co.uk',
  'notelega.co.uk',
  'ebally.co.uk',
  'nebally.co.uk',
  'havegreatday.co.uk',
  'pomogite.co.uk',
  'fixtelega.co.uk',
  'sadnews.co.uk',
  'onedaychamp.co.uk',
  'stopblocking.co.uk',
  'nothingthere.co.uk',
  'cakeisalie.co.uk',
  'sorokdva.co.uk',
  'sorokodin.co.uk',
  'pyatdesyatdva.co.uk',
  'pclead.co.uk',
  'offshor.co.uk',
  'noskomnadzor.co.uk',
  'lovetrue.co.uk',
  'kartoshka.co.uk',
  'web.telegram.org' // официальный — всегда последним
];

const DEFAULT_DOH = [
  'https://dns.google/resolve',
  'https://cloudflare-dns.com/dns-query',
  'https://1.1.1.1/dns-query'
];

const DEFAULT_CONFIG = {
  ports: { web: 1081, socks: 1080, mtproto: 1443 },
  fronts: {
    autoUpdate: true,        // подтягивать fronts.json из репо
    list: null               // массив доменов — ручное перекрытие списка
  },
  workerDomains: [],         // свой CF Worker (--cfproxy-worker-domains движка)
  doh: { enabled: true, urls: null }, // null = DEFAULT_DOH
  security: { allowHosts: [] },       // дополнительные хосты для CONNECT
  window: { startMinimized: false, rememberBounds: true }
};

// ---------- профиль: миграция + загрузка config/state ----------
function migrateProfile(appData) {
  const newPath = path.join(appData, APP_NAME);
  const oldPath = path.join(appData, OLD_PROFILE_NAME);
  if (!fs.existsSync(newPath) && fs.existsSync(oldPath)) {
    try {
      fs.renameSync(oldPath, newPath); // сессия/настройки переезжают целиком
    } catch (e) {
      // старая копия могла держать файлы — начинаем с чистого профиля
      console.error('[profile] миграция не удалась: ' + e.message);
    }
  }
  return newPath;
}

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object') return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(extra)) {
    const v = extra[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function setupProfile(userData) {
  fs.mkdirSync(userData, { recursive: true });
  const configFile = path.join(userData, 'config.json');
  if (!fs.existsSync(configFile)) {
    // пишем дефолт сразу — юзер видит, что можно крутить
    try { fs.writeFileSync(configFile, JSON.stringify(DEFAULT_CONFIG, null, 2)); } catch {}
  }
  const config = deepMerge(DEFAULT_CONFIG, loadJson(configFile, {}));
  return { config, configFile, stateFile: path.join(userData, 'state.json') };
}

function loadState(stateFile) {
  return loadJson(stateFile, {});
}

function saveState(stateFile, state) {
  try { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); } catch {}
}

// ---------- список фронтов ----------
// sources: config.fronts.list (ручное) > fetched (авто) > cache > DEFAULT
class FrontManager {
  constructor(config, stateFile, log, doh) {
    this.config = config;
    this.stateFile = stateFile;
    this.log = log || (() => {});
    this.doh = doh; // DoH-резолвер: системный DNS провайдера может травить фронты
    this.fetched = null;      // { domains, source, at }
    this.health = new Map();  // host -> { alive, ms, checkedAt, failStreak }
    this.probing = null;
    this.updateTimer = null;
  }

  start() {
    // кэш автообновления — сразу, чтобы не ждать сеть
    const cached = loadJson(path.join(path.dirname(this.stateFile), 'fronts-cache.json'), null);
    if (cached && Array.isArray(cached.domains)) this.fetched = cached;
    if (this.config.fronts.autoUpdate !== false) {
      this.refreshFromRepo();
      this.updateTimer = setInterval(() => this.refreshFromRepo(), 3 * 60 * 60 * 1000);
      this.updateTimer.unref && this.updateTimer.unref();
    }
    // первая проба — быстрая: воркер строит wss-URL по нашему списку, и пока
    // пробы не сошлись, он может вытащить мёртвый фронт. При реконнектах webk
    // фронт не переротирует — застревает навсегда (симптом: аватарки в блюре,
    // медиа-задачи висят без ошибки). serveFrontsScript дожидается этой пробы.
    this.probesDone = false;
    this.probeAll(2500).then(() => { this.probesDone = true; this.log('[fronts] первая проба готова'); });
  }

  stop() { if (this.updateTimer) clearInterval(this.updateTimer); }

  async refreshFromRepo() {
    try {
      const res = await fetch(FRONT_LIST_URL, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const domains = (Array.isArray(j) ? j : j.domains || [])
        .map((d) => String(d).trim().toLowerCase()).filter(Boolean);
      if (!domains.length) throw new Error('пустой список');
      this.fetched = { domains, source: FRONT_LIST_URL, at: new Date().toISOString() };
      try {
        fs.writeFileSync(path.join(path.dirname(this.stateFile), 'fronts-cache.json'),
          JSON.stringify(this.fetched, null, 2));
      } catch {}
      this.log('[fronts] обновлено из репо: ' + domains.length + ' доменов');
    } catch (e) {
      // сеть может быть блокирована до коннекта — это нормально, живёт кэш/дефолт
      this.log('[fronts] автообновление пропущено: ' + (e.message || e));
    }
  }

  // базовый список без ранжирования
  baseList() {
    if (Array.isArray(this.config.fronts.list) && this.config.fronts.list.length) {
      return { domains: this.config.fronts.list.slice(), source: 'config' };
    }
    if (this.fetched) return { domains: this.fetched.domains.slice(), source: 'repo' };
    return { domains: DEFAULT_FRONTS.slice(), source: 'default' };
  }

  // ранжированный: живые по латентности, потом неопробованные, потом мёртвые
  rankedList() {
    const { domains, source } = this.baseList();
    const scored = domains.map((d) => ({ host: d, h: this.health.get(d) }));
    scored.sort((a, b) => {
      const rank = (x) => !x.h ? 1 : (x.h.alive ? 0 : 2); // 0 живой, 1 неизвестный, 2 мёртвый
      const r = rank(a) - rank(b);
      if (r) return r;
      if (!r && a.h && b.h && a.h.alive && b.h.alive) return a.h.ms - b.h.ms;
      return 0;
    });
    return { domains: scored.map((x) => x.host), source };
  }

  // реальная проверка: WS-upgrade до /apiws с subprotocol 'binary' — то же,
  // что делает webk; 101 = фронт жив, латентность = время до ответа.
  // DNS — через DoH: системный резолвер провайдера может не отдавать фронты.
  async probeHost(host, timeoutMs = 6000) {
    let target = host;
    let servername;
    if (this.doh) {
      const ips = await this.doh.lookup(host).catch(() => null);
      if (ips && ips.length) {
        target = ips[Math.floor(Math.random() * ips.length)];
        servername = host; // SNI обязан быть именем, коннектимся в IP
      }
    }
    return new Promise((resolve) => {
      const started = Date.now();
      const key = crypto.randomBytes(16).toString('base64');
      const req = https.request({
        host: target, servername, port: 443, path: '/apiws', method: 'GET',
        headers: {
          Host: host,
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Version': 13, 'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Protocol': 'binary'
        },
        timeout: timeoutMs
      });
      let done = false;
      const fin = (alive, ms) => {
        if (done) return;
        done = true;
        req.destroy();
        resolve({ alive, ms: alive ? Date.now() - started : null });
      };
      req.on('upgrade', () => fin(true));
      req.on('response', (r) => fin(r.statusCode === 101));
      req.on('timeout', () => fin(false));
      req.on('error', () => fin(false));
      req.end();
    });
  }

  async probeAll(timeoutMs = 6000) {
    if (this.probing) return this.probing;
    const { domains } = this.baseList();
    this.probing = Promise.all(domains.map(async (host) => {
      const prev = this.health.get(host);
      // фронты маршрутизируют только kws{dc}-сабдомены: базовый домен на /apiws
      // не отвечает, поэтому probe бьёт в kws2.<фронт> (иначе все «мёртвые»)
      const probeTarget = host === 'web.telegram.org' || /^kws/.test(host) ? host : 'kws2.' + host;
      const r = await this.probeHost(probeTarget, timeoutMs);
      const failStreak = r.alive ? 0 : ((prev && prev.failStreak || 0) + 1);
      const entry = { alive: r.alive, ms: r.ms, checkedAt: Date.now(), failStreak };
      this.health.set(host, entry);
      return { host, ...entry };
    })).finally(() => { this.probing = null; });
    return this.probing;
  }

  startPeriodicProbes(everyMs = 5 * 60 * 1000) {
    this.probeAll().catch(() => {});
    const t = setInterval(() => this.probeAll().catch(() => {}), everyMs);
    t.unref && t.unref();
  }

  // /fortochka/fronts.js — importScripts() из webk-воркера (синхронный).
  // no-store: каждая ротация транспортов получает свежий список.
  // Пока первая проба не сошлась, ответ придерживается (лимит 4.5с): воркер
  // не должен вытащить мёртвый фронт из ещё непроверенного списка — webk
  // залипает на выбранном фронтe при реконнектах, и медиа-задачи зависают.
  // Мёртвые (проверенно не живые) из отдачи исключаются совсем.
  serveFrontsScript(res) {
    (async () => {
      if (!this.probesDone && this.probing) {
        await Promise.race([this.probing.catch(() => {}), new Promise((r) => setTimeout(r, 4500))]);
      }
      const { domains: ranked, source } = this.rankedList();
      const domains = ranked.filter((d) => {
        const h = this.health.get(d);
        return !(h && h.alive === false);
      });
      const body = 'self.__fortochkaFronts=' + JSON.stringify(domains)
        + ';self.__fortochkaFrontsMeta=' + JSON.stringify({ source, at: Date.now() }) + ';';
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(body);
    })().catch(() => { try { res.destroy(); } catch {} });
  }

  diag() {
    const { domains, source } = this.baseList();
    return {
      source,
      domains,
      health: domains.map((h) => ({ host: h, ...(this.health.get(h) || { alive: null }) }))
    };
  }
}

// ---------- DNS-over-HTTPS ----------
class DohResolver {
  constructor(config, log) {
    this.config = config;
    this.log = log || (() => {});
    this.cache = new Map(); // host -> { ips, until }
    this.workingUrl = null; // первый сработавший — использую его первым
  }

  urls() {
    const conf = this.config.doh && this.config.doh.urls;
    const list = Array.isArray(conf) && conf.length ? conf : DEFAULT_DOH;
    if (this.workingUrl) return [this.workingUrl, ...list.filter((u) => u !== this.workingUrl)];
    return list;
  }

  async lookup(host) {
    if (!this.config.doh || this.config.doh.enabled === false) return null;
    const hit = this.cache.get(host);
    if (hit && hit.until > Date.now()) return hit.ips;
    for (const u of this.urls()) {
      try {
        const sep = u.includes('?') ? '&' : '?';
        const res = await fetch(u + sep + 'name=' + encodeURIComponent(host) + '&type=A', {
          headers: { accept: 'application/dns-json' },
          signal: AbortSignal.timeout(4000)
        });
        if (!res.ok) continue;
        const j = await res.json();
        const ips = (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
        if (ips.length) {
          this.workingUrl = u;
          this.cache.set(host, { ips, until: Date.now() + 10 * 60 * 1000 });
          return ips;
        }
      } catch {}
    }
    return null; // фолбэк — системный DNS в CONNECT-шимме
  }
}

// ---------- allowlist для CONNECT ----------
const TELEGRAM_HOST_RE = [
  /(^|\.)web\.telegram\.org$/,
  /(^|\.)telegram\.org$/,
  /(^|\.)telegram\.me$/,
  /(^|\.)t\.me$/,
  /(^|\.)telesco\.pe$/,
  /(^|\.)telegra\.ph$/,       // мгновенные статьи из превью
  /(^|\.)cdn\d*\.telesco\.pe$/,
  /^challenges\.cloudflare\.com$/, // Turnstile-капча при логине
  /(^|\.)hcaptcha\.com$/,          // hCaptcha при логине
  /(^|\.)newassets\.hcaptcha\.com$/
];

class Allowlist {
  constructor(config, frontManager) {
    this.config = config;
    this.fronts = frontManager;
    this.blocked = []; // последние заблокированные — для диагностики
  }

  allows(host) {
    const h = String(host || '').toLowerCase().replace(/\.+$/, '');
    if (!h) return false;
    if (TELEGRAM_HOST_RE.some((re) => re.test(h))) return true;
    const { domains } = this.fronts.baseList();
    // kws2.pclead.co.uk — субдомен фронта pclead.co.uk
    if (domains.some((d) => h === d || h.endsWith('.' + d))) return true;
    if (Array.isArray(this.config.workerDomains)
      && this.config.workerDomains.some((d) => h === d || h.endsWith('.' + d))) return true;
    const extra = (this.config.security && this.config.security.allowHosts) || [];
    if (extra.some((p) => h === p || h.endsWith('.' + String(p).toLowerCase()))) return true;
    this.blocked.unshift({ host: h, at: Date.now() });
    if (this.blocked.length > 20) this.blocked.pop();
    return false;
  }
}

module.exports = {
  APP_NAME, DEFAULT_FRONTS, DEFAULT_CONFIG, FRONT_LIST_URL,
  migrateProfile, setupProfile, loadState, saveState,
  FrontManager, DohResolver, Allowlist
};
