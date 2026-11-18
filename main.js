'use strict';
/*
 * Fortochka — Telegram Web K (webk) в Electron-обёртке.
 * «Форточка»: основное окно провайдер заколачивает наглухо, а воздух идёт сюда.
 *
 * Сеть: session proxy Chromium = HTTP CONNECT 127.0.0.1:1081 (этот процесс).
 * Шимм — чистый TCP-релей: wss://kwsN.<фронт>/apiws, TLS end-to-end с Telegram.
 * DNS — через DNS-over-HTTPS с фолбэком на системный; хосты — по allowlist.
 * Список фронтов — живой: репо проекта > кэш > вшитый дефолт, порядок
 * определяется health-check'ом (WS-upgrade до /apiws, как делает webk).
 *
 * UI: статика webk из ./webapp раздаётся этим же HTTP-сервером на
 * http://127.0.0.1:1081 — localhost является secure context, поэтому
 * service worker webk работает (на кастомных tgweb:// схемах Chromium SW не даёт).
 */
const { app, BrowserWindow, Tray, Menu, session, nativeImage, Notification, powerSaveBlocker, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const netcore = require('./netcore');
const { serveStaticFile } = require('./staticserve');
const { RELEASES_URL, getLatestVersion, compareVersions } = require('./updatecheck');
const { routeLink, classifyLink } = require('./external-links');
const DIAG_PAGE = require('./diagpage');

const IS_SMOKE_OFFLINE = process.argv.includes('--smoke-offline');
const IS_SMOKE = process.argv.includes('--smoke') || IS_SMOKE_OFFLINE;
const IS_DIRECT = process.argv.includes('--direct'); // без прокси-цепочки, wss напрямую (для отладки)
const IS_HIDDEN = process.argv.includes('--hidden'); // автостарт свёрнутым
const IS_DEBUG = !!process.env.FORTOCHKA_DEBUG;      // подробные логи страницы: CSP-блоки, ошибки загрузки
const trace = (...a) => { if (IS_SMOKE) console.log('[trace]', ...a); };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const APP_DIR = __dirname;
const WEBAPP_DIR = path.join(APP_DIR, 'webapp');
const IS_MAC = process.platform === 'darwin';
// движок вендорится по платформам: win — tg-ws-proxy.exe, mac — universal-бинарь
const TGWS_EXE = path.join(APP_DIR, 'vendor', IS_MAC ? 'tg-ws-proxy-macos' : 'tg-ws-proxy.exe');

// ---------- профиль: миграция старого, фиксация пути, один экземпляр ----------
// Профиль общий и в dev, и в установленном виде — сессия переживает переезд.
// Папка переименована при выходе 0.2.0: tgweb-desktop -> fortocha (rename целиком).
// FORTOCHKA_USER_DATA — отдельный профиль для тестов (смоук параллельно
// с работающим приложением: свой лок и свои порты в config.json).
const USER_DATA = process.env.FORTOCHKA_USER_DATA
  || netcore.migrateProfile(app.getPath('appData'));
app.setPath('userData', USER_DATA);

// Один экземпляр: повторный клик по ярлыку не поднимает вторую копию
// (порты), а просто разворачивает окно первого из трея. Лок привязан к
// userData, поэтому строго после setPath.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.exit(0);
}

// ---------- конфиг и сетевое ядро ----------
const { config, configFile, stateFile } = netcore.setupProfile(USER_DATA);
const state = netcore.loadState(stateFile);
let WEB_PORT = config.ports.web;     // локальный HTTP+CONNECT (статика webk + шимм)
let SOCKS_PORT = config.ports.socks; // tg-ws-proxy-rs SOCKS
let MTPROTO_PORT = (config.ports && config.ports.mtproto) || 1443;

// Если рядом уже запущен отдельный TG WS Proxy, не уходим в бесконечный
// цикл перезапусков с EADDRINUSE: выбираем свободный локальный порт.
function isLocalPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    probe.once('error', () => finish(false));
    probe.once('listening', () => {
      probe.close(() => finish(true));
    });
    try {
      probe.listen(port, '127.0.0.1');
    } catch {
      finish(false);
    }
  });
}

