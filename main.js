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
const fsp = require('fs/promises');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const netcore = require('./netcore');
const DIAG_PAGE = require('./diagpage');

const IS_SMOKE = process.argv.includes('--smoke');
const IS_DIRECT = process.argv.includes('--direct'); // без прокси-цепочки, wss напрямую (для отладки)
const IS_HIDDEN = process.argv.includes('--hidden'); // автостарт свёрнутым
const trace = (...a) => { if (IS_SMOKE) console.log('[trace]', ...a); };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const APP_DIR = __dirname;
const WEBAPP_DIR = path.join(APP_DIR, 'webapp');
const TGWS_EXE = path.join(APP_DIR, 'vendor', 'tg-ws-proxy.exe');

// ---------- профиль: миграция старого, фиксация пути, один экземпляр ----------
// Профиль общий и в dev, и в установленном виде — сессия переживает переезд.
// Папка переименована при выходе 0.2.0: tgweb-desktop -> fortocha (rename целиком).
const USER_DATA = netcore.migrateProfile(app.getPath('appData'));
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
const WEB_PORT = config.ports.web;   // локальный HTTP+CONNECT (статика webk + шимм)
const SOCKS_PORT = config.ports.socks; // tg-ws-proxy-rs SOCKS

const doh = new netcore.DohResolver(config, log);
const frontManager = new netcore.FrontManager(config, stateFile, log, doh);
const allowlist = new netcore.Allowlist(config, frontManager);
frontManager.start();
frontManager.startPeriodicProbes();

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

// ---------- tg-ws-proxy-rs как child process ----------
let tgwsProc = null;
let tgwsFailures = 0;
let quitting = false;

function startTgws() {
  if (quitting || !fs.existsSync(TGWS_EXE)) return;
  const fd = openTgwsLog();
  const args = ['--host', '127.0.0.1', '--socks-enabled', '--socks-port', String(SOCKS_PORT), '--default-domains'];
  if (Array.isArray(config.workerDomains) && config.workerDomains.length) {
    for (const d of config.workerDomains) args.push('--cf-worker-domain', d); // свой CF Worker
  }
  if (!IS_DIRECT) args.push('--no-outbound-proxy'); // не подхватывать случайные HTTP(S)_PROXY
  tgwsProc = spawn(TGWS_EXE, args, { windowsHide: true, stdio: ['ignore', fd, fd] });
  tgwsProc.on('exit', (code) => {
    if (quitting) return;
    tgwsFailures = Math.min(tgwsFailures + 1, 6);
    const delay = Math.min(2000 * Math.pow(2, tgwsFailures - 1), 30000);
    fs.writeSync(fd, `[supervisor] процесс вышел (code=${code}), перезапуск через ${delay}мс\n`);
    setTimeout(startTgws, delay);
  });
  tgwsProc.on('spawn', () => { tgwsFailures = 0; });
}

// ---------- SOCKS5-клиент (до tg-ws-proxy) ----------
function socksConnect(ipStr, port, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port: SOCKS_PORT });
    let stage = 0;
    const fail = (msg) => { s.destroy(); reject(new Error(msg)); };
    s.setTimeout(timeoutMs, () => fail('socks timeout'));
    s.on('error', (e) => fail('socks: ' + e.message));
    s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
    s.on('data', (d) => {
      if (stage === 0) {
        if (d.length < 2 || d[0] !== 5 || d[1] !== 0) return fail('socks greeting: ' + d.toString('hex'));
        stage = 1;
        const ip = ipStr.split('.').map(Number);
        s.write(Buffer.from([5, 1, 0, 1, ip[0], ip[1], ip[2], ip[3], port >> 8, port & 255]));
      } else {
        if (d.length > 1 && d[1] === 0) { s.setTimeout(0); resolve(s); }
        else fail('socks reply code=' + (d[1] ?? '?'));
      }
    });
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

