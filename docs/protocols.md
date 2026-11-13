# Reader sync protocols

## Protocol support matrix

All sync endpoints use the same accounts, x-auth-user and x-auth-key headers, D1 and progress service. Responses are application/json; the KOReader vendor Accept header is accepted but not required. JSON parsing does not gate on request Content-Type.

| Endpoint | Implemented behavior |
|---|---|
| POST /users/create | 201 username; duplicate 402/2002; invalid 403/2003 |
| GET /users/auth | 200 authorized=OK; bad/missing credentials 401/2001 |
| PUT /syncs/progress | Stock KOSync fields plus optional rich position/metadata |
| GET /syncs/progress/:document | Newest device position; unknown is **200 {}** |
| GET /healthcheck | state=OK |
| GET /healthz | status=ok, version=0.1.0 (wire compatibility version) |
| PUT /api/v1/progress | CompactPosition and optional capped read timestamp |
| GET /api/v1/progress/:document | Per-device positions newest first, null position for plain clients |
| GET /api/v1/progress | Winning positions with metadata; limit 100/max 500, timestamp:document cursor |
| PUT /api/v1/documents | Validated batch of 1–50 metadata entries |
| GET /api/v1/documents | Newest first, default/max 500, cursor pagination |
| GET/PUT /api/v1/bookmarks/:document | Batch upserts, incremental timestamp deltas, tombstones |
| GET/PUT /api/v1/clippings/:document | Batch upserts, tombstones, v2 revision cursors and reader format |
| GET /api/admin/sync | Admin-only combined diagnostics |
| PUT /api/admin/mapping | Admin-only verified document-to-library mapping |

**Not implemented:** stats endpoints, progress batch/changes, document merge/status/dates/info/cover lookup, annotation-wide listing, password/account deletion, external connectors, Hardcover, profile, reading history/import, sessions and background fanout. Unsupported paths return 404, rather than fabricated results. This is a tested subset, not CrossPoint server parity.

### Authentication and compatibility choices

The incoming password field/key is already the client's MD5 (opaque credential for legacy compatibility). Only a salted PBKDF2-SHA256 verifier (100,000 rounds) is stored. It is never returned/logged. This does not fix the legacy bearer credential on the wire: use HTTPS for any production service.

Root KOSync behavior takes precedence where upstreams differ: disabled signup returns stock 402/2005, while CrossPoint's current doc says 403/2003. Usernames/keys accept broader nonempty legacy values (username cannot contain colon; both capped at 256 chars) rather than requiring CrossPoint's narrower username/MD5 regex. Document IDs use CrossPoint's 1–64 ASCII letters/digits/dot/underscore/hyphen format. Invalid document 403/2004, invalid sync fields 403/2003. Rate limiting outside local mode is D1-backed, 60 signup/authenticated sync requests per IP/minute, before expensive verification; 429/code 2001. Local testing disables it. Reader HTTP Basic requests share this limiter. It is a small-server safeguard, not a full edge abuse system.

### Rich progress

Stores one row per account/document/device ID, falling back to device name. The root GET selects newest timestamp, then server sequence for ties; even a lower percentage can win. Root PUT ignores client timestamps, using server Unix seconds. Extended PUT honors valid read times after 2000, capped at now; older same-device updates cannot replace newer rows.

CompactPosition validates pctQ 0–1,000,000; spine/page/pages/para/li uint16; anchor at most 48 UTF-8 bytes; xpath at most 120. Invalid position is ignored while valid KOSync fields still sync. A missing/invalid position preserves that device's existing rich position; another plain device cannot erase it. Preserved rich data may describe an older position after a downgrade; consumers must use normal progress fields for that plain update. No conversion between XPath, CFI and rich coordinates is guessed.

Progress string is capped at 4096 bytes; device fields 128 characters; request JSON 32 KiB. Known metadata fields title/authors/filename/language are bounded to 512 characters. Omitted values preserve prior metadata; language only fills a blank. Invalid language tags are ignored. No external service-ID lookup is performed.

### Bookmarks and clippings

PUT takes items (1–50), validates the complete batch, then writes in one D1 batch transaction. IDs are client-computed first 16 SHA-256 hex characters (bookmark XPath; clipping created_at_decimal + text). Server checks ID format, not correspondence to text, permitting deletion by ID alone.

Bookmark XPath at most 512 characters; summary truncated to 256; si/pc/pp nullable uint16. GET since/limit defaults to 0/50; max 100, oldest first, items/until/more including deleted=1 tombstones. To avoid dropping items with equal-second timestamps at pagination boundaries, bookmark updated_at/until is a persisted server-allocated **monotonic Unix-second cursor**. Under rapid writes it can run ahead of wall clock (one tick per item); treat it as an opaque sync cursor, never a reading-event timestamp. This is an explicit MVP difference from the reference's wall-clock timestamp collision behavior.

Clippings retain layout hints, para, paired start/end codepoint offsets, text up to 4096 UTF-8 bytes, chapter 64 characters, note 4096 bytes, color 64 characters. The current API.md limits table conflicts with its clipping section (2048 versus 4096 text bytes); this implementation follows the actual route's 4096-byte limit. Omitted note/color are retained. Tombstoned clipping IDs cannot be resurrected by delayed uploads.

Use **cursor=0&limit=50&format=reader** for clipping sync: response has sync_version=2, revision per item, monotonic cursor, more. Repeat with returned cursor. Reader format omits note/color. Legacy since remains supported but shares the upstream same-second limitation; revision mode is preferred and tested. Tombstones are retained indefinitely. Annotation request bodies are capped at 512 KiB.

### Privacy and book identity

No metadata is inferred when a device disables Send Metadata. Uploaded SHA-256 IDs are **not** KOReader partial-file MD5 or filename digests. No automatic match by filename or guessed hash. A position remains a separate account/document identity until explicitly verified.

The UI mapping field takes: username document-digest book-id. It validates that a progress record and ready library book exist; the administrator is responsible for proving the identity first. Deleting a library book clears its mapping but keeps reader progress. No digest algorithm has been advertised as verified against real firmware.
