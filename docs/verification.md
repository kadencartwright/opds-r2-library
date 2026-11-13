# Verification

Run from a clean checkout with Node.js 24+ and pnpm 11.20.0:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

The build performs a Wrangler deployment dry run; it does not upload or require production credentials. Tests use disposable local Miniflare/workerd D1 and R2 bindings. No production state, accounts, or book files are required.

Coverage includes:

- EPUB/PDF validation, metadata extraction, and bounded archive handling.
- Byte-exact downloads, duplicate uploads, metadata/search, and storage cleanup.
- Private OPDS 1.2/2.0 feeds, schemas, authentication, HEAD probes, search, and pagination.
- KOSync conformance and CrossPoint progress, annotations, cursors, and isolation.
- Browser email authentication, allowlists, session revocation, and cross-origin denial.
- Reader account pagination, password rotation, and cascading account deletion.
- MCP OAuth PKCE, consent, scope enforcement, and attachment URL restrictions.

Native compatibility tests exercise pinned KOReader Lua sources over real local HTTP, with UI/device components stubbed. Install `luajit`, `lua-socket`, and `lua-cjson` to run them; without LuaJIT, that subtest explicitly skips. See [source pins and limitations](../tests/vendor/koreader/README.md).

Integration tests consume `dist-worker/worker.js`, so build first. Run one suite at a time: the verifier uses TCP port 8790. Reports under `test-results/` are ignored by Git.

GitHub Actions runs these checks with the native Lua dependencies installed. Physical readers, device TLS, Cloudflare email delivery, and actual MCP host attachment support require separate verification on your installation.
