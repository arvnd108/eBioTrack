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

| `VITE_USE_MOCK` in `.env.local` | Data comes from                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `true` (default)                | `src/services/mock/mockApi.ts`. No backend needed. Sign in as any fixture user (`<role>@ebiotrack.test`) with any password. |
| `false`                         | The Express backend on port 4000. Vite forwards `/api` to it (see `vite.config.ts`).                                        |

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
