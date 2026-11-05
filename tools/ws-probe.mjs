// Точная реплика handshake tgws + проверка CONNECT-шимма приложения.
import net from 'node:net';

function wsUpgrade(host, { viaShim = false, origin = true, ua = true } = {}, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const key = Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))).toString('base64');
    const headers = [
      `GET /apiws HTTP/1.1`, `Host: ${host}`, `Upgrade: websocket`, `Connection: Upgrade`,
      `Sec-WebSocket-Key: ${key}`, `Sec-WebSocket-Version: 13`, `Sec-WebSocket-Protocol: binary`
    ];
    if (origin) headers.push(`Origin: https://web.telegram.org`);
    if (ua) headers.push(`User-Agent: Mozilla/5.0`);
    headers.push(`\r\n`);

    const sock = net.connect(443, host);
    sock.setTimeout(timeoutMs);
    let buf = '';
    const finish = (r) => { try { sock.destroy(); } catch {} resolve(r); };
    sock.on('timeout', () => finish('timeout'));
    sock.on('error', (e) => finish('err:' + e.code));
    sock.on('connect', () => {
      if (viaShim) {
        // CONNECT к тому же хосту через шимм приложения
        const shim = net.connect(1081, '127.0.0.1');
        shim.setTimeout(timeoutMs);
        let sbuf = '';
        shim.on('timeout', () => { finish('shim timeout'); shim.destroy(); });
        shim.on('error', (e) => finish('shim err ' + e.code));
        shim.on('connect', () => shim.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
        shim.on('data', (d) => {
          sbuf += d.toString('latin1');
          if (sbuf.includes('200')) {
            shim.write(headers.join('\r\n'));
            shim.removeAllListeners('data');
            shim.on('data', (d2) => {
              buf += d2.toString('latin1');
              if (buf.includes('\r\n\r\n')) finish('via shim: ' + buf.split('\r\n')[0]);
            });
          } else if (sbuf.includes('\r\n\r\n')) {
            finish('shim reply: ' + sbuf.split('\r\n')[0]);
          }
        });
        return;
      }
      sock.write(headers.join('\r\n'));
    });
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) finish(buf.split('\r\n')[0]);
    });
  });
}

console.log('pclead bare          :', await wsUpgrade('kws2.pclead.co.uk', { origin: false, ua: false }));
console.log('pclead with Origin+UA:', await wsUpgrade('kws2.pclead.co.uk', {}));
console.log('offshor bare         :', await wsUpgrade('kws2.offshor.co.uk', { origin: false, ua: false }));
console.log('via shim pclead      :', await wsUpgrade('kws2.pclead.co.uk', { viaShim: true, origin: false, ua: false }));
