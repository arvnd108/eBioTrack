-- Owner: A (Backend)
-- Purpose: Session store table for express-session (connect-pg-simple)
--
-- Not part of the contract's slice tables. It must exist after 090 so db:reset and CI build it.
-- Column layout is the one connect-pg-simple expects (table "session"). The sess JSON holds
-- the cookie settings and { user_id } only; no roles, no password hash.
-- Sessions are infrastructure, not scientific records, so rows are deleted on logout and expiry.

CREATE TABLE session (
    sid    varchar NOT NULL,
    sess   json NOT NULL,
    expire timestamp(6) NOT NULL,
    CONSTRAINT pk_session PRIMARY KEY (sid)
);

-- Expired-session pruning scans by expire.
CREATE INDEX idx_session_expire ON session (expire);
