CREATE TABLE device_progress (
 username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
 document TEXT NOT NULL, device_key TEXT NOT NULL,
 payload TEXT NOT NULL, timestamp INTEGER NOT NULL,
 sequence INTEGER NOT NULL,
 PRIMARY KEY(username,document,device_key)
);
CREATE INDEX device_progress_winner ON device_progress(username,document,timestamp DESC,sequence DESC);
CREATE TABLE sync_clock (id INTEGER PRIMARY KEY CHECK(id=1), sequence INTEGER NOT NULL, bookmark_time INTEGER NOT NULL);
INSERT INTO sync_clock VALUES(1,0,0);
INSERT INTO device_progress SELECT username,document,coalesce(json_extract(payload,'$.device_id'),json_extract(payload,'$.device')),payload,timestamp,rowid FROM progress;
UPDATE sync_clock SET sequence=coalesce((SELECT max(sequence) FROM device_progress),0);
CREATE TABLE documents (
 username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
 document TEXT NOT NULL, title TEXT, author TEXT, filename TEXT, language TEXT, filesize INTEGER, updated_at INTEGER NOT NULL,
 PRIMARY KEY(username,document)
);
CREATE TABLE annotations (
 username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
 document TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('bookmarks','clippings')),
 id TEXT NOT NULL, payload TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL, revision INTEGER NOT NULL,
 PRIMARY KEY(username,document,kind,id)
);
CREATE INDEX annotation_delta ON annotations(username,document,kind,updated_at,revision);
