// Собирает build/icon.ico из PNG webk (ICO с PNG-сжатыми записями, Vista+).
// usage: node tools/make-ico.js
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const sources = [
  path.join(APP, 'webapp', 'assets', 'img', 'favicon-16x16.png'),
  path.join(APP, 'webapp', 'assets', 'img', 'favicon-32x32.png'),
  path.join(APP, 'webapp', 'assets', 'img', 'android-chrome-256x256.png')
].filter(fs.existsSync);

if (!sources.length) { console.error('нет PNG-исходников'); process.exit(1); }

const pngs = sources.map(f => ({ size: 0, data: fs.readFileSync(f) }));
// размеры из IHDR
for (const p of pngs) p.size = p.data.readUInt32BE(16);

const count = pngs.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4);

const entries = [];
let offset = 6 + 16 * count;
for (const p of pngs) {
  const e = Buffer.alloc(16);
  e.writeUInt8(p.size === 256 ? 0 : p.size, 0);
  e.writeUInt8(p.size === 256 ? 0 : p.size, 1);
  e.writeUInt8(0, 2); e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(p.data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += p.data.length;
  entries.push(e);
}

const outDir = path.join(APP, 'build');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.ico'),
  Buffer.concat([header, ...entries, ...pngs.map(p => p.data)]));
console.log('build/icon.ico:', count, 'записи:', pngs.map(p => p.size).join('/'));
