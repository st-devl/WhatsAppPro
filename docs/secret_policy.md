# Secret Policy

## Required Secrets

- `SESSION_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASS_HASH`

## Rules

- Secrets must be supplied through environment variables.
- `.env` is local-only and must not be committed.
- Production secrets must be rotated after accidental exposure.
- Password hashes must be bcrypt hashes, not plaintext passwords.

## Production Requirement

The fallback development session secret is acceptable only for local development. Production deployment must set `SESSION_SECRET` explicitly.
