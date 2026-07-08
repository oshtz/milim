---
id: release
path: release
label: Release
title: Release and verification
summary: Release artifacts, updater behavior, verification commands, and site build checks.
group: Reference
order: 110
updated: 2026-07-08
---

Release work should verify the Rust workspace, desktop app, site docs, and platform artifacts without reintroducing Linux packaging as a release target.

## Release artifacts

| Platform | Artifact |
|---|---|
| Windows | `milim-windows-x64-portable.exe` from the latest GitHub release. |
| macOS | `milim-macos-universal.dmg` and `milim.app.zip` from the latest GitHub release. |
| Linux | Not packaged as a release artifact. The Rust server and Tauri app remain source-buildable. |

Release builds run desktop verification on both macOS and Windows. macOS release artifacts require the Apple signing secrets and intentionally enable Tauri's macOS private API for transparent preview activity overlay windows. The workflow publishes `manifest.json` plus an aggregate `SHA256SUMS.txt` from the current release run. Updater assets are verified with SHA-256 sidecars and the aggregate checksum file.

## Updater behavior

The desktop app checks GitHub Releases for the latest platform artifact on startup unless it checked within the last 120 minutes, then keeps the existing 12-hour background check cadence. When an update is available, the top bar shows an Update button; confirming it downloads the selected package and checksum through a native Tauri command, verifies SHA-256, stages the package in the local update directory, and hands it to the existing Windows portable EXE or macOS app replacement flow.

## Checks

```powershell Run release checks
cargo test
cargo clippy --workspace --all-targets
pnpm -C apps/desktop verify
pnpm -C apps/site build
```

## Docs site

The public docs site imports markdown from `docs/wiki/*.md` using Vite raw imports. The per-section search index is generated from headings and body text, so new sections become searchable without adding keywords in TypeScript.

Use `docs/account-runtimes.md` as the style template for new long-form reference docs: short intro, route table, then behavior notes.
