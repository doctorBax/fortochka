'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateProfile, setupProfile, loadState, saveState, FrontManager, Allowlist } = require('../netcore');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fortochka-profile-')); }
test('legacy profile migration preserves account data and never overwrites current profile', () => {
  const root = tmp();
  try {
    const oldPath = path.join(root, 'tgweb-desktop');
    fs.mkdirSync(oldPath);
    fs.writeFileSync(path.join(oldPath, 'session-token.txt'), 'existing user session');
    assert.equal(migrateProfile(root), path.join(root, 'fortochka'));
    assert.equal(fs.readFileSync(path.join(root, 'fortochka', 'session-token.txt'), 'utf8'), 'existing user session');
    fs.mkdirSync(oldPath);
    fs.writeFileSync(path.join(oldPath, 'should-stay.txt'), 'old profile');
    assert.equal(migrateProfile(root), path.join(root, 'fortochka'));
    assert.ok(fs.existsSync(path.join(oldPath, 'should-stay.txt')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('profile creation, configuration merge, and persisted state survive relaunch', () => {
  const root = tmp();
  try {
    const first = setupProfile(root);
    assert.ok(fs.existsSync(first.configFile));
    assert.ok(first.config.ports.web > 0);
    fs.writeFileSync(first.configFile, JSON.stringify({
      ports: { web: 29081 }, window: { rememberBounds: false }, fronts: { autoUpdate: false }
    }));
    const second = setupProfile(root);
    assert.equal(second.config.ports.web, 29081);
    assert.equal(second.config.ports.socks, first.config.ports.socks);
    assert.equal(second.config.window.rememberBounds, false);
    saveState(second.stateFile, { window: { bounds: { width: 900 } }, cacheSchema: 3 });
    assert.equal(loadState(second.stateFile).window.bounds.width, 900);
    assert.deepEqual(loadState(path.join(root, 'not-found.json')), {});
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cached front list loads offline; config list has higher priority', async () => {
  const root = tmp();
  try {
    const file = path.join(root, 'state.json');
    fs.writeFileSync(path.join(root, 'fronts-cache.json'), JSON.stringify({
      domains: ['cached.example.net'], at: '2026-01-01'
    }));
    const cfg = { fronts: { autoUpdate: false, list: null }, doh: { enabled: false } };
    const fm = new FrontManager(cfg, file);
    fm.probeHost = async () => ({ alive: true, ms: 5 });
    fm.start();
    if (fm.probing) await fm.probing;
    assert.deepEqual(fm.baseList().domains, ['cached.example.net']);
    assert.equal(fm.baseList().source, 'repo');
    cfg.fronts.list = ['manual.example.net'];
    assert.deepEqual(fm.baseList().domains, ['manual.example.net']);
    assert.equal(fm.baseList().source, 'config');
    fm.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('front health ranks healthy first, then unknown, then unhealthy', () => {
  const cfg = { fronts: { autoUpdate: false, list: [
    'dead.test', 'unknown.test', 'slow.test', 'fast.test'] } };
  const fm = new FrontManager(cfg, '/tmp/unused-state.json');
  fm.health.set('dead.test', { alive: false, ms: null, failStreak: 2 });
  fm.health.set('slow.test', { alive: true, ms: 120 });
  fm.health.set('fast.test', { alive: true, ms: 15 });
  assert.deepEqual(fm.rankedList().domains, [
    'fast.test', 'slow.test', 'unknown.test', 'dead.test'
  ]);
});

test('allowlist excludes hostile suffixes and keeps diagnostic history bounded', () => {
  const cfg = { workerDomains: ['worker.example'], security: { allowHosts: ['ok.example'] } };
  const fm = { baseList: () => ({ domains: ['front.example'] }) };
  const allow = new Allowlist(cfg, fm);
  for (const host of ['kws2.front.example', 'abc.worker.example', 'sub.ok.example',
    'web.telegram.org']) assert.equal(allow.allows(host), true, host);
  for (let i = 0; i < 30; i++) {
    assert.equal(allow.allows('bad' + i + '.example'), false);
  }
  assert.equal(allow.blocked.length, 20);
  assert.equal(allow.allows('web.telegram.org.attacker.test'), false);
});