async function choosePort(preferred, excluded = []) {
  const candidates = [];
  for (let offset = 0; offset <= 32; offset++) {
    const candidate = preferred + offset;
    if (candidate > 0 && candidate < 65536 && !excluded.includes(candidate)) {
      candidates.push(candidate);
    }
  }
  for (const candidate of candidates) {
    if (await isLocalPortFree(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Не найден свободный порт рядом с ${preferred}`);
}

async function chooseServicePorts() {
  const requested = [
    ['web', Number(config.ports && config.ports.web) || 1081],
    ['socks', Number(config.ports && config.ports.socks) || 1080],
    ['mtproto', Number(config.ports && config.ports.mtproto) || 1443]
  ];
  const selected = [];
  for (const [name, preferred] of requested) {
    const port = await choosePort(preferred, selected);
    if (port !== preferred) log(`[ports] ${name}: ${preferred} занят, использую ${port}`);
    selected.push(port);
  }
  [WEB_PORT, SOCKS_PORT, MTPROTO_PORT] = selected;
}

const doh = new netcore.DohResolver(config, log);
const frontManager = new netcore.FrontManager(config, stateFile, log, doh);
const allowlist = new netcore.Allowlist(config, frontManager);
if (IS_SMOKE_OFFLINE) {
  // Deterministic CI smoke: no dependence on public DNS, frontend availability
  // or geographic routing. Live connectivity still has a separate smoke mode.
  frontManager.probesDone = true;
} else {
  frontManager.start();
  frontManager.startPeriodicProbes();
}

// ---------- сброс кэша Chromium при смене схемы ----------
// Хешированные бандлы webk отдаются immutable на год; session.clearCache()
// не гарантирует чистку дискового HTTP-кэша, Code Cache и кэшей service
// worker — старый бандл может пересиживать обновления (так умер фикс медиа
// у уже установленных пользователей). Гарантия — снос кэш-папок ДО старта
// сетевого стека, пока этот процесс ещё не открыл их. Сессия в другом
// хранилище — не трогается. Увеличивай CACHE_SCHEMA при изменении набора.
const CACHE_SCHEMA = 3;
if (state.cacheSchema !== CACHE_SCHEMA) {
  for (const d of ['Cache', 'Code Cache', 'Service Worker', 'GPUCache',
    'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache']) {
    try { fs.rmSync(path.join(USER_DATA, d), { recursive: true, force: true }); } catch {}
  }
  state.cacheSchema = CACHE_SCHEMA;
  netcore.saveState(stateFile, state);
  log('[cache] кэш Chromium сброшен (schema ' + CACHE_SCHEMA + ')');
}

// ---------- IP контроллеров (для проверки tg-ws-proxy в smoke) ----------
// ВАЖНО: веб-эндпоинты wss (*.web.telegram.org) живут на ДРУГИХ IP
// (например kws2 -> 149.154.167.99), поэтому CONNECT-шимм НЕ мапит домены
// на эти адреса, а отдаёт имя хоста DNS. Эта таблица — только raw-MTProto DC.
const DC_IPS = {
  1: '149.154.175.50',
  2: '149.154.167.50',
  3: '149.154.175.100',
  4: '149.154.167.91',
  5: '149.154.171.5'
};

// ---------- лог tgws ----------
let tgwsLogFd = null;
function tgwsLogPath() { return path.join(USER_DATA, 'tgws.log'); }
function openTgwsLog() {
  if (tgwsLogFd !== null) return tgwsLogFd;
  tgwsLogFd = fs.openSync(tgwsLogPath(), 'a');
  fs.writeSync(tgwsLogFd, `\n===== запуск ${new Date().toISOString()} =====\n`);
  return tgwsLogFd;
}

function logRuntimeError(kind, error) {
  const detail = error && (error.stack || error.message) || String(error);
  log(`[${kind}] ${detail}`);
  try { fs.writeFileSync(path.join(USER_DATA, 'runtime-errors.log'), `${new Date().toISOString()} [${kind}] ${detail}\n`, { flag: 'a' }); } catch {}
}

process.on('uncaughtException', (error) => logRuntimeError('uncaught', error));
process.on('unhandledRejection', (reason) => logRuntimeError('unhandled-rejection', reason));

// ---------- tg-ws-proxy-rs как child process ----------
let tgwsProc = null;
let tgwsRunning = false;
let tgwsFailures = 0;
let tgwsRestarting = false;
let quitting = false;

// общий перезапуск для 'exit' и 'error': флаг не даёт удвоить таймер,
// если придут оба события
function scheduleTgwsRestart(fd, why) {
  if (quitting || tgwsRestarting) return;
  tgwsRestarting = true;
  tgwsFailures = Math.min(tgwsFailures + 1, 6);
  const delay = Math.min(2000 * Math.pow(2, tgwsFailures - 1), 30000);
  try { fs.writeSync(fd, `[supervisor] ${why}, перезапуск через ${delay}мс\n`); } catch {}
  setTimeout(() => { tgwsRestarting = false; startTgws(); }, delay);
}

function startTgws() {
  if (quitting || !fs.existsSync(TGWS_EXE)) return;
  const fd = openTgwsLog();
  // MTProto-порт тоже конфигурируется: два экземпляра на одной машине
  // (например смоук рядом с работающим приложением) не должны драться за 1443
  const args = ['--host', '127.0.0.1', '--port', String(MTPROTO_PORT),
    '--socks-enabled', '--socks-port', String(SOCKS_PORT), '--default-domains'];
  if (Array.isArray(config.workerDomains) && config.workerDomains.length) {
    for (const d of config.workerDomains) args.push('--cf-worker-domain', d); // свой CF Worker
  }
  if (!IS_DIRECT) args.push('--no-outbound-proxy'); // не подхватывать случайные HTTP(S)_PROXY
  tgwsProc = spawn(TGWS_EXE, args, { windowsHide: true, stdio: ['ignore', fd, fd] });
  tgwsProc.on('exit', (code) => { tgwsRunning = false; scheduleTgwsRestart(fd, 'процесс вышел (code=' + code + ')'); });
  // без обработчика 'error' неудачный спавн (нет прав/файла) крешит main
  // молча — окно вообще не откроется. Лог + перезапуск по бэкоффу.
  tgwsProc.on('error', (e) => { tgwsRunning = false; scheduleTgwsRestart(fd, 'spawn error: ' + (e && e.message || e)); });
  tgwsProc.on('spawn', () => {
    tgwsRunning = true;
    const proc = tgwsProc;
    const t = setTimeout(() => {
      if (tgwsRunning && tgwsProc === proc) tgwsFailures = 0;
    }, 60000);
    t.unref();
  });
}

// ---------- SOCKS5-клиент (до tg-ws-proxy) ----------
function socksConnect(ipStr, port, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port: SOCKS_PORT });
    const ip = ipStr.split('.').map(Number);
    let stage = 0, settled = false, buffer = Buffer.alloc(0);
    const fail = (message) => {
      if (settled) return;
      settled = true;
      s.destroy();
      reject(new Error(message));
    };
    if (ip.length !== 4 || ip.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      fail('invalid SOCKS destination IPv4');
      return;
    }
    s.setTimeout(timeoutMs, () => fail('socks timeout'));
    s.on('error', (e) => fail('socks: ' + e.message));
    s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
    const onData = (data) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, data]);
      if (stage === 0) {
        if (buffer.length < 2) return;
        if (buffer[0] !== 5 || buffer[1] !== 0) return fail('socks greeting: ' + buffer.toString('hex'));
        buffer = buffer.subarray(2);
        stage = 1;
        s.write(Buffer.from([5, 1, 0, 1, ...ip, port >> 8, port & 255]));
      }
      if (stage === 1 && buffer.length >= 4) {
        if (buffer[0] !== 5 || buffer[2] !== 0) return fail('invalid SOCKS reply');
        const atyp = buffer[3];
        if (atyp !== 1 && atyp !== 3 && atyp !== 4) return fail('invalid SOCKS address type');
        if (atyp === 3 && buffer.length < 5) return;
        const addressSize = atyp === 1 ? 4 : atyp === 4 ? 16 : 1 + buffer[4];
        const replySize = 4 + addressSize + 2;
        if (buffer.length < replySize) return;
        if (buffer[1] !== 0) return fail('socks reply code=' + buffer[1]);
        settled = true;
        s.removeListener('data', onData);
        s.setTimeout(0);
        if (buffer.length > replySize) s.unshift(buffer.subarray(replySize));
        resolve(s);
      }
    };
    s.on('data', onData);
  });
}

function socksProbe(ipStr, port) {
  return socksConnect(ipStr, port).then((s) => { s.destroy(); return { ok: true, info: 'bridge до DC установлен' }; })
    .catch((e) => ({ ok: false, info: String(e.message || e) }));
}

// ---------- локальный HTTP-сервер: статика webk + CONNECT-шимм + API ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.map': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.txt': 'text/plain', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json',
  '.tgs': 'application/json'
};
const contentType = (file) => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

// Строгий CSP для статики webk: страница стучится только к себе и в wss
// (хосты wss дополнительно режет allowlist CONNECT-шимма). Инлайн-скриптов в
// webk нет, wasm грузится с 'wasm-unsafe-eval', web-app ботов — в iframe https.
const CSP = [
  "default-src 'self'",
  "script-src 'self' blob: 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://t.me",
  "media-src 'self' blob: data: mediastream:",
  "font-src 'self' data:",
  "connect-src 'self' wss: blob: data:",
  "worker-src 'self' blob:",
  "frame-src 'self' blob: https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'"
].join('; ');

function cacheControlFor(file) {
  const base = path.basename(file);
  if (base === 'index.html' || base.startsWith('sw-')) return 'no-cache';
  // хешированные имена webk (index-DA76RcCe.js) — кэш навсегда
  if (/-[A-Za-z0-9_-]{8}\.\w+$/.test(base)) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}

function serveStatic(req, res) {
  return serveStaticFile(req, res, {
    root: WEBAPP_DIR,
    headersFor: (file) => {
      const headers = {
        'content-type': contentType(file),
        'cache-control': cacheControlFor(file)
      };
      if (!process.env.FORTOCHKA_NO_CSP) headers['content-security-policy'] = CSP;
      return headers;
    }
  });
}

function pipe(a, b) {
  a.pipe(b); b.pipe(a);
  const close = () => { try { a.destroy(); } catch {} try { b.destroy(); } catch {} };
  a.on('error', close); b.on('error', close);
  a.on('close', close); b.on('close', close);
}

// CONNECT-шимм: allowlist (только Telegram и фронты) + DoH-резолв (системный
// DNS провайдера может травить и telegram-домены, и домены фронтов).
function onConnect(req, clientSocket, head) {
  const [host, portStr] = req.url.split(':');
  const port = +portStr || 443;
  clientSocket.on('error', () => {});
  // A failed or cancelled Chromium connection must not leave an orphaned
  // upstream socket after an asynchronous DNS lookup.
  clientSocket.setTimeout(15000, () => clientSocket.destroy());
  if (port !== 443 || !allowlist.allows(host)) {
    log('[connect] заблокирован allowlist-ом: ' + host);
    clientSocket.destroy();
    return;
  }
  (async () => {
    const ips = await doh.lookup(host).catch((e) => {
      log('[doh] ошибка ' + host + ': ' + e.message);
      return null;
    });
    if (clientSocket.destroyed) return;
    const target = ips && ips.length ? ips[Math.floor(Math.random() * ips.length)] : host;
    log('[connect] ' + host + ' -> ' + target + (ips ? ' (DoH)' : ' (system)'));
    const upstream = net.connect(port, target);
    upstream.setTimeout(15000, () => upstream.destroy());
    upstream.on('connect', () => {
      if (clientSocket.destroyed) { upstream.destroy(); return; }
      log('[connect] ' + host + ' -> установлен');
      clientSocket.setTimeout(0);
      upstream.setTimeout(0);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      pipe(clientSocket, upstream);
    });
    upstream.on('error', (e) => {
      log('[connect] ' + host + ' upstream error: ' + e.message);
      clientSocket.destroy();
    });
    clientSocket.once('close', () => upstream.destroy());
  })().catch((e) => {
    log('[connect] ' + host + ' internal error: ' + (e.message || e));
    clientSocket.destroy();
  });
}

// ---------- /fortochka/* — маршруты для webk и страницы диагностики ----------
const apiToken = crypto.randomBytes(12).toString('hex');
let diagWin = null;

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function memorySnapshot() {
  // Electron process metrics are reported in KiB; excludes the Rust tg-ws-proxy child.
  const processes = app.getAppMetrics();
  const sum = (key) => processes.reduce((total, proc) => total +
    (Number.isFinite(proc.memory && proc.memory[key]) ? proc.memory[key] : 0), 0);
  const toMiB = (kib) => Math.round(kib / 1024);
  const hasPrivate = processes.some((proc) => Number.isFinite(proc.memory && proc.memory.privateBytes));
  return {
    processes: processes.length,
    workingSetMB: toMiB(sum('workingSetSize')),
    privateMB: hasPrivate ? toMiB(sum('privateBytes')) : null,
    mainHeapMB: Math.round(process.memoryUsage().heapUsed / (1024 * 1024))
  };
}

function updaterStatusText() {
  return updateStatusText || 'ещё не проверялись';
}

// подсказка «что делать с найденным обновлением» — зависит от платформы
const updateHint = () => ' — скачайте установщик вручную с GitHub Releases.';

async function handleFortochka(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/fortochka/fronts.js') { frontManager.serveFrontsScript(res); return true; }
  if (p === '/fortochka/diag') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(DIAG_PAGE.replace('__TOKEN__', apiToken));
    return true;
  }
  if (p.startsWith('/fortochka/api/')) {
    if (req.headers['x-fortochka-token'] !== apiToken) { sendJson(res, 403, { error: 'bad token' }); return true; }
    const ep = p.slice('/fortochka/api/'.length);
    if (ep === 'status') {
      sendJson(res, 200, {
        version: app.getVersion(),
        fronts: frontManager.diag(),
        tgws: { running: tgwsRunning, pid: tgwsProc && tgwsProc.pid },
        doh: !(config.doh && config.doh.enabled === false),
        profile: USER_DATA,
        log: tgwsLogPath(),
        updater: updaterStatusText(),
        memory: memorySnapshot(),
        blocked: allowlist.blocked.map((b) => b.host)
      });
    } else if (ep === 'probe' && req.method === 'POST') {
      sendJson(res, 200, { fronts: frontManager.diag(), health: await frontManager.probeAll() });
    } else if (ep === 'upcheck' && req.method === 'POST') {
      try {
        const result = await checkForUpdates(false);
        sendJson(res, 200, {
          message: result.available
            ? 'Доступна версия ' + result.version + updateHint()
            : 'У вас актуальная версия (' + app.getVersion() + ').',
          latest: result.version,
          source: result.source,
          url: RELEASES_URL
        });
      } catch (e) {
        sendJson(res, 200, {
          message: 'Не удалось проверить обновления: ' + (e.message || e),
          url: RELEASES_URL
        });
      }
    } else if (ep === 'openreleases' && req.method === 'POST') {
      shell.openExternal(RELEASES_URL).catch((e) => log('[updates] browser: ' + e.message));
      sendJson(res, 200, {});
    } else if (ep === 'openlog' && req.method === 'POST') {
      shell.showItemInFolder(tgwsLogPath()); sendJson(res, 200, {});
    } else if (ep === 'openprofile' && req.method === 'POST') {
      shell.openPath(USER_DATA); sendJson(res, 200, {});
    } else if (ep === 'exec' && req.method === 'POST' && IS_DEBUG) {
      // только для отладки (FORTOCHKA_DEBUG=1): выполнить JS в контексте страницы
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 65536) req.destroy(); });
      req.on('end', () => {
        if (!win || win.isDestroyed()) { sendJson(res, 200, { ok: false, error: 'no window' }); return; }
        win.webContents.executeJavaScript(body, true)
          .then((r) => sendJson(res, 200, { ok: true, result: r === undefined ? null : r }))
          .catch((e) => sendJson(res, 200, { ok: false, error: String(e && e.message || e) }));
      });
    } else {
      sendJson(res, 404, { error: 'unknown endpoint' });
    }
    return true;
  }
  return false;
}

function openDiagWindow() {
  if (diagWin) { diagWin.show(); diagWin.focus(); return; }
  diagWin = new BrowserWindow({
    width: 880, height: 660, title: 'Fortochka — диагностика',
    backgroundColor: '#17212b', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  diagWin.on('closed', () => { diagWin = null; });
  diagWin.loadURL(`http://127.0.0.1:${WEB_PORT}/fortochka/diag`);
}

function startWebServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      Promise.resolve(handleFortochka(req, res))
        .then((handled) => { if (!handled) return serveStatic(req, res); })
        .catch(() => { try { res.writeHead(500).end(); } catch {} });
    });
    server.on('connect', onConnect);
    server.once('error', (e) => {
      log('[web-server] не смог подняться на ' + WEB_PORT + ': ' + e.message);
      reject(e);
    });
    server.listen(WEB_PORT, '127.0.0.1', () => resolve(server));
  });
}

