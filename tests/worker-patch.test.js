'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('worker patch produces valid JavaScript and is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fortochka-worker-'));
  const file = path.join(dir, 'index.worker-test.js');
  const patcher = path.join(__dirname, '..', 'tools', 'patch-worker-fronts.js');
  const fixture = 'const host="k", r="2", i="-1"; const x=`${host.toLowerCase()}ws${r}${i}`; '+
    'const list=[`pclead.co.uk`,`notelega.co.uk`,`web.telegram.org`];';
  const invoke = () => spawnSync(process.execPath, [patcher], {
    env: { ...process.env, FORTOCHKA_WEBAPP_DIR: dir }, encoding: 'utf8'
  });
  try {
    fs.writeFileSync(file, fixture);
    const first = invoke();
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const patched = fs.readFileSync(file, 'utf8');
    assert.match(patched, /ws\$\{r\}`/);
    assert.doesNotMatch(patched, /ws\$\{r\}\$\{i\}/);
    assert.doesNotMatch(patched, /,`web\.telegram\.org`\]/);
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    const second = invoke();
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(fs.readFileSync(file, 'utf8'), patched);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('worker patch repairs a malformed prior template', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fortochka-worker-repair-'));
  const file = path.join(dir, 'index.worker-test.js');
  const patcher = path.join(__dirname, '..', 'tools', 'patch-worker-fronts.js');
  try {
    fs.writeFileSync(file, 'const r="2";const x=`host.toLowerCase()}ws${r`;'+
      'self.__fortochkaFronts=[];');
    const run = spawnSync(process.execPath, [patcher], {
      env: { ...process.env, FORTOCHKA_WEBAPP_DIR: dir }, encoding: 'utf8'
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const body = fs.readFileSync(file, 'utf8');
    assert.match(body, /ws\$\{r\}`/);
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    // This fixture intentionally contains no host declaration; syntax must still be valid.
    assert.equal(check.status, 0, check.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
