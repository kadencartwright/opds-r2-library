CREATE TABLE web_user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL, image TEXT, createdAt DATE NOT NULL, updatedAt DATE NOT NULL);
CREATE TABLE web_session (id TEXT PRIMARY KEY, expiresAt DATE NOT NULL, token TEXT NOT NULL UNIQUE, createdAt DATE NOT NULL, updatedAt DATE NOT NULL, ipAddress TEXT, userAgent TEXT, userId TEXT NOT NULL REFERENCES web_user(id) ON DELETE CASCADE);
CREATE INDEX web_session_user ON web_session(userId);
CREATE TABLE web_account (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL, userId TEXT NOT NULL REFERENCES web_user(id) ON DELETE CASCADE, accessToken TEXT, refreshToken TEXT, idToken TEXT, accessTokenExpiresAt DATE, refreshTokenExpiresAt DATE, scope TEXT, password TEXT, createdAt DATE NOT NULL, updatedAt DATE NOT NULL);
CREATE INDEX web_account_user ON web_account(userId);
CREATE TABLE web_verification (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expiresAt DATE NOT NULL, createdAt DATE NOT NULL, updatedAt DATE NOT NULL);
CREATE INDEX web_verification_identifier ON web_verification(identifier);
CREATE TABLE web_rate_limit (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, count INTEGER NOT NULL, lastRequest BIGINT NOT NULL);
CREATE TABLE local_mail (id TEXT PRIMARY KEY, recipient TEXT NOT NULL, url TEXT NOT NULL, created INTEGER NOT NULL);