// ---------- разрешения// ---------- разрешения (уведомления, камера/микрофон для звонков) ----------
const ALLOWED = new Set(['media', 'audioCapture', 'videoCapture', 'notifications',
  'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'display-capture', 'pointerLock']);

async function configureSession() {
  const ses = session.defaultSession;
  const ownOrigin = 'http://127.0.0.1:' + WEB_PORT;
  const local = (value) => {
    try { return new URL(value).origin === ownOrigin; } catch { return false; }
  };
  const ownedWindow = (wc) => !!wc && (
    (win && !win.isDestroyed() && wc.id === win.webContents.id) ||
    (diagWin && !diagWin.isDestroyed() && wc.id === diagWin.webContents.id)
  );
  ses.setPermissionRequestHandler((wc, permission, cb, details = {}) => {
    cb(ownedWindow(wc) && ALLOWED.has(permission) && local(details.securityOrigin || details.requestingUrl));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details = {}) => {
    return ownedWindow(wc) && ALLOWED.has(permission) && local(details.securityOrigin || requestingOrigin);
  });
  if (!IS_DIRECT) {
    await ses.setProxy({ proxyRules: 'http://127.0.0.1:' + WEB_PORT, proxyBypassRules: '<local>' });
  }
}

// ---------- окно и трей ----------
let win = null;
let tray = null;

function trayIcon() {
  for (const p of ['assets/img/favicon-16x16.png', 'assets/img/favicon-32x32.png', 'favicon.png']) {
    const f = path.join(WEBAPP_DIR, p);
    if (fs.existsSync(f)) {
      const img = nativeImage.createFromPath(f).resize({ width: 16, height: 16 });
      if (!img.isEmpty()) return img;
    }
  }
  return nativeImage.createEmpty();
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------- бейдж непрочитанных (таскбар + трей) ----------
let unread = 0;
let badgeTimer = null;

function parseUnreadFromTitle(title) {
  const m = /^\((\d{1,4}\+?)\)\s/.exec(title || '');
  return m ? m[1] : '';
}

function applyBadge(countStr) {
  const n = parseInt(countStr, 10) || 0;
  unread = n;
  // macOS: нативный бейдж на иконке в доке (setOverlayIcon — только Windows)
  if (IS_MAC) {
    if (app.dock) app.dock.setBadge(n ? String(n) : '');
    return;
  }
  if (!n) {
    if (win) win.setOverlayIcon(null, '');
    if (tray) tray.setImage(trayIcon());
    return;
  }
  // рисуем оверлей в рендерере (canvas доступен там), в main забираем PNG
  win.webContents.executeJavaScript(`(async (n) => {
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const ctx = c.getContext('2d');
    const img = new Image();
    const loaded = new Promise((res) => { img.onload = res; img.onerror = res; });
    img.src = '/assets/img/favicon-32x32.png'; await loaded;
    try { ctx.drawImage(img, 0, 0, 32, 32); } catch {}
    ctx.fillStyle = '#e53935';
    ctx.beginPath(); ctx.arc(24, 24, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 11px system-ui';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(n > 99 ? '+' : String(n), 24, 24.5);
    return c.toDataURL('image/png');
  })(${n})`, true).then((dataUrl) => {
    if (!dataUrl || dataUrl.length < 100) return;
    const img = nativeImage.createFromDataURL(dataUrl);
    if (win) win.setOverlayIcon(img, n + ' непрочитанных');
    if (tray) tray.setImage(img.resize({ width: 16, height: 16 }));
  }).catch(() => {});
}

// ---------- автостарт свёрнутым + запоминание окна ----------
function saveWindowBounds() {
  if (!win || win.isDestroyed() || !config.window.rememberBounds) return;
  state.window = state.window || {};
  state.window.bounds = win.getNormalBounds();
  netcore.saveState(stateFile, state);
}

// ---------- powerSaveBlocker: экран не гаснет, пока играет медиа/звонок ----------
let psbId = null;
let mediaPlaying = 0;
function mediaDelta(delta) {
  mediaPlaying = Math.max(0, mediaPlaying + delta);
  if (mediaPlaying > 0 && psbId === null) psbId = powerSaveBlocker.start('prevent-display-sleep');
  if (mediaPlaying === 0 && psbId !== null) { powerSaveBlocker.stop(psbId); psbId = null; }
}

function createWindow() {
  const savedBounds = (config.window.rememberBounds && state.window && state.window.bounds) || {};
  win = new BrowserWindow({
    width: savedBounds.width || 1280,
    height: savedBounds.height || 860,
    x: savedBounds.x, y: savedBounds.y,
    minWidth: 420, minHeight: 480,
    backgroundColor: '#212121',
    autoHideMenuBar: true,
    show: !IS_SMOKE && !(IS_HIDDEN || config.window.startMinimized),
    // mac: нативные traffic lights в шапке webk (см. CSS-инъекцию ниже)
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 17 } } : {}),
    icon: trayIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  const localOrigin = 'http://127.0.0.1:' + WEB_PORT;
  const openOutside = (url) => routeLink(url, localOrigin, {
    openExternal: (href) => shell.openExternal(href),
    openTelegram: (href) => handleTgLink(href)
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (classifyLink(url, localOrigin) === 'internal') return;
    event.preventDefault();
    openOutside(url);
  });

  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });

  win.on('close', (e) => {
    saveWindowBounds();
    if (!quitting && !IS_SMOKE) {
      e.preventDefault();
      win.hide();
    }
  });
  // запоминание размера/позиции — с дебаунсом, чтобы не писать на каждый пиксель
  let boundsTimer = null;
  const rememberLater = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(saveWindowBounds, 800);
  };
  win.on('resize', rememberLater);
  win.on('move', rememberLater);

  win.webContents.on('page-title-updated', (e, title) => {
    const countStr = parseUnreadFromTitle(title);
    if (countStr === String(unread) || (!countStr && unread === 0)) return;
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => applyBadge(countStr), 300);
  });

  win.webContents.on('media-started-playing', () => mediaDelta(1));
  win.webContents.on('media-paused', () => mediaDelta(-1));

  win.webContents.on('did-finish-load', () => {
    trace('did-finish-load');
    if (IS_DEBUG) {
      // ловим в рендерере то, что иначе тонет: CSP-блоки и незагрузившиеся ресурсы
      win.webContents.executeJavaScript(`(() => {
        document.addEventListener('securitypolicyviolation', (e) =>
          console.warn('[CSP-BLOCK]', e.violatedDirective, e.blockedURI));
        document.addEventListener('error', (e) => {
          const t = e.target;
          if (t && t.tagName && (t.src || t.href))
            console.warn('[LOAD-FAIL]', t.tagName, String(t.src || t.href).slice(0, 140));
        }, true);
      })()`, true).catch(() => {});
    }
    if (IS_MAC) {
      // traffic lights живут поверх шапки webk: сдвигаем её контент правее,
      // а саму шапку делаем областью перетаскивания окна (кнопки/поиск — нет)
      win.webContents.insertCSS(`
        .sidebar-header { padding-left: 76px !important; -webkit-app-region: drag; }
        .sidebar-header button, .sidebar-header input, .sidebar-header a,
        .sidebar-header .btn-menu, .sidebar-header .btn-icon,
        .sidebar-header [class*="search"] { -webkit-app-region: no-drag; }
      `).catch(() => {});
    }
    if (pendingTgLink) {
      const url = pendingTgLink; pendingTgLink = null;
      handleTgLink(url);
    }
    if (IS_SMOKE) runSmokeChecks();
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    trace('did-fail-load', code, desc, url);
  });
  // в smoke/debug — консоль рендерера: webk логирует туда MTProto-ошибки
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    if (IS_SMOKE || IS_DEBUG) console.log('[console]', String(message).slice(0, 200));
  });

  win.loadURL(`http://127.0.0.1:${WEB_PORT}/`);

  if (IS_DEBUG) {
    // CDP-глазами: все внешние запросы страницы/воркеров и их провалы —
    // то, что не видно ни в консоли, ни в логе шимма
    try {
      win.webContents.debugger.attach('1.3');
      win.webContents.debugger.sendCommand('Network.enable').catch(() => {});
      win.webContents.debugger.on('message', (e, method, params) => {
        const u = (params.request || params.response || params || {}).url;
        const short = String(u || '').slice(0, 150);
        if (method === 'Network.requestWillBeSent' && !u.startsWith(`http://127.0.0.1:${WEB_PORT}/`)) {
          console.log('[net]', params.type, short);
        } else if (method === 'Network.webSocketCreated') {
          console.log('[ws-open]', short);
        } else if (method === 'Network.webSocketHandshakeResponseReceived') {
          console.log('[ws-resp]', params.response.status, short);
        } else if (method === 'Network.loadingFailed') {
          console.log('[net-FAIL]', params.errorText, params.type, params.canceled ? '(canceled)' : '');
        } else if (method === 'Network.responseReceived' && params.response.status >= 400) {
          console.log('[net-' + params.response.status + ']', short);
        }
      });
      // счётчик битых <img> через 15с после загрузки
      setTimeout(() => {
        win.webContents.executeJavaScript(`(() => {
          const imgs = [...document.querySelectorAll('img')];
          const broken = imgs.filter((i) => i.complete && i.naturalWidth === 0);
          return { total: imgs.length, broken: broken.length,
            sample: broken.slice(0, 5).map((i) => String(i.src).slice(0, 90)) };
        })()`, true).then((r) => console.log('[imgs]', JSON.stringify(r))).catch(() => {});
      }, 15000);
    } catch (e) { log('[debug] debugger: ' + e.message); }
  }
}

