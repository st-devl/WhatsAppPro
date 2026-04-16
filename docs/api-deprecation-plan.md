# API Deprecation Plan

## Current Versions

- Preferred API: `/api/v1`
- Legacy compatibility API: `/api`

## Policy

All new frontend and integration code must use `/api/v1`.

Legacy `/api` routes remain temporarily available for backwards compatibility. Protected legacy responses include:

- `Deprecation: true`
- `Link: </api/v1>; rel="successor-version"`
- `Sunset: Wed, 30 Sep 2026 00:00:00 GMT`

## Removal Criteria

The legacy `/api` namespace can be removed after:

- Browser frontend uses only `/api/v1`.
- External consumers have migrated.
- Access logs show no legacy route usage for at least 30 days.
- A release note announces the removal.
