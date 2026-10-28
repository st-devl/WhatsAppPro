# Tech Stack

## Backend

- Node.js
- Express
- Socket.IO
- Baileys
- SQLite via Node's built-in `node:sqlite` (`DatabaseSync`) with `sql.js` WASM fallback for runtimes where the built-in driver is unavailable; neither option needs a native addon
- `pino` structured logging

## Frontend

- Server-rendered static HTML.
- Modular browser JavaScript.
- Tailwind CSS build output.
- Playwright for browser E2E tests.

## Test and DevOps

- Node test runner for unit/integration tests.
- Playwright for UI E2E.
- GitHub Actions CI.
- Hostinger Passenger production deployment.