// mac: настоящее меню-бар (Cmd+C/V/X работают в webk через роли editMenu,
// Cmd+Q — выход). На Windows ничего не меняем — там меню автоскрытое.
function setupMacMenu() {
  if (!IS_MAC || IS_SMOKE) return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide', label: 'Скрыть Fortochka' },
      { role: 'hideOthers', label: 'Скрыть остальные' },
      { role: 'unhide', label: 'Показать все' },
      { type: 'separator' },
      { label: 'Завершить Fortochka', accelerator: 'Command+Q',
        click: () => { quitting = true; app.quit(); } }
    ]},
    { role: 'editMenu' },
    { role: 'windowMenu' }
  ]));
}

function createTray() {
  if (IS_SMOKE) return;
  tray = new Tray(trayIcon());
  tray.setToolTip('Fortochka — Telegram Web');
  const menu = [
    { label: 'Открыть', click: showWindow },
    { label: 'Диагностика', click: openDiagWindow },
    { label: 'Проверить обновления', click: () => manualUpdateCheck() },
    { label: 'Открыть страницу релизов', click: () => shell.openExternal(RELEASES_URL).catch(() => {}) },
    { label: 'Автозапуск', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (mi) => app.setLoginItemSettings({
        openAtLogin: mi.checked, path: process.execPath,
        args: app.isPackaged ? ['--hidden'] : [] // автостарт — сразу в трей
      }) },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(menu));
  tray.on('click', showWindow);
}

