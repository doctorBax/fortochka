'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { serveStaticFile, parseRange } = require('../staticserve');

test('range parser accepts suffix and open-ended requests, rejects invalid ranges', () => {
  assert.deepEqual(parseRange('bytes=0-3', 10), { start: 0, end: 3 });
  assert.deepEqual(parseRange('bytes=7-', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.equal(parseRange('bytes=30-40', 10), false);
  assert.equal(parseRange('bytes=0-1,4-6', 10), false);
  assert.equal(parseRange(undefined, 10), null);
});

test('static asset server streams GET/HEAD, supports byte ranges and blocks unsafe paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fortochka-static-'));
  fs.writeFileSync(path.join(root, 'index.html'), 'Hello world');
  fs.writeFileSync(path.join(root, 'video.mp4'), Buffer.alloc(1024 * 1024, 65));
  const server = http.createServer((req, res) => {
    serveStaticFile(req, res, {
      root, headersFor: () => ({ 'content-type': 'text/plain', 'cache-control': 'no-cache' })
    }).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    const index = await fetch(url + '/');
    assert.equal(index.status, 200);
    assert.equal(await index.text(), 'Hello world');
    const head = await fetch(url + '/index.html', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '11');
    const part = await fetch(url + '/video.mp4', { headers: { range: 'bytes=10-19' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 10-19/1048576');
    assert.equal((await part.arrayBuffer()).byteLength, 10);
    const invalid = await fetch(url + '/video.mp4', { headers: { range: 'bytes=9999999-' } });
    assert.equal(invalid.status, 416);
    const unsafe = await fetch(url + '/%2e%2e%2fsecret');
    assert.equal(unsafe.status, 403);
    const post = await fetch(url + '/', { method: 'POST' });
    assert.equal(post.status, 405);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
