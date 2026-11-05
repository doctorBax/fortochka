'use strict';
/*
 * Страница диагностики Fortochka: статика с локального сервера (/fortochka/diag),
 * данные — из /fortochka/api/* с токеном конкретного запуска.
 * Самодостаточный HTML без зависимостей.
 */
module.exports = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>Fortochka — диагностика</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  body { background:#17212b; color:#e1e6eb; font:14px/1.5 system-ui,sans-serif; margin:0; padding:24px; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:#7d8e9e; margin-bottom:20px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; max-width:980px; }
  .card { background:#202b36; border-radius:10px; padding:14px 16px; }
  .card h2 { font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:#7d8e9e; margin:0 0 10px; }
  table { width:100%; border-collapse:collapse; }
  td { padding:3px 8px 3px 0; white-space:nowrap; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; color:#9fb3c4; }
  .ok { color:#5bd38a; } .bad { color:#ef6b6b; } .unk { color:#7d8e9e; }
  button { background:#2b5278; color:#fff; border:0; border-radius:8px; padding:7px 14px; cursor:pointer; margin:4px 6px 4px 0; font-size:13px; }
  button:hover { background:#3a689a; } button:disabled { opacity:.5; cursor:default; }
  .kv { display:flex; gap:8px; margin:3px 0; } .kv b { min-width:130px; color:#9fb3c4; font-weight:500; }
  #msg { margin-top:14px; color:#7d8e9e; max-width:980px; }
  .front:first-child td { font-weight:600; }
</style></head><body>
<h1>Fortochka <span id="ver" style="color:#7d8e9e"></span></h1>
<div class="sub">Telegram Web K в Electron · сеть через CF-фонты и tg-ws-proxy</div>
<div class="grid">
  <div class="card">
    <h2>Фронты apiws</h2>
    <table id="fronts"></table>
    <div style="margin-top:10px">
      <button id="b-probe">Перепроверить сейчас</button>
      <span id="fronts-src" class="sub"></span>
    </div>
  </div>
  <div class="card">
    <h2>Приложение</h2>
    <div id="app"></div>
    <div style="margin-top:10px">
      <button id="b-upd">Проверить обновления</button>
      <button id="b-log">Открыть лог движка</button>
      <button id="b-profile">Открыть профиль</button>
    </div>
  </div>
</div>
<div id="msg"></div>
<script>
const TOKEN = '__TOKEN__';
const $ = (id) => document.getElementById(id);
const fmtMs = (m) => m == null ? '' : m + ' мс';
async function api(name, opts) {
  const r = await fetch('/fortochka/api/' + name, {
    ...opts, headers: { 'x-fortochka-token': TOKEN, ...(opts && opts.headers || {}) }
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
function dot(alive) {
  const s = document.createElement('span');
  if (alive === true) { s.className = 'ok'; s.textContent = '●'; }
  else if (alive === false) { s.className = 'bad'; s.textContent = '●'; }
  else { s.className = 'unk'; s.textContent = '○'; }
  return s;
}
async function refresh() {
  try {
    const st = await api('status');
    $('ver').textContent = 'v' + st.version;
    const ft = $('fronts'); ft.innerHTML = '';
    for (const f of st.fronts.health) {
      const tr = document.createElement('tr'); tr.className = 'front';
      const td1 = document.createElement('td');
      td1.appendChild(dot(f.alive));
      td1.appendChild(document.createTextNode(' ' + f.host));
      const td2 = document.createElement('td'); td2.className = 'num';
      td2.textContent = f.alive ? fmtMs(f.ms) : (f.alive === false ? 'мёртв' : 'не проверен');
      tr.append(td1, td2); ft.appendChild(tr);
    }
    $('fronts-src').textContent = 'источник: ' + st.fronts.source;
    const app = $('app'); app.innerHTML = '';
    const kv = (k, v, cls) => {
      const d = document.createElement('div'); d.className = 'kv';
      const b = document.createElement('b'); b.textContent = k;
      const s = document.createElement('span'); if (cls) s.className = cls;
      s.textContent = v; d.append(b, s); app.appendChild(d);
    };
    kv('Движок tg-ws-proxy', st.tgws.running ? 'работает (pid ' + st.tgws.pid + ')' : 'не запущен', st.tgws.running ? 'ok' : 'bad');
    kv('DoH', st.doh ? 'включён' : 'выключен (системный DNS)');
    kv('Профиль', st.profile);
    kv('Лог', st.log);
    kv('Обновления', st.updater || 'недоступны (dev-режим)');
    kv('Заблокировано CONNECT', st.blocked.length ? st.blocked.slice(0, 5).join(', ') : 'ничего');
  } catch (e) { $('msg').textContent = 'Ошибка: ' + e.message; }
}
$('b-probe').onclick = async (e) => {
  e.target.disabled = true; $('msg').textContent = 'Проверяю фронты (WS-upgrade до /apiws)...';
  try { await api('probe', { method: 'POST' }); } catch {}
  e.target.disabled = false; $('msg').textContent = ''; refresh();
};
$('b-upd').onclick = async (e) => {
  e.target.disabled = true;
  try { const r = await api('upcheck', { method: 'POST' }); $('msg').textContent = r.message || 'Готово'; }
  catch (err) { $('msg').textContent = 'Обновления: ' + err.message; }
  e.target.disabled = false; refresh();
};
$('b-log').onclick = () => api('openlog', { method: 'POST' });
$('b-profile').onclick = () => api('openprofile', { method: 'POST' });
refresh(); setInterval(refresh, 5000);
</script></body></html>`;
