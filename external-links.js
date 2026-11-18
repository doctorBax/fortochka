'use strict';
// A small policy layer shared by navigation and window.open handling.
// Do not create Electron child windows for untrusted destinations.
function classifyLink(href, localOrigin) {
  if (typeof href !== 'string') return 'ignore';
  let url;
  try { url = new URL(href); } catch { return 'ignore'; }
  if (url.protocol === 'tg:') return 'telegram';
  if ((url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin === localOrigin) return 'internal';
  if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
    return 'external';
  }
  return 'ignore';
}
function routeLink(href, localOrigin, { openExternal, openTelegram }) {
  const action = classifyLink(href, localOrigin);
  if (action === 'telegram') openTelegram(href);
  if (action === 'external') {
    // Explicitly absorb the Promise rejection; navigation always stays blocked.
    Promise.resolve().then(() => openExternal(href)).catch(() => {});
  }
  return action;
}
module.exports = { classifyLink, routeLink };
