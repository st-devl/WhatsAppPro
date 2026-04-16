# Cache and Retention Strategy

## Current Baseline

- SQLite runs in WAL mode.
- Group list counts are calculated with SQL aggregate queries.
- Contact lists use server-side pagination, search and sorting.
- Runtime uploads have quota and age-based cleanup.
- Database backups are retained by count.
- Audit retention is opt-in through environment configuration.

## Redis Cache Targets

Redis should be introduced only when the app is deployed with multiple Node processes, multiple hosts, or enough traffic that local process memory becomes unreliable.

Recommended cache areas:

- Session store: replace file-backed sessions with Redis when there is more than one app instance.
- Login rate limit: move limiter state to Redis so brute-force protection is global across instances.
- Campaign progress snapshot: cache current progress for frequent dashboard polling while SQLite remains the source of truth.
- Group metadata: cache `GET /groups` result per tenant because it is read often and invalidated predictably.
- WhatsApp runtime status: short TTL cache for status/QR polling if HTTP polling is introduced beyond Socket.IO.

Do not cache:

- Full contact lists. Pagination and SQL indexes are the correct primary optimization.
- Message bodies with rendered personal data.
- Uploaded media bytes in Redis.
- Audit logs.

## Cache Keys

- `session:{sid}`
- `login-rate:{tenantId}:{emailHash}:{ipHash}`
- `campaign-progress:{tenantId}:{campaignId}`
- `group-metadata:{tenantId}`
- `runtime-status:{tenantId}`

E-mail and IP values must be hashed before they are used in keys.

## Invalidation Rules

- `group-metadata:{tenantId}`: invalidate after group create/update/delete and contact create/update/delete/import in that tenant.
- `campaign-progress:{tenantId}:{campaignId}`: update after every recipient state change; delete after campaign completed, stopped or expired.
- `runtime-status:{tenantId}`: TTL only, maximum 10 seconds.
- `login-rate:*`: expires with the configured login rate-limit window.
- `session:{sid}`: expires with the session cookie max age.

## Retention Controls

- `BACKUP_RETENTION_COUNT`: number of SQLite backup files kept in `data/backups`; default `30`.
- `AUDIT_RETENTION_DAYS`: disabled when empty. When set, old audit rows are purged at startup and once per day.
- `MEDIA_RETENTION_MS`: uploaded media cleanup age.
- `MEDIA_TOTAL_QUOTA_BYTES`: tenant upload quota.

## 10k+ Contact Scenario

Expected behavior:

- Group list returns metadata and counts, not full contact arrays.
- Contact table calls use `limit`, `offset`, `search`, `sort` and `direction`.
- Duplicate phone checks are backed by tenant/group/phone indexes.
- Campaign recipients are persisted per run and can be resumed without rebuilding from frontend state.

Required next step before horizontal scaling:

- Move session and rate-limit state to Redis.
- Keep campaign recipient status in SQLite/Postgres as source of truth.
- Cache only progress snapshots and group metadata.
