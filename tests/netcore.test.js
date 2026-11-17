'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DohResolver, FrontManager, Allowlist, buildDnsQuery, parseDnsA } = require('../netcore');

test('DoH uses first successful resolver and coalesces concurrent lookups', async () => {
  const resolver = new DohResolver({ doh: { enabled: true, urls: ['https://slow', 'https://fast'] } });
  let calls = 0;
  resolver.queryOne = async (url) => {
    calls++;
    await new Promise((r) => setTimeout(r, url.endsWith('slow') ? 25 : 5));
    return url.endsWith('fast') ? ['203.0.113.7'] : null;
  };
  const [a, b] = await Promise.all([resolver.lookup('example.com'), resolver.lookup('example.com')]);
  assert.deepEqual(a, ['203.0.113.7']);
  assert.deepEqual(b, a);
  assert.equal(calls, 2);
  assert.equal(resolver.workingUrl, 'https://fast');
  assert.deepEqual(await resolver.lookup('example.com'), a);
  assert.equal(calls, 2);
});

test('DoH negative results are cached briefly', async () => {
  const resolver = new DohResolver({ doh: { enabled: true, urls: ['https://a', 'https://b'] } });
  let calls = 0;
  resolver.queryOne = async () => { calls++; return null; };
  assert.equal(await resolver.lookup('unavailable.example'), null);
  assert.equal(await resolver.lookup('unavailable.example'), null);
  assert.equal(calls, 2);
});

test('health check targets kws2 even for official domain', async () => {
  const fm = new FrontManager({ fronts: { list: ['web.telegram.org', 'example.net'] } }, '/tmp/state.json');
  const hosts = [];
  fm.probeHost = async (host) => { hosts.push(host); return { alive: true, ms: 10 }; };
  await fm.probeAll();
  assert.deepEqual(hosts, ['kws2.web.telegram.org', 'kws2.example.net']);
});

test('a single transient failure does not remove a front', async () => {
  const fm = new FrontManager({ fronts: { list: ['good.example', 'unstable.example'] } }, '/tmp/state.json');
  fm.probesDone = true;
  fm.health.set('good.example', { alive: true, ms: 10, failStreak: 0 });
  fm.health.set('unstable.example', { alive: false, ms: null, failStreak: 1 });
  const getList = () => new Promise((resolve) => fm.serveFrontsScript({
    writeHead: () => {},
    end: (body) => resolve(JSON.parse(body.split('=')[1].split(';')[0]))
  }));
  assert.deepEqual(await getList(), ['good.example', 'unstable.example']);
  fm.health.set('unstable.example', { alive: false, ms: null, failStreak: 2 });
  assert.deepEqual(await getList(), ['good.example']);
});

test('DNS wireformat parser rejects truncated IP data', () => {
  const hdr = Buffer.from([0, 0, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]);
  const q = buildDnsQuery('example.com').subarray(12);
  const a = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 10, 0, 4, 203, 0, 113, 1]);
  const msg = Buffer.concat([hdr, q, a]);
  assert.deepEqual(parseDnsA(msg), ['203.0.113.1']);
  assert.deepEqual(parseDnsA(msg.subarray(0, msg.length - 2)), []);
});

test('allowlist excludes unrelated hosts and suffix lookalikes', () => {
  const config = { workerDomains: [], security: { allowHosts: [] } };
  const fm = { baseList: () => ({ domains: ['example.org'] }) };
  const al = new Allowlist(config, fm);
  assert.equal(al.allows('kws2.example.org'), true);
  assert.equal(al.allows('kws2.example.org.attacker.test'), false);
  assert.equal(al.allows('example.org.attacker.test'), false);
});
