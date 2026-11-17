'use strict';
// Read-only update detection. Stable never receives experimental prereleases.
// Beta releases are explicitly marked and offered for manual installation.
const RELEASES_URL = 'https://github.com/doctorBax/fortochka/releases/latest';
const BETA_RELEASES_URL = 'https://github.com/doctorBax/fortochka/releases';
const BETA_API_URL = 'https://api.github.com/repos/doctorBax/fortochka/releases?per_page=100';
const SOURCES = [
  { kind: 'release', url: 'https://api.github.com/repos/doctorBax/fortochka/releases/latest' },
  { kind: 'mirror', url: 'https://cdn.jsdelivr.net/gh/doctorBax/fortochka@main/package.json' },
  { kind: 'mirror', url: 'https://fastly.jsdelivr.net/gh/doctorBax/fortochka@main/package.json' }
];

function parseVersion(version) {
  if (typeof version !== 'string') return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(version.trim());
  if (!match) return null;
  const result = match.slice(1, 4).map(Number);
  if (match[4] != null) result.push(Number(match[4]));
  return result;
}
function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) throw new Error('Некорректная версия приложения');
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  // A stable version is newer than a beta with the same major.minor.patch.
  if (left.length !== right.length) return left.length === 3 ? 1 : -1;
  if (left.length === 4 && left[3] !== right[3]) return left[3] > right[3] ? 1 : -1;
  return 0;
}

async function getLatestVersion(fetchImpl = fetch, channel = 'stable') {
  if (channel === 'beta') {
    // GitHub's /releases/latest excludes prereleases. Query release history.
    const response = await fetchImpl(BETA_API_URL, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(5000),
      cache: 'no-store'
    });
    if (!response.ok) throw new Error('GitHub beta API HTTP ' + response.status);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('Bad beta release response');
    const beta = data
      .filter((release) => release && release.prerelease === true && !release.draft &&
        /^v?\d+\.\d+\.\d+-beta\.\d+$/.test(release.tag_name || ''))
      .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
    if (!beta) throw new Error('В GitHub Releases нет опубликованных beta-версий');
    return { version: beta.tag_name.replace(/^v/, ''), source: 'beta-release', url: BETA_RELEASES_URL };
  }
  if (channel !== 'stable') throw new Error('Unknown update channel');
  const failures = [];
  for (const source of SOURCES) {
    try {
      const response = await fetchImpl(source.url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(4000),
        cache: 'no-store'
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      if (source.kind === 'release' && (data.draft || data.prerelease)) {
        throw new Error('latest release is not stable');
      }
      const raw = source.kind === 'release' ? data.tag_name : data.version;
      if (!parseVersion(raw) || parseVersion(raw).length !== 3) {
        throw new Error('Invalid stable version in update response');
      }
      return { version: raw.replace(/^v/, ''), source: source.kind, url: RELEASES_URL };
    } catch (error) {
      failures.push(source.kind + ': ' + (error.message || error));
    }
  }
  throw new Error('Не удалось связаться с GitHub и CDN-зеркалами: ' + failures.join('; '));
}
module.exports = {
  RELEASES_URL, BETA_RELEASES_URL, BETA_API_URL,
  SOURCES, parseVersion, compareVersions, getLatestVersion
};
