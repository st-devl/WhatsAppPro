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
- `WHASAPPC_DATA_DIR/backups`
- `WHASAPPC_DATA_DIR/sessions`
- `whatsapp-engine/uploads`
- `whatsapp-engine/auth`

## Runtime State

Contact groups, templates, campaigns, audit logs, recipient cooldown and daily send counters are stored in SQLite. Legacy JSON files are migration inputs only and are not active runtime storage.
