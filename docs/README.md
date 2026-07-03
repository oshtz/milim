# milim docs

This folder holds repo-maintained docs. The public docs wiki source lives in `wiki/*.md`; `../apps/site/src/DocsPage.tsx` imports those markdown files with Vite raw imports and builds its section search from the same headings and body text.

Use `account-runtimes.md` as the template for deeper per-feature reference docs: short intro, route table, then behavior notes.

Build the docs site from the repo root with:

```powershell
pnpm -C apps/site build
```

CLI client commands (`status`, `models`, `run`, and `mcp`) call a running server and accept `--url`, `--port`, and `--token`; `MILIM_API_TOKEN` supplies the token by environment.
