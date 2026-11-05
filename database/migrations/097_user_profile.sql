-- Owner: A (Backend)
-- Purpose: users: optional profile details collected at self-registration
--
-- Follow-up to 010 (already applied everywhere), so it is its own numbered migration. All three
-- columns are nullable: only full name, email and password are required to register.
ALTER TABLE users
    ADD COLUMN organization text,
    ADD COLUMN job_title    text,
    ADD COLUMN phone        text,
    ADD CONSTRAINT ck_users_organization_not_blank CHECK (organization IS NULL OR btrim(organization) <> ''),
    ADD CONSTRAINT ck_users_job_title_not_blank    CHECK (job_title IS NULL OR btrim(job_title) <> ''),
    ADD CONSTRAINT ck_users_phone_not_blank        CHECK (phone IS NULL OR btrim(phone) <> '');

COMMENT ON COLUMN users.organization IS 'Optional: institution or company, given at registration.';
COMMENT ON COLUMN users.job_title    IS 'Optional: position or title, given at registration.';
COMMENT ON COLUMN users.phone        IS 'Optional: contact phone number, given at registration.';
