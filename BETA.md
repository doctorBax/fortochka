# Fortochka Beta — независимые экспериментальные релизы

Это **вторая линия релизов**, а не замена стабильной Fortochka.

| | Stable | Beta |
| --- | --- | --- |
| Git branch | `main` | `beta` |
| GitHub release | `v0.2.7` | `v0.2.8-beta.N` |
| Release status | normal / latest | prerelease; never latest |
| Windows name | Fortochka | Fortochka Beta |
| Windows app ID | `io.github.doctorbax.fortochka` | `io.github.doctorbax.fortochka.beta` |
| Profile on Windows | `%APPDATA%/fortochka` | `%APPDATA%/fortochka-beta` |
| Profile on macOS | `~/Library/Application Support/fortochka` | `~/Library/Application Support/fortochka-beta` |
| `tg://` protocol registration | stable installer | **not registered** by beta |

Stable and Beta can be installed side-by-side. Telegram sessions, Service Workers,
caches, window state and local port configurations are stored separately. The beta
does not migrate or modify the stable profile. Both may use the same ports as
preferences; runtime selection chooses free ports if another instance is running.

## Publish a prerelease

Each **push to the `beta` branch** triggers
`.github/workflows/beta-release.yml`, which builds Windows x64 (NSIS + portable)
and macOS universal (DMG + ZIP) in parallel and creates a GitHub **Prerelease**.

A beta is labeled `v<next-stable-base>-beta.<GitHub run number>` and is never
marked `latest`. For example: `v0.2.8-beta.22`. If either build fails,
there is no new release. **Unit tests and end-to-end tests are not required to pass
to publish experimental builds**. Dependencies must still install and binaries
must package successfully.

To push:
```bash
git switch beta
git merge --no-ff feature/my-experiment
git push origin beta
```

Every push starts a new workflow run; the newest run cancels older in-progress
beta workflows. For a one-off experiment without release, push to a different
feature branch instead.

## How it is isolated

`tools/prepare-beta.js` is run **only in CI after `npm ci`** and generates
ephemeral beta package metadata: a distinct package name, appId, installer identity,
shortcut names, file names and semver prerelease version. The committed
`package.json` remains stable-form for local development.

`main.js` detects the beta package name, selects the dedicated
`fortochka-beta` userData path **before** taking the single-instance lock,
and disables registration of the system `tg://` handler.

The Beta client manually checks prerelease versions using the GitHub Releases
history endpoint, while the Stable client continues to check only stable
releases. Automatic downloading/installation is disabled in both editions.
No release signing or notarization is configured. Treat beta binaries as
untrusted/experimental and install on a test computer or separate user account
if stability of existing data is important.

## Operational notes

- When the stable release base moves from `0.2.7` to `0.2.8`, update
  the committed `package.json` in `beta` to `0.2.8` so the next betas
  become `0.2.9-beta.N`.
- GitHub runs may fail if repo Actions permissions disallow release writes;
  the release job needs `contents: write`.
- A release is published only **after both platform builds succeed**.
- Stable `main` and its normal GitHub releases are never changed by this workflow.
