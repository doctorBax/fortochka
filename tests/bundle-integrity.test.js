'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const webapp = path.join(root, 'webapp');

test('main webapp references actual local JS and CSS assets', () => {
  const html = fs.readFileSync(path.join(webapp, 'index.html'), 'utf8');
  const assets = [];
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)=["']([^"']+)["']/g)) {
    const raw = match[1];
    if (/^(https?:|data:|#)/.test(raw)) continue;
    const pathname = raw.split('?')[0].replace(/^\//, '');
    if (!/\.(?:js|css|mjs)$/.test(pathname)) continue;
    assets.push(pathname);
    assert.ok(fs.existsSync(path.join(webapp, pathname)), 'missing webapp asset: ' + pathname);
  }
  assert.ok(assets.length > 0, 'webapp index.html should reference bundled JS/CSS');
});

test('both packaged web worker bundles parse as valid JavaScript modules', () => {
  const workers = fs.readdirSync(webapp).filter((name) => /^index\.worker-.*\.js$/.test(name));
  assert.ok(workers.length >= 2, 'expected both worker variants');
  for (const file of workers) {
    const source = fs.readFileSync(path.join(webapp, file));
    assert.match(source.toString('utf8'), /__fortochkaFronts/, 'front patch missing: ' + file);
    const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], {
      input: source, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024
    });
    assert.equal(checked.status, 0, file + ': ' + checked.stderr);
  }
});

test('Windows and universal macOS bridge binaries are packaged', () => {
  const win = fs.readFileSync(path.join(root, 'vendor', 'tg-ws-proxy.exe'));
  assert.equal(win.subarray(0, 2).toString('ascii'), 'MZ');
  assert.ok(win.byteLength > 100_000);
  const mac = fs.readFileSync(path.join(root, 'vendor', 'tg-ws-proxy-macos'));
  const magic = mac.subarray(0, 4).toString('hex');
  assert.ok(['cafebabe', 'cafebabf', 'feedfacf', 'cffaedfe'].includes(magic), 'Mach-O header ' + magic);
  assert.ok(mac.byteLength > 100_000);
});

test('README banner exists and baseline release metadata stays stable', () => {
  const manifest = require('../package.json');
  assert.equal(manifest.name, 'fortochka');
  assert.equal(manifest.productName, 'Fortochka');
  assert.equal(manifest.build.appId, 'io.github.doctorbax.fortochka');
  assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /assets\/fortochka-banner.webp/);
  assert.ok(fs.statSync(path.join(root, 'assets', 'fortochka-banner.webp')).size > 100);
});
