# Third-party notices

Application dependencies are declared in `package.json` and pinned in `pnpm-lock.yaml`; each dependency retains its own license.

The following upstream artifacts are vendored for tests only and are not bundled into the deployed Worker or UI:

- **KOReader** Lua sources: AGPL-3.0; see `tests/vendor/koreader/COPYING` and its README for source paths, pinned commits, and test usage.
- **KOSync conformance verifier**: BSD-3-Clause; see `tests/vendor/LICENSE-kosync`, `tests/vendor/README.md`, and `tests/vendor/kosync-commit.txt`.
- **Readium web publication schemas**: BSD-3-Clause; see `tests/vendor/readium/LICENSE` and `tests/vendor/readium-commit.txt`.
- **OPDS schemas**: from opds-community/specs; source and commit are recorded in `tests/vendor/README.md` and `tests/vendor/opds-commit.txt`. Original schema identifiers and metadata are preserved.

Upstream notices apply to their respective files. This document does not relicense third-party code.
