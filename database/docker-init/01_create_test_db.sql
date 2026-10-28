-- Owner: A (Backend)
-- Purpose: Create the test database used by Vitest and CI (name is part of the team contract: ebiotrack_test)
-- Runs once, on first start of an empty data volume. To re-run: docker compose down -v
CREATE DATABASE ebiotrack_test OWNER ebiotrack;