// ---------- tg:// протокол ----------
// Инсталлятор прописывает схему (build.protocols в package.json); portable
// регистрирует сам. Ссылка попадает в webk через #?tgaddr=... — webk сам
// умеет открывать такие хеши (appImManager: params.tgaddr -> openUrl).
let pendingTgLink = null;

function handleTgLink(url) {
  if (!/^tg:/i.test(url) || !win || win.webContents.isLoading()) {
    if (/^tg:/i.test(url)) pendingTgLink = url;
    return;
  }
  showWindow();
  win.webContents.executeJavaScript(
    `location.hash = '#?tgaddr=' + encodeURIComponent(${JSON.stringify(url)})`
  ).catch(() => {});
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleTgLink(url);
});

function registerProtocol() {
  if (!app.isPackaged) return; // в dev схему не трогаем
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    // portable-сборка мимо инсталлятора — регистрируем на ходу
    app.setAsDefaultProtocolClient('tg');
  }
}

// ---------- проверка наличия обновлений (без загрузки исполняемых файлов) ----------
let updateStatusText = '';
let updateCheckPending = null;
let lastNotifiedVersion = '';

async function checkForUpdates(notify = false) {
  if (updateCheckPending) return updateCheckPending;
  updateStatusText = 'проверяется...';
  updateCheckPending = (async () => {
    // GitHub Releases API не требует latest.yml. При недоступности API используем CDN.
    const { version, source } = await getLatestVersion();
    const available = compareVersions(version, app.getVersion()) > 0;
    updateStatusText = available
      ? 'доступно ' + version + ' — установка вручную'
      : 'актуальная версия (' + app.getVersion() + ')';
    if (notify && available && version !== lastNotifiedVersion && Notification.isSupported()) {
      lastNotifiedVersion = version;
      const notice = new Notification({
        title: 'Fortochka',
        body: 'Доступна версия ' + version + '. Откройте релизы для ручного обновления.'
      });
      notice.on('click', () => shell.openExternal(RELEASES_URL).catch(() => {}));
      notice.show();
    }
    return { version, source, available };
  })().catch((e) => {
    updateStatusText = 'ошибка проверки: ' + (e.message || e);
    throw e;
  }).finally(() => { updateCheckPending = null; });
  return updateCheckPending;
}

