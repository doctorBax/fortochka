'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DohResolver, buildDnsQuery, parseDnsA } = require('../netcore');
const name = 'example.org';

function dnsResponse(host, ip) {
  const question = buildDnsQuery(host).subarray(12);
  const header = Buffer.from([0, 0, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]);
  const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4,
    ...ip.split('.').map(Number)]);
  return Buffer.concat([header, question, answer]);
}

test('RFC8484 DNS question has correct label layout and QTYPE=A/QCLASS=IN', () => {
  const query = buildDnsQuery(name);
  assert.equal(query.length, 12 + 1 + 7 + 1 + 3 + 1 + 4);
  assert.equal(query.readUInt16BE(4), 1);
  assert.equal(query.subarray(-4).toString('hex'), '00010001');
  assert.deepEqual(parseDnsA(dnsResponse(name, '203.0.113.42')), ['203.0.113.42']);
});

test('DoH prefers JSON A-record results and ignores AAAA', async () => {
  const original = global.fetch;
  const resolver = new DohResolver({ doh: { enabled: true, urls: ['https://dns.test/resolve'] } });
  let calls = 0;
  global.fetch = async (url, opts) => {
    calls++;
    assert.match(url, /name=example.org&type=A/);
    assert.equal(opts.headers.accept, 'application/dns-json');
    return {
      ok: true, headers: { get: () => 'application/dns-json' },
      json: async () => ({ Answer: [
        { type: 28, data: '2001:db8::1' }, { type: 1, data: '203.0.113.1' }
      ] })
    };
  };
  try {
    assert.deepEqual(await resolver.lookup(name), ['203.0.113.1']);
    assert.equal(calls, 1);
  } finally { global.fetch = original; }
});

test('DoH falls back to RFC8484 POST when JSON endpoint is unsupported', async () => {
  const original = global.fetch;
  const resolver = new DohResolver({ doh: { enabled: true, urls: ['https://dns.test/dns-query'] } });
  const requests = [];
  global.fetch = async (url, opts) => {
    requests.push({ url, method: opts.method || 'GET', body: opts.body });
    if (opts.method !== 'POST') return { ok: false, status: 400, headers: { get: () => '' } };
    assert.equal(opts.headers['content-type'], 'application/dns-message');
    assert.deepEqual(Buffer.from(opts.body), buildDnsQuery(name));
    const payload = dnsResponse(name, '198.51.100.9');
    return { ok: true, arrayBuffer: async () => payload };
  };
  try {
    assert.deepEqual(await resolver.lookup(name), ['198.51.100.9']);
    assert.deepEqual(requests.map((x) => x.method), ['GET', 'POST']);
  } finally { global.fetch = original; }
});

test('disabled DoH performs no network calls', async () => {
  const resolver = new DohResolver({ doh: { enabled: false } });
  const original = global.fetch;
  global.fetch = async () => { throw new Error('network must be disabled'); };
  try { assert.equal(await resolver.lookup('example.org'), null); }
  finally { global.fetch = original; }
});

test('malformed/truncated DNS packets are ignored, not cached as valid answers', () => {
  assert.deepEqual(parseDnsA(Buffer.alloc(0)), []);
  assert.deepEqual(parseDnsA(Buffer.alloc(8)), []);
  const payload = dnsResponse(name, '192.0.2.12');
  payload[3] = 3; // SERVFAIL
  assert.deepEqual(parseDnsA(payload), []);
  assert.deepEqual(parseDnsA(dnsResponse(name, '192.0.2.12').subarray(0, 20)), []);
});

test('known RFC8484 endpoints skip JSON probing and go directly to wireformat', async () => {
  const original = global.fetch;
  const resolver = new DohResolver({ doh: {
    enabled: true, urls: ['https://unfiltered.adguard-dns.com/dns-query']
  } });
  const methods = [];
  global.fetch = async (url, options) => {
    methods.push(options.method || 'GET');
    assert.equal(options.method, 'POST');
    return { ok: true, arrayBuffer: async () => dnsResponse(name, '203.0.113.10') };
  };
  try {
    assert.deepEqual(await resolver.lookup(name), ['203.0.113.10']);
    assert.deepEqual(methods, ['POST']);
  } finally { global.fetch = original; }
});
