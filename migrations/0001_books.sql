CREATE TABLE books (
 id TEXT PRIMARY KEY,
 object_key TEXT NOT NULL UNIQUE,
 title TEXT NOT NULL,
 authors TEXT NOT NULL,
 filename TEXT NOT NULL,
 media_type TEXT NOT NULL,
 size INTEGER NOT NULL,
 modified TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','deleting'))
);
CREATE INDEX books_title ON books(title COLLATE NOCASE);
CREATE INDEX books_state ON books(state, id);
