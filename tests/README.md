# README

> **Owner:** C (Testing & QA)
>
> How to run the `tests/` suites

```bash
docker compose up -d db && cp -n .env.example .env   # once, from the repo root
cd tests && npm ci
npm test                    # everything (serial; migrates and seeds ebiotrack_test first)
npm run test:smoke          # one suite (also: integrity, queries, transactions, concurrency, authorization, recovery)
npm run lint && npm run format
```

If the database is unreachable, DB suites are skipped locally with a message. With `CI=true` the run fails instead.