async function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(WEBAPP_DIR, rel));
  if (!file.startsWith(WEBAPP_DIR)) { res.writeHead(403).end(); return; }
  try {
    const data = await fsp.readFile(file);
    const headers = {
      'content-type': contentType(file),
      'cache-control': cacheControlFor(file)
    };
    if (!process.env.FORTOCHKA_NO_CSP) headers['content-security-policy'] = CSP; // отладка CSP
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
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
  if (!allowlist.allows(host)) {
    log('[connect] заблокирован allowlist-ом: ' + host);
    clientSocket.destroy();
    return;
  }
  // Чистый TCP-релей: TLS end-to-end между Chromium и Telegram. SNI шлёт сам
  // Chromium, поэтому шимму достаточно коннектиться в IP (или в имя — его
  // резолвит ОС). Веб-эндпоинты *.web.telegram.org живут на своих IP,
  // не на raw-MTProto адресах контроллеров. Почему не tgws-SOCKS — в README.
  (async () => {
    const ips = await doh.lookup(host).catch((e) => { log('[doh] ошибка ' + host + ': ' + e.message); return null; });
    const target = ips && ips.length ? ips[Math.floor(Math.random() * ips.length)] : host;
    log('[connect] ' + host + ' -> ' + target + (ips ? ' (DoH)' : ' (system)'));
    const upstream = net.connect(port, target);
    upstream.on('connect', () => {
      log('[connect] ' + host + ' -> установлен');
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      pipe(clientSocket, upstream);
    });
    upstream.on('error', (e) => {
      log('[connect] ' + host + ' upstream error: ' + e.message);
      clientSocket.destroy();
    });
    clientSocket.on('error', () => {});
  })();
}

// ---------- /fortochka/* — маршруты для webk и страницы диагностики ----------
const apiToken = crypto.randomBytes(12).toString('hex');
let diagWin = null;

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function updaterStatusText() {
  if (!autoUpdater) return 'недоступны (dev или portable — обновляйтесь с GitHub)';
  return updateStatusText || 'проверяется...';
}

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
        tgws: { running: !!tgwsProc && !tgwsProc.killed, pid: tgwsProc && tgwsProc.pid },
        doh: !(config.doh && config.doh.enabled === false),
        profile: USER_DATA,
        log: tgwsLogPath(),
        updater: updaterStatusText(),
        blocked: allowlist.blocked.map((b) => b.host)
      });
    } else if (ep === 'probe' && req.method === 'POST') {
      sendJson(res, 200, { fronts: frontManager.diag(), health: await frontManager.probeAll() });
    } else if (ep === 'upcheck' && req.method === 'POST') {
      if (!autoUpdater) { sendJson(res, 200, { message: 'Обновления недоступны в этом режиме — скачайте с GitHub.' }); }
      else {
        updateStatusText = 'проверяется...';
        try {
          const r = await autoUpdater.checkForUpdates();
          const v = r && r.updateInfo && r.updateInfo.version;
          updateStatusText = v && v !== app.getVersion() ? 'доступно ' + v + ' — скачается само' : 'актуальная версия';
          sendJson(res, 200, { message: v && v !== app.getVersion() ? 'Доступна версия ' + v + ' — скачается и установится при выходе.' : 'У вас актуальная версия (' + app.getVersion() + ').', latest: v });
        } catch (e) {
          updateStatusText = 'ошибка проверки';
          sendJson(res, 200, { message: 'Не удалось проверить: ' + (e.message || e) });
        }
      }
    } else if (ep === 'openlog' && req.method === 'POST') {
      shell.showItemInFolder(tgwsLogPath()); sendJson(res, 200, {});
    } else if (ep === 'openprofile' && req.method === 'POST') {
      shell.openPath(USER_DATA); sendJson(res, 200, {});
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
  const server = http.createServer((req, res) => {
    Promise.resolve(handleFortochka(req, res))
      .then((handled) => { if (!handled) return serveStatic(req, res); })
      .catch(() => { try { res.writeHead(500).end(); } catch {} });
  });
  server.on('connect', onConnect);
  server.listen(WEB_PORT, '127.0.0.1');
  // без обработчика EADDRINUSE Electron показывает красный диалог — гасим тихо
  server.on('error', (e) => {
    log('[web-server] не смог подняться на ' + WEB_PORT + ': ' + e.message);
  });
  return server;
}

