# API Deprecation Plan

## Current Versions

- Preferred API: `/api/v1`
- Removed API: `/api` (30 September 2026)

## Policy

All new frontend and integration code must use `/api/v1`.

The legacy namespace was removed after the sunset date. Requests to `/api/...` other than `/api/v1/...` receive HTTP `410` with the standard error envelope:

- `code`: `API_VERSION_REMOVED`
- Turkish guidance to use `/api/v1`

## Completion

- Browser frontend, automated tests, scripts, deployment files, and documentation use `/api/v1`.
- Auth and session routes remain available at `/api/v1`.
- `/api/v1` keeps its existing `404` behavior for unknown versioned endpoints.
