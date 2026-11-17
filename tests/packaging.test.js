'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const manifest = require('../package.json');

test('all local main-process modules are included in Windows/macOS bundles', () => {
  const required = ['main.js', 'netcore.js', 'updatecheck.js', 'staticserve.js', 'diagpage.js'];
  const entries = new Set(manifest.build.files);
  for (const file of required) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', file)), file + ' is missing');
    assert.ok(entries.has(file), file + ' is absent from electron-builder build.files');
  }
});
