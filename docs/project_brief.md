# Project Brief

WhasAppC is a WhatsApp campaign management application for importing contacts, managing contact groups, preparing message templates and running controlled outbound campaigns through a connected WhatsApp session.

## Current Scope

- Single configured admin login.
- Contact group management.
- Excel contact import.
- Message template rendering.
- Media upload for campaign messages.
- Campaign start, stop, resume and retry.
- Audit logging and operational diagnostics.

## Current Deployment Target

The current implementation is suitable for local development, staging and controlled internal usage. It is not designed as a fully self-service multi-tenant SaaS yet.

## Primary Constraints

- WhatsApp runtime currently supports the configured default tenant.
- Campaign execution still runs inside the Node.js process.
- Horizontal scaling requires Redis-backed sessions/rate limiting and a real worker queue.
