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

test('front probes have bounded concurrency and preserve input order', async () => {
  const domains = Array.from({ length: 26 }, (_, i) => 'front' + i + '.example');
  const fm = new FrontManager({ fronts: { list: domains } }, '/tmp/state.json');
  let active = 0, peak = 0;
  fm.probeHost = async (host) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 2));
    active--;
    return { alive: true, ms: 2 };
  };
  const result = await fm.probeAll();
  assert.equal(result.length, domains.length);
  assert.deepEqual(result.map((r) => r.host), domains);
  assert.ok(peak <= 10, 'peak concurrent probes: ' + peak);
  assert.ok(peak > 1);
});

test('one failing probe does not abort all other front health checks', async () => {
  const fm = new FrontManager({ fronts: { list: ['one.example', 'two.example'] } }, '/tmp/state.json');
  fm.probeHost = async (host) => {
    if (host.includes('one.example')) throw new Error('network error');
    return { alive: true, ms: 3 };
  };
  const result = await fm.probeAll();
  assert.equal(result[0].alive, false);
  assert.equal(result[1].alive, true);
});

test('startup releases fronts as soon as the first healthy probe completes', async () => {
  const fm = new FrontManager({ fronts: { autoUpdate: false, list: ['slow.example', 'fast.example'] } },
    '/tmp/state.json');
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  fm.probeHost = async (host) => {
    if (host.includes('slow.example')) { await slow; return { alive: false, ms: null }; }
    return { alive: true, ms: 8 };
  };
  fm.start();
  const body = await Promise.race([
    new Promise((resolve) => fm.serveFrontsScript({
      writeHead() {}, end(value) { resolve(value); }, destroy() { resolve(null); }
    })),
    new Promise((_, reject) => setTimeout(() => reject(new Error('front list waited for slow probe')), 250))
  ]);
  assert.match(body, /fast\\.example/);
  releaseSlow();
  await fm.probing;
  fm.stop();
});

test('previously healthy front is probed first without altering result order', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fortochka-preferred-'));
  try {
    fs.writeFileSync(path.join(dir, 'front-preferred.json'), JSON.stringify({ host: 'last.example' }));
    const domains = Array.from({ length: 12 }, (_, i) => 'front' + i + '.example').concat('last.example');
    const fm = new FrontManager({ fronts: { autoUpdate: false, list: domains } },
      path.join(dir, 'state.json'));
    const called = [];
    fm.probeHost = async (host) => {
      called.push(host);
      return { alive: true, ms: 10 };
    };
    fm.start();
    const result = await fm.probing;
    assert.equal(called[0], 'kws2.last.example');
    assert.deepEqual(result.map((r) => r.host), domains);
    fm.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
