CREATE TABLE accounts (username TEXT PRIMARY KEY, salt TEXT NOT NULL, verifier TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE progress (
 username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
 document TEXT NOT NULL,
 payload TEXT NOT NULL,
 timestamp INTEGER NOT NULL,
 book_id TEXT REFERENCES books(id) ON DELETE SET NULL,
 PRIMARY KEY(username, document)
);
CREATE TABLE throttle (identity TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
