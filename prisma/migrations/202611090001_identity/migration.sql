CREATE TABLE users (id UUID PRIMARY KEY, email VARCHAR(254) NOT NULL UNIQUE, name VARCHAR(100) NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE', CONSTRAINT users_status CHECK (status IN ('ACTIVE','SUSPENDED')));
CREATE TABLE identities (id UUID PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE, UNIQUE(issuer,subject));
CREATE TABLE sessions (id UUID PRIMARY KEY, token_hash CHAR(64) NOT NULL UNIQUE, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE, idle_expires_at TIMESTAMPTZ(3) NOT NULL, absolute_expires_at TIMESTAMPTZ(3) NOT NULL, revoked_at TIMESTAMPTZ(3), CONSTRAINT sessions_expiry CHECK (idle_expires_at<=absolute_expires_at));
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_absolute_expires_at_idx ON sessions(absolute_expires_at);
CREATE TABLE auth_attempts (token_hash CHAR(64) PRIMARY KEY, payload TEXT NOT NULL, expires_at TIMESTAMPTZ(3) NOT NULL);
CREATE INDEX auth_attempts_expires_at_idx ON auth_attempts(expires_at);
