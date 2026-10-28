# Runtime

## Processes

The application currently runs as one Node.js process:

```bash
npm --prefix whatsapp-engine start
```

## Health Endpoints

- `/healthz`: process liveness.
- `/readyz`: database/readiness check.
- `/healthz/details`: diagnostic runtime payload.

## Persistent Paths

- `WHASAPPC_DATA_DIR/database.sqlite`
- `WHASAPPC_DATA_DIR/database.sqlite-wal` and `WHASAPPC_DATA_DIR/database.sqlite-shm` while the Node SQLite driver is active
- `WHASAPPC_DATA_DIR/backups`
- `WHASAPPC_DATA_DIR/sessions`
- `whatsapp-engine/uploads`
- `whatsapp-engine/auth`

## Runtime State

Contact groups, templates, campaigns, audit logs, recipient cooldown and daily send counters are stored in SQLite. Legacy JSON files are migration inputs only and are not active runtime storage.

## Database Driver

`DB_DRIVER=auto` (the default) uses Node's built-in `node:sqlite` when the running Node version supports it without flags, otherwise it falls back to `sql.js`. Node may print its SQLite `ExperimentalWarning`; this is expected and is not globally suppressed. Set `DB_DRIVER=sqljs` to roll back to the WASM driver. A non-empty `database.sqlite-wal` is checkpointed through `node:sqlite` before `sql.js` opens the database; without Node SQLite support startup stops rather than risk silently losing WAL data.
