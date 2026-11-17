'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseVersion, compareVersions, getLatestVersion, BETA_API_URL } = require('../updatecheck');

test('stable semver takes precedence over same-base beta and beta sequence sorts', () => {
  assert.deepEqual(parseVersion('v0.2.8-beta.43'), [0, 2, 8, 43]);
  assert.equal(compareVersions('0.2.8', '0.2.8-beta.43'), 1);
  assert.equal(compareVersions('0.2.8-beta.44', '0.2.8-beta.43'), 1);
  assert.equal(compareVersions('0.2.9-beta.1', '0.2.8'), 1);
  assert.equal(parseVersion('0.2.8-beta'), null);
});

test('beta updates only enumerate released prereleases and skip stable', async () => {
  const result = await getLatestVersion(async (url) => {
    assert.equal(url, BETA_API_URL);
    return { ok: true, json: async () => [
      { tag_name: 'v0.2.8', prerelease: false, draft: false },
      { tag_name: 'v0.2.8-beta.2', prerelease: true, draft: false },
      { tag_name: 'v0.2.8-beta.11', prerelease: true, draft: false },
      { tag_name: 'v0.2.9-beta.99', prerelease: true, draft: true }
    ] };
  }, 'beta');
  assert.equal(result.version, '0.2.8-beta.11');
  assert.equal(result.source, 'beta-release');
});

test('beta preparer isolates installation identity, protocol ownership and profile', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fortochka-beta-'));
  try {
    const original = require('../package.json');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(original));
    const cli = path.join(__dirname, '..', 'tools', 'prepare-beta.js');
    const result = spawnSync(process.execPath, [cli], {
      env: { ...process.env, GITHUB_RUN_NUMBER: '42', FORTOCHKA_BETA_PROJECT_ROOT: root },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const beta = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(beta.version, '0.2.8-beta.42');
    assert.equal(beta.name, 'fortochka-beta');
    assert.equal(beta.productName, 'Fortochka Beta');
    assert.equal(beta.build.appId, 'io.github.doctorbax.fortochka.beta');
    assert.deepEqual(beta.build.protocols, []);
    assert.equal(beta.build.nsis.perMachine, false);
    assert.notEqual(beta.build.nsis.shortcutName, original.build.nsis.shortcutName);
    assert.notEqual(beta.build.portable.artifactName, original.build.portable.artifactName);
    assert.notEqual(beta.build.mac.artifactName, original.build.mac.artifactName);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