// ---------- разрешения (уведомления, камера/микрофон для звонков) ----------
const ALLOWED = new Set(['media', 'audioCapture', 'videoCapture', 'notifications',
  'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'display-capture', 'pointerLock']);

function configureSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(ALLOWED.has(permission)));
  ses.setPermissionCheckHandler((wc, permission) => ALLOWED.has(permission));
  if (!IS_DIRECT) {
    // весь внешний трафик (включая wss) — через наш CONNECT-шимм
    ses.setProxy({ proxyRules: `http://127.0.0.1:${WEB_PORT}`, proxyBypassRules: '<local>' });
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
    icon: trayIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
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
    if (pendingTgLink) {
      const url = pendingTgLink; pendingTgLink = null;
      handleTgLink(url);
    }
    if (IS_SMOKE) runSmokeChecks();
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    trace('did-fail-load', code, desc, url);
  });
  // в smoke — консоль рендерера: webk логирует туда MTProto-ошибки
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    if (IS_SMOKE) console.log('[console]', String(message).slice(0, 200));
  });

  win.loadURL(`http://127.0.0.1:${WEB_PORT}/`);
}

function createTray() {
  if (IS_SMOKE) return;
  tray = new Tray(trayIcon());
  tray.setToolTip('Fortochka — Telegram Web');
  const menu = [
    { label: 'Открыть', click: showWindow },
    { label: 'Диагностика', click: openDiagWindow },
    { label: 'Проверить обновления', click: () => manualUpdateCheck() },
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

function registerProtocol() {
  if (!app.isPackaged) return; // в dev схему не трогаем
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    // portable-сборка мимо инсталлятора — регистрируем на ходу
    app.setAsDefaultProtocolClient('tg');
  }
}

// ---------- автообновление (GitHub Releases) ----------
let autoUpdater = null;
let updateStatusText = '';

function setupUpdater() {
  // portable не умеет самообновляться — только напоминание на странице диагностики
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) return;
  let au;
  try { au = require('electron-updater').autoUpdater; } catch { return; }
  autoUpdater = au;
  // самоподписанный серт: стандартная проверка подписи обновления не пройдёт
  autoUpdater.verifyUpdateCodeSignature = async () => null;
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-downloaded', (info) => {
    updateStatusText = 'скачано ' + info.version + ' — установится при выходе';
    if (Notification.isSupported()) {
      new Notification({
        title: 'Fortochka',
        body: `Обновление ${info.version} скачано — установится при выходе из приложения.`
      }).show();
    }
  });
  autoUpdater.on('error', () => {});
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 30000);
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 3600 * 1000).unref();
}

function manualUpdateCheck() {
  if (!autoUpdater) {
    openDiagWindow();
    return;
  }
  autoUpdater.checkForUpdates().then((r) => {
    const v = r && r.updateInfo && r.updateInfo.version;
    if (v && v !== app.getVersion()) {
      updateStatusText = 'доступно ' + v;
      if (Notification.isSupported()) {
        new Notification({ title: 'Fortochka', body: 'Доступна версия ' + v + ' — скачается и установится при выходе.' }).show();
      }
    } else {
      updateStatusText = 'актуальная версия';
      if (Notification.isSupported()) {
        new Notification({ title: 'Fortochka', body: 'У вас актуальная версия (' + app.getVersion() + ').' }).show();
      }
    }
  }).catch((e) => { updateStatusText = 'ошибка проверки: ' + (e.message || e); });
}

// ---------- smoke-тест ----------
let smokeDone = false;
async function runSmokeChecks() {
  if (!IS_SMOKE || smokeDone) return;
  smokeDone = true;
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
  const ok = out.webapp && !out.webapp.error && out.webapp.hasPageChats
    && out.sw && out.sw.count > 0
    && out.fronts && out.fronts.ok
    && out.wss === 'open' && out.socks && out.socks.ok;
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

app.whenReady().then(() => {
  try {
    configureSession();
    trace('session ok');
    startTgws();
    trace('tgws spawned');
    startWebServer();
    trace('web server ok');
    registerProtocol();
    createWindow();
    trace('window created');
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
