// CDP-диагностика рендерера tgweb-desktop
// usage: node tools/diag.mjs
const CDP = 'http://127.0.0.1:9222';

const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find(t => t.type === 'page' && /tgweb/.test(t.url)) || targets.find(t => t.type === 'page');
if (!page) { console.log('NO_PAGE_TARGET', targets.map(t => t.type + ' ' + t.url)); process.exit(1); }
console.log('target:', page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}
const logs = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ');
    logs.push(`[console.${msg.params.type}] ${text}`);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    logs.push(`[exception] ${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text}`);
  } else if (msg.method === 'Log.entryAdded') {
    logs.push(`[log.${msg.params.entry.level}] ${msg.params.entry.text} ${msg.params.entry.url ?? ''}`);
  } else if (msg.method === 'Network.webSocketCreated') {
    logs.push(`[ws-created] ${msg.params.url}`);
  } else if (msg.method === 'Network.webSocketHandshakeResponseReceived') {
    logs.push(`[ws-handshake] ${msg.params.url} status=${msg.params.response?.status}`);
  } else if (msg.method === 'Network.webSocketError') {
    logs.push(`[ws-error] ${msg.params.errorMessage}`);
  }
};

await new Promise(r => { ws.onopen = r; });
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
await send('Page.enable');

const evalJS = async (expr, awaitPromise = true) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true, timeout: 15000 });
  return r.exceptionDetails ? { EXCEPTION: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text } : r.result.value;
};

// 1) boot-состояние страницы
console.log('location:', await evalJS('location.href', false));
console.log('body class:', await evalJS('document.body.className', false));
console.log('auth DOM:', await evalJS(`!!document.querySelector('#auth-pages') || !!document.querySelector('.auth-form') || !!document.querySelector('progress-element, .qr') || document.body.innerHTML.includes('qr')`, false));
console.log('SW regs:', await evalJS(`navigator.serviceWorker.getRegistrations().then(a => a.map(x => x.active?.scriptURL || x.installing?.scriptURL || 'pending'))`));
console.log('SW controller:', await evalJS('navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null', false));

// 2) прямой тест wss из контекста страницы (как это делает webk)
const wsTest2 = (url) => `new Promise(res => {
  let done = false;
  const fin = (r) => { if (!done) { done = true; res(r); } };
  try {
    const w = new WebSocket('${url}', 'binary');
    const t = setTimeout(() => fin('timeout 10s'), 10000);
    w.onopen = () => { clearTimeout(t); w.close(); fin('OPEN'); };
    w.onerror = () => { clearTimeout(t); fin('ERROR'); };
  } catch (e) { fin('EXCEPTION ' + e); }
})`;
console.log('wss pclead (CF-фронт, binary):', await evalJS(wsTest2('wss://kws2.pclead.co.uk/apiws')));

// 3) собранные логи страницы — включая СОБСТВЕННЫЕ попытки webk (ws-created)
await new Promise(r => setTimeout(r, 12000));
console.log('--- network/console events:', logs.length);
for (const l of logs.slice(0, 50)) console.log(' ', l);
ws.close();
process.exit(0);