function setupUpdater() {
  if (!app.isPackaged || IS_SMOKE) return;
  // Проверка доступна в том числе portable-версии; автоустановка отключена.
  setTimeout(() => checkForUpdates(true).catch(() => {}), 30000).unref();
  setInterval(() => checkForUpdates(true).catch(() => {}), 6 * 3600 * 1000).unref();
}

function manualUpdateCheck() {
  checkForUpdates(false).then((r) => {
    const message = r.available
      ? 'Доступна версия ' + r.version + updateHint()
      : 'У вас актуальная версия (' + app.getVersion() + ').';
    if (Notification.isSupported()) new Notification({ title: 'Fortochka', body: message }).show();
    else openDiagWindow();
  }).catch((e) => {
    log('[updates] ' + (e.message || e));
    openDiagWindow();
  });
}

// ---------- smoke-тест ----------
let smokeStarted = false;
let smokeDone = false;
async function runSmokeChecks() {
  if (!IS_SMOKE || smokeStarted) return;
  smokeStarted = true;
  const out = { webapp: null, sw: null, fronts: null, wss: null, socks: null };
  try {
    out.webapp = await win.webContents.executeJavaScript(
      `({ title: document.title, hasPageChats: !!document.querySelector('#page-chats') })`, true);
  } catch (e) {
    out.webapp = { error: String(e) };
  }
  await new Promise(r => setTimeout(r, 3000)); // даём webk подняться
  try {
    out.sw = await win.webContents.executeJavaScript(
      `navigator.serviceWorker.getRegistrations().then(a => ({ count: a.length, urls: a.map(x => x.active?.scriptURL || 'pending') }))`, true);
  } catch (e) {
    out.sw = { error: String(e) };
  }
  try {
    // /fortochka/fronts.js — то, чем воркер webk кормится
    const body = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: WEB_PORT, path: '/fortochka/fronts.js' }, (r) => {
        let b = ''; r.on('data', (d) => b += d); r.on('end', () => resolve(b));
      }).on('error', reject);
    });
    out.fronts = body.includes('__fortochkaFronts')
      ? { ok: true, count: JSON.parse(body.split('=')[1].split(';')[0]).length }
      : { ok: false, body: body.slice(0, 80) };
  } catch (e) {
    out.fronts = { ok: false, error: String(e) };
  }
  if (!IS_SMOKE_OFFLINE) {
  try {
    // тест wss из контекста страницы — как делает webk (subprotocol 'binary'
    // обязателен: без него apiws отвечает 404). Фронт берём верхний из
    // health-check (прогнали probeAll перед этим).
    await frontManager.probeAll();
    const { domains } = frontManager.rankedList();
    // webk коннектится к kws{dcId}.<домен> — в тесте берём kws2, как и клиент
    const host = domains[0].includes('kws') ? domains[0] : 'kws2.' + domains[0];
    out.wss = await win.webContents.executeJavaScript(`new Promise(res => {
      let done = false;
      const fin = (r) => { if (!done) { done = true; res(r); } };
      try {
        const w = new WebSocket('wss://${host}/apiws', 'binary');
        const t = setTimeout(() => fin('timeout 12s'), 12000);
        w.onopen = () => { clearTimeout(t); w.close(); fin('open'); };
        w.onerror = () => { clearTimeout(t); fin('error'); };
      } catch (e) { fin('exception: ' + e); }
    })`, true);
  } catch (e) {
    out.wss = String(e);
  }
  try {
    out.socks = await socksProbe(DC_IPS[2], 443);
  } catch (e) {
    out.socks = { ok: false, info: String(e) };
  }
  } else {
    out.wss = 'skipped: offline CI';
    out.socks = { ok: true, info: 'skipped: offline CI' };
  }
  out.version = app.getVersion();
  out.tgwsRunning = tgwsRunning;
  const ok = out.webapp && !out.webapp.error && out.webapp.hasPageChats
    && out.sw && out.sw.count > 0
    && out.fronts && out.fronts.ok
    && (IS_SMOKE_OFFLINE || out.wss === 'open') && out.socks && out.socks.ok
    && (!IS_SMOKE_OFFLINE || out.tgwsRunning);
  smokeDone = true;
  console.log(ok ? 'SMOKE_OK ' + JSON.stringify(out) : 'SMOKE_FAIL ' + JSON.stringify(out));
  quitting = true;
  app.exit(ok ? 0 : 1);
}

