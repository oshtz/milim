---
id: release
path: release
label: Release
title: Release and verification
summary: Release artifacts, updater behavior, verification commands, and site build checks.
group: Reference
order: 110
updated: 2026-07-04
---

Release work should verify the Rust workspace, desktop app, site docs, and platform artifacts without reintroducing Linux packaging as a release target.

## Release artifacts

| Platform | Artifact |
|---|---|
| Windows | `milim-windows-x64-portable.exe` from the latest GitHub release. |
| macOS | `milim-macos-universal.dmg` and `milim.app.zip` from the latest GitHub release. |
| Linux | Not packaged as a release artifact. The Rust server and Tauri app remain source-buildable. |

Updater assets are verified with SHA-256 sidecars and an aggregate `SHA256SUMS.txt`.

## Updater behavior

The desktop app checks GitHub Releases for the latest platform artifact, then downloads the selected package and checksum through a native Tauri command. The native command verifies SHA-256 before staging the package in the local update directory and handing it to the existing Windows portable EXE or macOS app replacement flow.

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
