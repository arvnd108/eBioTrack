# eBioTrack frontend

React + TypeScript + Vite app (owner: B). It talks only to `/api`; it never touches the database.

## Run it

```bash
cd frontend
npm ci                      # install exactly what package-lock.json lists
cp .env.example .env.local  # optional: mock mode is on by default
npm run dev                 # http://localhost:5173
```

### Mock mode vs real backend

| `VITE_USE_MOCK` in `.env.local` | Data comes from                                                                                                                                                                                                                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `true` (default)                | `src/services/mock/mockApi.ts`. No backend needed. Sign in as a seeded user (`<role>@ebiotrack.test`) with the development password from `tests/fixtures/README.md`, or click a user in the list under the login form. Login answers (validation, wrong password, 5-failure lockout) match the real API. |
| `false`                         | The Express backend on port 4000. Vite forwards `/api` to it (see `vite.config.ts`).                                                                                                                                                                                                                     |

The mock answers every GET endpoint in `planning/CONTRACT.md` section 10, plus the section 11 write examples (login, logout, create event, import dry run, export), with the same pagination, project-visibility, role, and approved-only rules as the real API. Its data copies the seed files where they exist (`database/seeds/010`, `020`) and follows the section 6 fixture world elsewhere; update `src/services/mock/fixtures.ts` when the lab and analysis seeds land. To mock another endpoint, add one entry to `routes` in `mockApi.ts`. Pages call the same service functions in both modes, so switching to the real backend needs no page changes.

## Scripts

| Command                         | What it does                                   |
| ------------------------------- | ---------------------------------------------- |
| `npm run dev`                   | Dev server with hot reload                     |
| `npm run build`                 | Type-check, then production build into `dist/` |
| `npm run typecheck`             | Type-check only                                |
| `npm run lint`                  | ESLint (CI runs this)                          |
| `npm test`                      | Vitest unit tests                              |
| `npm run format` / `format:fix` | Check / apply Prettier formatting              |

## Layout

| Path                                                     | Contents                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/main.tsx`, `App.tsx`, `routes.tsx`, `navigation.ts` | Entry point, signed-in layout, route table, sidebar links                                       |
| `src/services/`                                          | `apiClient.ts` (fetch wrapper, `ApiError`, mock switch), one service file per API area, `mock/` |
| `src/context/`, `src/hooks/`                             | Auth state (`useAuth`) and shared hooks                                                         |
| `src/components/`                                        | `layout/`, `common/`, `charts/`, `maps/`                                                        |
| `src/pages/`                                             | One file per page (see `planning/roles/ROLE_B_FRONTEND.md`)                                     |
| `src/types/index.ts`                                     | Types that mirror the API contract; keep in step with `CONTRACT.md`                             |

## Shared building blocks (T24)

Use these on every page so all pages look and behave the same.

| Piece                                                        | Use it for                                                                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `components/common/DataTable`                                | Lists: loading, empty and error states, API sorting (`?sort=`), pagination from `meta`                                           |
| `components/common/FormField` + `fieldControlClass()`        | Every form input: label, hint, error message, screen-reader wiring                                                               |
| `components/common/LoadingState`, `EmptyState`, `ErrorState` | The three states of anything that loads; `ErrorState` words every API error code in plain language (`services/errorMessages.ts`) |
| `components/common/CaveatBanner`                             | **Every** analytics and species page; pass the response's `meta.caveat`                                                          |
| `components/common/Can`                                      | Showing a button or link only to roles allowed to use it                                                                         |
| `hooks/useFetch`                                             | Loading one GET endpoint into `data` / `meta` / `status` / `error`, with `reload()`                                              |
| `hooks/usePagination`                                        | Page, limit and sort state turned into the CONTRACT 8 query                                                                      |
| `hooks/useAuth`                                              | The signed-in user, `login`, `logout`, `can(action, projectRole?)`                                                               |

`src/permissions.ts` copies the API's permission matrix (`backend/src/middleware/permissions.js`, CONTRACT 9) with the same action names. A test compares the two files, so update both together. Hiding something in the UI is only a convenience: the API still refuses what a role cannot do.
