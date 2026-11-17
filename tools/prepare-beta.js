#!/usr/bin/env node
'use strict';
// Convert the checked-out beta branch into a standalone prerelease package.
// This runs ONLY in CI *after* npm ci, never modifies the stable main branch.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const file = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const number = process.env.GITHUB_RUN_NUMBER || process.argv[2];
if (!/^\d+$/.test(String(number || '')) || Number(number) < 1) {
  throw new Error('Provide a positive GitHub Actions run number');
}
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
if (!match) throw new Error('Beta builds must start from a stable semver base, got ' + pkg.version);
const base = process.env.FORTOCHKA_BETA_BASE || [match[1], match[2], Number(match[3]) + 1].join('.');
if (!/^\d+\.\d+\.\d+$/.test(base)) throw new Error('Invalid FORTOCHKA_BETA_BASE');
const version = base + '-beta.' + number;
pkg.name = 'fortochka-beta';
pkg.productName = 'Fortochka Beta';
pkg.version = version;
pkg.build.appId = 'io.github.doctorbax.fortochka.beta';
pkg.build.productName = 'Fortochka Beta';
pkg.build.publish = null;
pkg.build.protocols = []; // Never steal tg:// from stable Fortochka.
pkg.build.nsis.oneClick = false;
pkg.build.nsis.perMachine = false;
pkg.build.nsis.shortcutName = 'Fortochka Beta';
pkg.build.nsis.artifactName = 'fortochka-beta-setup-${version}.${ext}';
pkg.build.portable.artifactName = 'fortochka-beta-portable-${version}.${ext}';
pkg.build.mac.artifactName = 'fortochka-beta-mac-${version}.${ext}';
pkg.build.dmg.title = 'Fortochka Beta ${version}';
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
const lockPath = path.join(root, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.name = pkg.name;
  lock.version = pkg.version;
  if (lock.packages && lock.packages['']) {
    lock.packages[''].name = pkg.name;
    lock.packages[''].version = pkg.version;
  }
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}
console.log('Prepared isolated prerelease', version);
