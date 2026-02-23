# GDrive / ODrive — Security Audit & Overhaul Outline

This document is a **forward-looking** outline for updating and overhauling the project with practical security, reliability, and UX improvements.

## 1) Current State (what’s already in place)

### Security hardening already implemented
- Electron renderer hardening (`nodeIntegration: false`, `contextIsolation: true`) with a `preload.js` IPC bridge.
- OAuth credentials support via environment variables (`.env.example`), avoiding committing secrets.
- Basic HTTP security headers in the local Express server.
- Input validation for account IDs and local sync folder paths.

See: `SECURITY_IMPROVEMENTS.md` and `ASSESSMENT_SUMMARY.md`.

### Reliability/build fixes implemented as part of this audit
- Webpack dependency alignment and config modernization (CopyWebpackPlugin v13 options schema).
- Replaced deprecated/unmaintained `node-sass` with `sass`.
- Postinstall no longer tries to rebuild Electron native deps (avoids network-dependent `node-gyp` in restricted environments).
- Replaced vulnerable, unmaintained NeDB dependency chain with `@seald-io/nedb` and an internal promise wrapper (`app/core/db.js`).

## 2) Threat Model (what we’re protecting)

### Primary risk areas
- **Renderer compromise (XSS)** → native OS access via Electron APIs (high impact).
- **Local web server abuse** (Express on localhost) → CSRF-style actions (e.g., OAuth callback / settings changes).
- **Sensitive data exposure** (OAuth tokens, refresh tokens, account metadata).
- **Supply-chain risk** (outdated dependencies, vulnerable transitive deps).

## 3) 🚨 Priority 0 (Must-do security work)

1. **Upgrade Electron**
   - Current Electron is very old and misses years of security patches.
   - Target: modern Electron (and adjust `contextBridge`/preload usage as needed).

2. **OAuth CSRF protection**
   - Add and validate a `state` parameter through the OAuth flow (request → callback).

3. **Harden Express security headers**
   - Replace custom header middleware with `helmet` (CSP, frameguard, noSniff, etc.).
   - Tighten CSP (avoid `unsafe-inline` if possible; move inline scripts to files / use nonces).

4. **Dependency risk reduction**
   - Track `npm audit --omit=dev` in CI and keep prod vulnerabilities near-zero.
   - Consider pinning with a lockfile for reproducibility.

## 4) Priority 1 (Reliability & data integrity)

1. **Crash-safe sync + resumability**
   - Persist sync state, resume on restart without re-downloading everything.
2. **Conflict handling**
   - Detect and resolve local-vs-remote conflicts (rename strategy + UI prompt).
3. **Atomic writes**
   - Ensure downloads write to temp + rename to prevent partial/corrupt files.
4. **Backpressure and quota awareness**
   - Centralize Google API throttling with exponential backoff + jitter.

## 5) Priority 2 (Useful product features)

1. **Selective sync**
   - Allow including/excluding folders (and file-type filters).
2. **Multi-account support**
   - The UI currently says “not yet supported”; implement proper account isolation.
3. **Bandwidth / CPU limiting**
   - “Low impact mode” and schedule-based sync windows.
4. **User-visible audit log**
   - Sync history (downloaded/updated/deleted) with exportable logs.

## 6) Priority 3 (Engineering excellence)

1. **Testing**
   - Unit tests for path validation, DB wrapper, sync planning logic.
   - Integration tests with a mocked Google Drive API client.
2. **Observability**
   - Structured logging with log levels; avoid noisy console logs.
3. **Security automation**
   - CI: `npm audit --omit=dev`, CodeQL (JS), dependency review.

## 7) Suggested migration strategy (lowest risk)

1. Upgrade dependencies in small batches (Electron separately).
2. Add CSRF `state` to OAuth.
3. Replace custom headers with `helmet` and iteratively tighten CSP.
4. Improve sync reliability (atomic writes + resumable state).
5. Add selective sync + multi-account support.

