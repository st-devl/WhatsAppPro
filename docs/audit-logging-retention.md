# Audit Logging and Retention

## Scope

- Runtime logs use structured JSON through `pino`.
- Every HTTP request receives an `X-Request-Id` response header.
- Request logs include request id, tenant id and user id when a session exists.
- Authentication, Excel import and campaign start/stop events are persisted to `audit_logs`.
- Audit metadata is redacted before it is written to SQLite.

## Redaction Rules

- `password`, `secret`, `token`, `authorization` and `cookie` fields are stored as `[redacted]`.
- Phone fields are masked.
- E-mail fields are masked.
- Exact IP addresses are not stored; IPv4 last octet and IPv6 suffix are masked.
- Contact names, surnames and message bodies are stored as `[masked]`.

## API

- `GET /api/v1/audit-logs`
- `GET /api/v1/audit-logs/export`

Both endpoints are authenticated and tenant-scoped. Supported filters:

- `action`
- `entity_type`
- `entity_id`
- `from`
- `to`
- `limit`
- `offset`

Export returns the same redacted data as JSON with a download filename.

## Retention

Retention is intentionally opt-in to avoid deleting operational evidence without an explicit production decision.

- `AUDIT_RETENTION_DAYS` empty: no automatic purge.
- `AUDIT_RETENTION_DAYS=180`: purge audit rows older than 180 days once at startup and then once per day.

Recommended production policy:

- Keep online audit logs for 180 days.
- Export monthly audit archives to immutable storage before purge.
- Restrict audit endpoints to owner/admin roles before enabling non-owner users.
- Treat exported audit files as sensitive operational records.
