'use strict';
// Serve bundled files using bounded streams instead of buffering entire assets
// in the Electron main process. Supports single byte ranges for video/media.
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return false;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start >= size || end < start) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

async function serveStaticFile(req, res, { root, headersFor }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return;
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); res.end(); return; }
  if (pathname === '/') pathname = '/index.html';
  const file = path.resolve(root, '.' + pathname);
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    res.writeHead(403); res.end(); return;
  }
  let stats;
  try {
    stats = await fsp.stat(file);
    if (!stats.isFile()) throw new Error('not a file');
  } catch { res.writeHead(404); res.end('not found'); return; }
  // A symbolic link inside webapp must not expose arbitrary local files.
  let realRoot, realFile;
  try {
    [realRoot, realFile] = await Promise.all([fsp.realpath(root), fsp.realpath(file)]);
  } catch { res.writeHead(404); res.end('not found'); return; }
  const realRelative = path.relative(realRoot, realFile);
  if (realRelative === '..' || realRelative.startsWith('..' + path.sep) ||
      path.isAbsolute(realRelative)) {
    res.writeHead(403); res.end(); return;
  }

  const range = parseRange(req.headers.range, stats.size);
  if (range === false) {
    res.writeHead(416, { 'content-range': 'bytes */' + stats.size });
    res.end(); return;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : stats.size - 1;
  const headers = {
    ...headersFor(file),
    'accept-ranges': 'bytes',
    'content-length': range ? end - start + 1 : stats.size
  };
  if (range) headers['content-range'] = 'bytes ' + start + '-' + end + '/' + stats.size;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || stats.size === 0) { res.end(); return; }
  const stream = fs.createReadStream(file, { start, end, highWaterMark: 64 * 1024 });
  stream.on('error', (err) => res.destroy(err));
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

module.exports = { parseRange, serveStaticFile };
