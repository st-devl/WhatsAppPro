# Decision Log

## SQLite Runtime

Decision: use SQLite through `sql.js` with explicit export-on-write persistence.

Reason: the production host does not support Docker Compose or native Node addon builds. `sql.js` keeps the existing relational schema and migrations while removing GLIBC, symlink, and node-gyp requirements.

## Minimal Modular Frontend

Decision: keep the frontend as modular browser JavaScript instead of adding Vite/TypeScript immediately.

Reason: the current app can be stabilized faster without introducing a build pipeline beyond Tailwind CSS.

## DB-Backed Campaign State

Decision: persist campaign runs and recipients in SQLite.

Reason: campaign progress must survive page refreshes and support stop/resume/retry flows.

## Redis Deferred

Decision: document Redis cache/session targets but do not introduce Redis yet.

Reason: Redis is required for horizontal scaling, not for the current single-instance staging target.
