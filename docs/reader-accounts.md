# Reader account management

Readers → Reader accounts automatically lists existing accounts, with creation dates and pagination (25 per page). Create distinct accounts for different people/readers, or reuse one account across devices that should share reading progress. All accounts see the same book library; progress, positions, annotations and document metadata remain scoped to username.

Change password opens an inline editor for that named account. Passwords must be 16–128 characters and are cleared from the form on submission/cancellation. Only a fresh salt and PBKDF2 verifier of the required client-compatible MD5 key are stored. Old credentials stop authenticating for new OPDS/download and KOSync/CrossPoint requests. Existing progress is preserved; every device using the account needs the new password.

Delete… opens a confirmation naming the account and explaining permanent removal of progress, per-device positions, bookmarks/clippings and document metadata. A single D1 DELETE uses existing foreign-key cascades. Other accounts, shared book records and R2 originals remain intact. This is account deletion, not simply removing one physical device from a shared account.

Admin routes (require the existing allowlisted browser session; reader credentials grant no administration):

- GET /api/admin/accounts?page=1 returns accounts (username/created only), total and page.
- POST /api/admin/accounts creates an account.
- PATCH /api/admin/accounts/:username accepts {password}.
- DELETE /api/admin/accounts/:username deletes the account and its sync data.

Usernames are URL-encoded by the UI. Writes retain same-origin enforcement. Invalid passwords return 400; unknown accounts 404; duplicate creation 409. No password, salt or verifier is returned in the list.

The lifecycle test signs in through the simulated local Better Auth email flow, creates two distinct accounts, checks admin-only list/rotation/deletion and cross-origin denial, verifies salt/verifier replacement and old credential rejection, preserves both accounts' reading progress during rotation, exercises pagination, and deletes one account. It verifies cascading removal in accounts/progress/device_progress/documents/annotations, unchanged other-account authentication/progress, and byte-exact download of the retained R2 book through the other account. All writes are to disposable local emulated bindings.

See [verification](verification.md) for local test coverage.
