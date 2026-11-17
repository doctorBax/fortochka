'use strict';
// Lightweight, read-only update detection. Release installers are not auto-installed
// until release authenticity can be verified using a trusted code-signing certificate.
const RELEASES_URL = 'https://github.com/doctorBax/fortochka/releases/latest';
const SOURCES = [
  { kind: 'release', url: 'https://api.github.com/repos/doctorBax/fortochka/releases/latest' },
  { kind: 'mirror', url: 'https://cdn.jsdelivr.net/gh/doctorBax/fortochka@main/package.json' },
  { kind: 'mirror', url: 'https://fastly.jsdelivr.net/gh/doctorBax/fortochka@main/package.json' }
];

function parseVersion(version) {
  if (typeof version !== 'string') return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return null;
  return match.slice(1).map(Number);
}
function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) throw new Error('Некорректная версия приложения');
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

async function getLatestVersion(fetchImpl = fetch) {
  const failures = [];
  for (const source of SOURCES) {
    try {
      const response = await fetchImpl(source.url, {
        headers: { 'accept': 'application/json' },
        signal: AbortSignal.timeout(4000),
        cache: 'no-store'
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      if (source.kind === 'release' && (data.draft || data.prerelease)) {
        throw new Error('latest release is not stable');
      }
      const raw = source.kind === 'release' ? data.tag_name : data.version;
      if (!parseVersion(raw)) throw new Error('Invalid version in update response');
      return { version: raw.replace(/^v/, ''), source: source.kind, url: RELEASES_URL };
    } catch (error) {
      failures.push(source.kind + ': ' + (error.message || error));
    }
  }
  throw new Error('Не удалось связаться с GitHub и CDN-зеркалами: ' + failures.join('; '));
}
module.exports = { RELEASES_URL, SOURCES, parseVersion, compareVersions, getLatestVersion };
