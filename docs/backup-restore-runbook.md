# Backup and Restore Runbook

## Runtime Data

Persistent data must live outside the image/repository.

- SQLite database: `WHASAPPC_DATA_DIR/database.sqlite`
- SQLite backups: `WHASAPPC_DATA_DIR/backups`
- Sessions: `WHASAPPC_DATA_DIR/sessions`
- Uploads: `whatsapp-engine/uploads`
- WhatsApp auth session: `whatsapp-engine/auth`

In Docker, mount all declared volumes:

- `/data`
- `/app/whatsapp-engine/uploads`
- `/app/whatsapp-engine/auth`

## Migration

Run migrations before starting a new release:

```bash
npm --prefix whatsapp-engine run migrate
```

The migration command opens the database, applies pending idempotent migrations and prints the latest applied migration.

## Backup

The application creates SQLite backups before risky write/migration operations.

Manual backup:

```bash
node -e "require('./whatsapp-engine/lib/db').createBackup('manual')"
```

Retention:

- `BACKUP_RETENTION_COUNT=30` keeps the newest 30 backup files.
- Increase this value before large imports or risky migrations.
- Copy backups to off-host storage before deploying schema changes.

## Restore

1. Stop the application.
2. Copy the current database aside.
3. Copy the selected backup over `database.sqlite`.
4. Keep the matching `-wal` and `-shm` files removed before boot if they exist.
5. Start the application.
6. Run `GET /readyz` and verify `ok: true`.
7. Run a read-only UI smoke test: login, list groups, open latest campaign status.

Example:

```bash
cp /data/database.sqlite /data/database.sqlite.before-restore
cp /data/backups/database-YYYY-MM-DD.sqlite /data/database.sqlite
rm -f /data/database.sqlite-wal /data/database.sqlite-shm
```

## Health Checks

- `/healthz`: liveness. It only confirms the process can serve HTTP.
- `/readyz`: readiness. It confirms HTTP state and SQLite access.
- `/healthz/details`: diagnostic status payload.

WhatsApp connection is reported in readiness output but does not block readiness, because QR login may require operator action.
