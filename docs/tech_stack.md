# Tech Stack

## Backend

- Node.js
- Express
- Socket.IO
- Baileys
- SQLite via `sql.js` to avoid native addon requirements on shared hosting
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
- Dockerfile for container packaging.
