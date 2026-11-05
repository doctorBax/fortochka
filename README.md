# Fortochka

[README in Russian](README.ru.md)

**Fortochka** (форточка — the little window you open when the main window is boarded shut) is the
[Telegram Web K](https://github.com/morethanwords/tweb) client — the good-looking web Telegram —
packaged as a native desktop app that keeps working on censored networks. No browser, no Telegram
Desktop, no VPN required.

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

## Why it works where the browser doesn't

On censored networks (TCP drops to `*.web.telegram.org`), Fortochka:

1. **Connects through community Cloudflare fronts** — `kws{dcId}.<front>` domains that proxy
   to Telegram's web endpoints. The front list is **live**: fetched from this repository
   (`fronts.json`), so a new front reaches every user without an app release. A PR is all it takes.
2. **Health-checks every front** (real WebSocket upgrade to `/apiws`, same as the client does),
   ranks by latency, and hands the web app the ranked list at each transport rotation.
3. **Resolves DNS over HTTPS** — provider resolvers commonly poison Telegram and front domains;
   the shim resolves them itself and falls back to the system resolver.
4. **Only ever talks to Telegram**: the CONNECT shim enforces an allowlist
   (`*.telegram.org`, fronts, captcha providers used at login), so a compromised renderer
   cannot exfiltrate data to arbitrary hosts. Local statics are served with a strict CSP.

Subprotocol gotcha: the `/apiws` endpoint **requires the `binary` WebSocket subprotocol** —
without it Telegram answers 404.

## Install

### Windows

Grab the latest installer from
[Releases](../../releases): `fortochka-setup-<version>.exe` (installs to Program Files)
or `fortochka-portable-<version>.exe` (single file, no install). Updates are automatic
(installer build); the portable build tells you when a new release exists.

### macOS

Download `fortochka-mac-<version>.dmg` from [Releases](../../releases) — a universal
build (Intel + Apple Silicon) — open it and drag **Fortochka** to **Applications**.

There is no Apple Developer certificate ($99/yr), so Gatekeeper will stop the first
launch. Clear the quarantine flag once in Terminal:

```
xattr -cr /Applications/Fortochka.app
```

(or right-click the app → **Open** → **Open**). After that it launches like any other
app. On macOS the app is native where it counts: hidden-inset traffic lights, unread
badge on the dock icon, standard `tg://` links, Cmd+C/V/Q — but it does not auto-update
yet, so check [Releases](../../releases) from time to time.

Tray (menubar) icon: open, diagnostics, autostart, quit. Closing the window hides it;
click the dock icon to bring it back. Clicking a `tg://` link anywhere opens it in
Fortochka.

## Diagnostics

Tray menu → **Diagnostics** opens a local page (`http://127.0.0.1:1081/fortochka/diag`) with
live front health (latency per front, source of the list), app state, and buttons:
re-probe fronts, check for updates, open engine log / profile folder.

```
npm run smoke    # headless check: statics + service worker + fronts endpoint + wss + SOCKS bridge
```

## Configuration

Profile lives in `%APPDATA%/fortochka/` (migrated from the pre-release `tgweb-desktop`
automatically). `config.json` is created with defaults on first run:

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

`state.json` (app-managed) keeps window bounds; `fronts-cache.json` is the last good front list.

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

The macOS build is produced by [.github/workflows/mac.yml](.github/workflows/mac.yml)
(manual dispatch on a GitHub macOS runner): it builds the universal zip + dmg, runs the
smoke test right on the runner and uploads the artifacts to the release. Signing is
ad-hoc (`identity: null`) — see the Gatekeeper note above.

`dist:signed` expects a code-signing PFX at `build/codesign.pfx` (never committed). Create a
self-signed one with `New-SelfSignedCertificate` (CodeSigning, CN of your choice), export to
PFX, import the .cer into trusted roots on your machine to see the publisher in UAC.
SmartScreen reputation is a separate thing — it accumulates with downloads.

## Threat model

**What a front (the community domain operator + Cloudflare) can see:** that your IP talks to
Cloudflare and the SNI of the front domain; the fact, timing and size of WebSocket traffic to
`/apiws`; the DC id from the MTProto obfuscation handshake header.

**What it cannot see:** message content — the WebSocket payload is MTProto, cryptographically
end-to-end between the client and Telegram. The front relays ciphertext and can break your
connection, but not read or meaningfully alter it.

**What Fortochka itself does:** everything runs locally; the local shim only allows
Telegram-related hosts; no telemetry, no analytics, nothing phoning home except the front-list
update (`fronts.json` from this repo) and update checks (GitHub Releases).

**Remaining trust:** front domains are community-run and can disappear or degrade — that is a
liveness risk, not a privacy risk. The health-check routes around dead fronts automatically.
Running a front yourself (`workerDomains` in config) removes third parties entirely.

## Licenses

- tweb (Telegram Web K): GPL-3.0 — https://github.com/morethanwords/tweb
- tg-ws-proxy-rs: MIT — https://github.com/valnesfjord/tg-ws-proxy-rs
- This wrapper: GPL-3.0-or-later (see [LICENSE](LICENSE))
