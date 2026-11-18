'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyLink, routeLink } = require('../external-links');
const own = 'http://127.0.0.1:1081';

test('local application origin only: no prefix spoofing or foreign port', () => {
  assert.equal(classifyLink(own + '/fortochka/diag', own), 'internal');
  assert.equal(classifyLink(own + '/', own), 'internal');
  assert.equal(classifyLink('http://127.0.0.1:1082/', own), 'external');
  assert.equal(classifyLink('http://127.0.0.1:1081.evil.example/', own), 'ignore'); // invalid URL is rejected safely
  assert.equal(classifyLink('https://example.org/', own), 'external');
  assert.equal(classifyLink('http://example.org', own), 'external');
});

test('links never create child windows; system browser receives external URLs', async () => {
  const opened = [], telegram = [];
  const callbacks = { openExternal: (url) => { opened.push(url); }, openTelegram: (url) => telegram.push(url) };
  assert.equal(routeLink('https://example.org/', own, callbacks), 'external');
  assert.equal(routeLink('mailto:tester@example.org', own, callbacks), 'external');
  assert.equal(routeLink('tg://resolve?domain=telegram', own, callbacks), 'telegram');
  assert.equal(routeLink(own + '/index.html', own, callbacks), 'internal');
  await new Promise(setImmediate);
  assert.deepEqual(opened, ['https://example.org/', 'mailto:tester@example.org']);
  assert.deepEqual(telegram, ['tg://resolve?domain=telegram']);
});

test('executable, file, malformed or script URLs never reach OS handler', async () => {
  const opened = [];
  const cbs = { openExternal: (url) => opened.push(url), openTelegram: () => {} };
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x',
    'about:blank', 'not a URL', '', null, 'powershell://run', 'ftp://example.net/']) {
    assert.equal(routeLink(url, own, cbs), 'ignore');
  }
  await new Promise(setImmediate);
  assert.deepEqual(opened, []);
});

test('external open errors are contained, not unhandled', async () => {
  let calls = 0;
  assert.equal(routeLink('https://example.org/', own, {
    openExternal: () => { calls++; return Promise.reject(new Error('no browser')); },
    openTelegram: () => {}
  }), 'external');
  await new Promise(setImmediate);
  assert.equal(calls, 1);
});