// ---------- lifecycle ----------
app.on('second-instance', (e, argv) => {
  showWindow();
  const url = argv && argv.find((a) => /^tg:/i.test(a));
  if (url) handleTgLink(url);
});

// mac: клик по иконке в доке возвращает окно (окно закрыто -> спрятано в трей)
app.on('activate', () => { if (!IS_SMOKE) showWindow(); });

app.whenReady().then(async () => {
  try {
    await chooseServicePorts();
    await configureSession();
    trace('session ok');
    await startWebServer();
    trace('web server ok');
    // окно раньше движка: что бы ни случилось со спавном бинарника,
    // окно уже открыто, а движок доедет (webk сам переподключается)
    createWindow();
    trace('window created');
    registerProtocol();
    startTgws();
    trace('tgws spawned');
    setupMacMenu();
    createTray();
    setupUpdater();
    // холодный старт по tg://-ссылке: URL приходит аргументом командной строки
    const coldArg = process.argv.slice(1).find((a) => /^tg:/i.test(a));
    if (coldArg) handleTgLink(coldArg);
  } catch (e) {
    console.error('READY_FAIL', e);
    if (IS_SMOKE) { quitting = true; app.exit(2); }
  }
  if (IS_SMOKE) {
    setTimeout(() => {
      if (!smokeDone) {
        console.log('SMOKE_FAIL {"reason":"timeout: did-finish-load не пришёл за 30с"}');
        quitting = true;
        app.exit(1);
      }
    }, 30000);
  }
});

if (IS_SMOKE) {
  setTimeout(() => {
    if (!smokeDone) {
      console.log('SMOKE_FAIL {"reason":"top-level timeout: app не поднялся за 45с"}');
      app.exit(2);
    }
  }, 45000);
}

app.on('window-all-closed', () => {
  if (IS_SMOKE || quitting) app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  saveWindowBounds();
  frontManager.stop();
  if (tgwsProc) tgwsProc.kill();
});

app.on('quit', () => {
  if (tgwsLogFd !== null) { try { fs.closeSync(tgwsLogFd); } catch {} tgwsLogFd = null; }
});
