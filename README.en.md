# Fortochka

[README на русском](README.md)

Fortochka is a desktop wrapper around [Telegram Web K](https://github.com/morethanwords/tweb)
that works on networks where Telegram's web endpoints are blocked. The name comes from
"форточка" (casement window): direct access is boarded shut by the provider, traffic goes
through the small open window — Cloudflare fronts.

```
┌─ Electron ────────────────────────────────────────────────────────┐
│  UI:   webk statics served on http://127.0.0.1:1081               │
│        (localhost = secure context → service worker works)        │
│  Net:  Chromium session proxy → local HTTP CONNECT shim           │
│        allowlist (Telegram hosts only) + DNS-over-HTTPS           │
└────────────────────────┬──────────────────────────────────────────┘
                         ▼
   wss://kws{dcId}.<front>/apiws  (live front list + health-check)
                         ▼
      Cloudflare edge ──► Telegram web endpoint (TLS end-to-end)
                         ▼
              Telegram DC (MTProto content e2e)

Sidecar: bundled tg-ws-proxy-rs (vendored per-platform:
  vendor/tg-ws-proxy.exe / vendor/tg-ws-proxy-macos)
  ├─ MTProto :1443 — point regular Telegram Desktop at it too
  └─ SOCKS5 :1080 — Telegram-only, used for the smoke test
```

## Why it works on blocked networks

Direct TCP to `*.web.telegram.org` is dropped. Fortochka:

1. Connects through community Cloudflare fronts — `kws{dcId}.<front>` domains that proxy
   to Telegram's web endpoints. The front list is fetched from this repository
   (`fronts.json`): adding a front is a PR, not an app release.
2. Health-checks every front with a real WebSocket upgrade to `/apiws` (what the client
   itself does), ranks by latency, and hands the ranked list to the web app on every
   transport rotation.
3. Resolves DNS over HTTPS: provider resolvers commonly poison Telegram and front domains.
   Falls back to the system resolver.
4. Talks only to Telegram. The CONNECT shim allows only `*.telegram.org`, the fronts and
   captcha providers used at login; local statics are served with a strict CSP. A
   compromised renderer cannot exfiltrate data to arbitrary hosts.

Gotcha: `/apiws` requires the `binary` WebSocket subprotocol — without it Telegram
answers 404.

## Install

### Windows

From [Releases](../../releases):

- `fortochka-setup-<version>.exe` — installer (Program Files), auto-updates
- `fortochka-portable-<version>.exe` — single file, no installation

### macOS

From [Releases](../../releases): `fortochka-mac-<version>.dmg` (universal: Intel and
Apple Silicon). Open the DMG, drag Fortochka to Applications.

The app has no Apple Developer signature, so macOS blocks the first launch — usually
with a "damaged and can't be opened, move to trash" dialog (macOS 14–15). The app is
not damaged: click **Cancel** and remove the quarantine flag once in Terminal
(Spotlight → "Terminal"):

```
xattr -cr /Applications/Fortochka.app
```

If System Settings → Privacy & Security shows an **Open Anyway** button for Fortochka,
that works too, no Terminal needed. On macOS 13 and older: right-click the app →
**Open** → **Open**.

Step-by-step guide (in Russian, covers all macOS versions):
[docs/install-macos.md](docs/install-macos.md).

macOS builds do not auto-update: the app reports a new version (tray → check for
updates), the DMG you download yourself.

On both platforms: closing the window hides it; the tray/menubar icon has open,
diagnostics, autostart, quit. Clicking a `tg://` link anywhere opens it in Fortochka.
On macOS there is also an unread badge on the dock icon and standard shortcuts
(Cmd+C/V/Q).

## Diagnostics

Tray menu → **Diagnostics** opens a local page (`http://127.0.0.1:1081/fortochka/diag`)
with front health (latency per front, list source), app state, and buttons: re-probe
fronts, check for updates, open engine log / profile folder.

```
npm run smoke    # headless check: statics + service worker + fronts endpoint + wss + SOCKS bridge
```

## Configuration

Profile lives in `%APPDATA%/fortochka/` on Windows, `~/Library/Application Support/fortochka/`
on macOS (migrated from the pre-release `tgweb-desktop` automatically). `config.json`
is created with defaults on first run:

```jsonc
{
  "ports": { "web": 1081, "socks": 1080, "mtproto": 1443 },
  "fronts": {
    "autoUpdate": true,     // pull fronts.json from this repo every 3h
    "list": null            // array of domains — hard override of the list
  },
  "workerDomains": [],      // your own Cloudflare Worker domain(s), passed to the engine
  "doh": { "enabled": true, "urls": null },
  "security": { "allowHosts": [] },  // extra CONNECT hosts, if you know why
  "window": { "startMinimized": false, "rememberBounds": true }
}
```

`state.json` (app-managed) keeps window bounds; `fronts-cache.json` is the last good
front list.

## Rebuilding webk (optional)

`webapp/` ships prebuilt and patched. To rebuild from upstream sources:

```
git clone --depth 1 https://github.com/morethanwords/tweb.git
cd tweb && pnpm install --frozen-lockfile
# patch src/lib/mtproto/dcConfigurator.ts (front domain rotation, see git history)
pnpm exec vite build          # outputs to dist/, NOT public/!
# copy dist/* into webapp/, then public/assets/* into webapp/assets/
node tools/patch-worker-fronts.js   # re-apply the live-front-list patch to worker bundles
```

## Building the installers

```
npm install
npm run dist            # unsigned: release/fortochka-{setup,portable}-<version>.exe
npm run dist:signed     # + WIN_CSC_KEY_PASSWORD=<pfx password> env var
npm run dist:mac        # on macOS (or CI): release/fortochka-mac-<version>.{zip,dmg}
```

`dist:signed` expects a code-signing PFX at `build/codesign.pfx` (never committed). Create
a self-signed one with `New-SelfSignedCertificate` (CodeSigning), export to PFX, import
the .cer into trusted roots on your machine to see the publisher in UAC. SmartScreen
reputation is separate — it accumulates with downloads.

The macOS build is produced by [.github/workflows/mac.yml](.github/workflows/mac.yml)
(manual dispatch on a GitHub macOS runner): it builds the universal zip + dmg, runs the
smoke test on the runner and uploads the artifacts to the release. Signing is ad-hoc
(`identity: null`) — see the macOS install note above.

## Threat model

**What a front (the community domain operator + Cloudflare) can see:** that your IP talks
to Cloudflare and the SNI of the front domain; the fact, timing and size of WebSocket
traffic to `/apiws`; the DC id from the MTProto obfuscation handshake header.

**What it cannot see:** message content — the WebSocket payload is MTProto,
cryptographically end-to-end between the client and Telegram. The front relays ciphertext
and can break your connection, but not read or meaningfully alter it.

**What Fortochka itself does:** everything runs locally; the local shim only allows
Telegram-related hosts; no telemetry, no analytics, nothing phoning home except the
front-list update (`fronts.json` from this repo) and update checks (GitHub Releases).

**Remaining trust:** front domains are community-run and can disappear or degrade — that
is a liveness risk, not a privacy risk. The health-check routes around dead fronts
automatically. Running a front yourself (`workerDomains` in config) removes third
parties entirely.

## Licenses

- tweb (Telegram Web K): GPL-3.0 — https://github.com/morethanwords/tweb
- tg-ws-proxy-rs: MIT — https://github.com/valnesfjord/tg-ws-proxy-rs
- This wrapper: GPL-3.0-or-later (see [LICENSE](LICENSE))
