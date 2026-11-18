'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVersion, compareVersions, getLatestVersion, SOURCES } = require('../updatecheck');

test('semantic version comparison does not confuse 0.2.10 with 0.2.9', () => {
  assert.deepEqual(parseVersion('v0.2.7'), [0, 2, 7]);
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1);
  assert.equal(compareVersions('0.2.7', '0.2.7'), 0);
  assert.equal(compareVersions('0.2.6', '0.2.7'), -1);
  assert.equal(parseVersion('0.3.0-beta'), null);
});

test('release checker reads stable GitHub release metadata without latest.yml', async () => {
  const calls = [];
  const result = await getLatestVersion(async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ tag_name: 'v0.2.7', draft: false, prerelease: false }) };
  });
  assert.equal(result.version, '0.2.7');
  assert.equal(result.source, 'release');
  assert.deepEqual(calls, [SOURCES[0].url]);
});

test('release checker uses jsDelivr package metadata when GitHub API is unavailable', async () => {
  const calls = [];
  const result = await getLatestVersion(async (url) => {
    calls.push(url);
    if (url === SOURCES[0].url) throw new Error('blocked');
    return { ok: true, json: async () => ({ version: '0.2.8' }) };
  });
  assert.equal(result.version, '0.2.8');
  assert.equal(result.source, 'mirror');
  assert.deepEqual(calls, [SOURCES[0].url, SOURCES[1].url]);
});

test('release checker rejects malformed metadata, and explains all-sources failure', async () => {
  await assert.rejects(
    getLatestVersion(async () => ({ ok: true, json: async () => ({ version: 'invalid', tag_name: 'invalid' }) })),
    /GitHub и CDN/
  );
});
