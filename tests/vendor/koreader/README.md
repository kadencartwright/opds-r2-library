Test-only unmodified KOReader sources (AGPL-3.0; COPYING included):

- v2026.07 tag resolves to commit 1e2fa5f1239028ab4b37acae833cdc86a71e5258: plugins/opds.koplugin/opdsbrowser.lua, plugins/opds.koplugin/opdsparser.lua, frontend/luxl.lua.
- v2026.07.2, commit 9192014d8bd82a91dc1012473be0f238dedfdb54: plugins/opds.koplugin/opdsbrowser.lua, plugins/opds.koplugin/opdsparser.lua, frontend/luxl.lua.
- master as inspected 2026-11-08, commit 9040116701c888889bd35233b23b83283be66745: plugins/opds.koplugin/opdsbrowser.lua, plugins/opds.koplugin/opdsclient.lua, plugins/opds.koplugin/opdsparser.lua (in this directory), frontend/luxl.lua (in this directory).
- Origin: https://github.com/koreader/koreader

Only tests load this code. It is not part of the deployed Worker or FoldKit assets. tests/koreader-harness.lua supplies UI/device stubs but uses the actual feed HTTP, parsing, menu selection, sync enumeration and download methods. HTTP is real LuaSocket against workerd, with actual Basic authentication; JSON uses lua-cjson and XML uses KOReader's own luxl/OPDSParser. The stock distro LuaSocket ignores KOReader's response_headers extension; these tests require and confirm direct responses without redirects. This is not full device emulation or a test of Kindle TLS.

On Debian/Ubuntu install luajit, lua-socket and lua-cjson, then run pnpm build && pnpm test. Without luajit the native compatibility subtest explicitly skips, while TypeScript/emulated-binding tests still run. No network fetch is needed at test runtime. lua-sec is only needed for separate HTTPS probes.
