# Releasing Sidekick LLM

How to produce installers, and what must be bought or configured before shipping to
anyone outside your own machine.

## Build an installer

```bash
npm run dist:win     # Windows NSIS installer  → release/
npm run dist:mac     # macOS dmg               (must run ON macOS)
npm run dist:linux   # Linux AppImage          (Linux or WSL)
npm run pack         # unpacked build, no installer — fast smoke test
```

Output lands in `release/` (git-ignored). A Windows build currently produces:

| File | What it is |
|---|---|
| `Sidekick LLM Setup <version>.exe` | the installer (~114 MB) |
| `latest.yml` | auto-update manifest |
| `*.blockmap` | enables differential (delta) updates |

Regenerate the app icon with `npm run icon` (source: `build/make-icon.cjs`).

### Cross-platform reality
electron-builder **cannot** build a signed macOS app from Windows. Mac builds need
macOS (a CI runner is the usual answer). Linux can be built from Windows via WSL or
CI. Plan on GitHub Actions with a matrix if you want all three.

---

## ⚠️ Code signing — required before distributing

**The installer is currently unsigned.** `Get-AuthenticodeSignature` reports
`NotSigned`. What that means in practice:

- Windows SmartScreen shows **"Windows protected your PC"** and hides the Run button
  behind *More info*. A large share of users stop there.
- Antivirus false positives are far more likely.
- macOS Gatekeeper will simply refuse to open an unsigned, un-notarized app.

This is the one part of shipping that cannot be solved in code — **it requires
buying a certificate.**

### Windows

| Option | Cost (approx/yr) | SmartScreen behaviour |
|---|---|---|
| **OV** (Organization Validation) | $200–400 | Warning persists until reputation is built |
| **EV** (Extended Validation) | $300–600 | Immediate SmartScreen trust; usually needs a hardware token/HSM |

Note: since June 2023, Windows code-signing keys must live on certified hardware
(token or cloud HSM), so signing from CI needs a cloud signing service
(e.g. Azure Trusted Signing, SSL.com eSigner, DigiCert KeyLocker).

Once you have one, electron-builder picks it up from the environment — no config
change needed:

```
CSC_LINK=<path-or-base64 of the .pfx>
CSC_KEY_PASSWORD=<password>
```

### macOS
Requires an **Apple Developer Program** membership ($99/yr), a *Developer ID
Application* certificate, and **notarization**:

```
APPLE_ID=<your apple id>
APPLE_APP_SPECIFIC_PASSWORD=<app-specific password>
APPLE_TEAM_ID=<team id>
```

### Linux
No signing requirement for AppImage.

---

## Auto-update

`electron-updater` is wired in `electron/main.cjs` and is deliberately conservative:

- **Only runs in a packaged app** (`app.isPackaged`), never in development.
- **`autoDownload = false`** — it checks, it does not consume bandwidth unasked.
- **Every failure is swallowed.** An offline user must still get a working app; that
  is the entire premise of the product.
- Disable entirely with `SIDEKICK_DISABLE_UPDATES=1`.

### To actually enable it
Add a publish target to the `build` block in `package.json`, e.g. GitHub Releases:

```json
"publish": [
  { "provider": "github", "owner": "<you>", "repo": "sidekick_llm" }
]
```

Then publish with `GH_TOKEN=<token> npx electron-builder --win --publish always`.
Until a publish target exists, the update check simply no-ops — which is why the
current build is safe to hand out for testing.

**Auto-update requires signing on Windows and macOS.** Unsigned updates are rejected
by the updater, so signing is a hard prerequisite, not a nicety.

---

## Pre-release checklist

- [ ] `npm test` green (76 tests)
- [ ] `npm run audit:prod` clean
- [ ] Version bumped in `package.json`
- [ ] Built installer launches on a machine that has **never** run the app
      (checks: no missing native module, database created, no dev-only paths)
- [ ] Code signing configured (see above) — **blocks public release**
- [ ] EULA / privacy policy / medical-legal disclaimers shipped (Stage 5, outstanding)
- [ ] Licence activation implemented if selling (Stage 5, outstanding)

## Known packaging notes

- Native modules (`better-sqlite3`, `better-sqlite3-multiple-ciphers`) are excluded
  from the asar via `asarUnpack: ["**/*.node"]`. They will not load from inside an
  asar archive — verified in the packaged build.
- `postinstall` runs `electron-rebuild` for **both** SQLite modules. Any new native
  dependency must be added there, or it will load in development and fail when
  packaged.
- Installer size is ~114 MB, dominated by the Electron runtime. That is normal.
