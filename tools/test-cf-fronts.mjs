// Проверка CF-фронтов tgws как обхода блокировки apiws: WS-upgrade с 'binary'
// к kwsN.<домен> через Cloudflare. 101 = фронт жив и проксирует apiws.
import net from 'node:net';

const domains = ['pclead.co.uk', 'offshor.co.uk', 'cakeisalie.co.uk', 'noskomnadzor.co.uk',
  'kartoshka.co.uk', 'sorokdva.co.uk', 'havegreatday.co.uk', 'pomogite.co.uk'];
const dcs = [2, 1]; // хватит DC2 (auth) и DC1

function wsProbe(host, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const key = net.randomBytes ? '' : '';
    const sock = net.connect(443, host);
    sock.setTimeout(timeoutMs);
    let buf = '';
    const finish = (r) => { try { sock.destroy(); } catch {} resolve(r); };
    sock.on('timeout', () => finish('timeout'));
    sock.on('error', (e) => finish('err:' + e.code));
    sock.on('connect', () => {
      const req = [
        `GET /apiws HTTP/1.1`, `Host: ${host}`, `Upgrade: websocket`, `Connection: Upgrade`,
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==`, `Sec-WebSocket-Version: 13`,
        `Sec-WebSocket-Protocol: binary`, `Origin: https://web.telegram.org`,
        `User-Agent: Mozilla/5.0`, `\r\n`
      ].join('\r\n');
      sock.write(req);
    });
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        const status = buf.split(' ')[1];
        finish(status === '101' ? 'OK(101)' : 'http ' + status);
      }
    });
  });
}

for (const dc of dcs) {
  for (const d of domains) {
    const host = `kws${dc}.${d}`;
    process.stdout.write(host.padEnd(34) + ' -> ');
    console.log(await wsProbe(host));
  }
}
