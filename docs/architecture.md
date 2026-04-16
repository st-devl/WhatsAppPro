# Architecture

## Runtime

- Node.js and Express serve HTTP APIs and static frontend assets.
- Socket.IO carries WhatsApp status and campaign progress events.
- Baileys owns the WhatsApp Web connection.
- SQLite with WAL mode stores business data, audit logs and campaign state.

## Backend Structure

- `index.js`: application bootstrap and route mounting.
- `routes/*`: HTTP route definitions.
- `services/*`: business workflow logic.
- `lib/db.js`: current SQLite data access and migrations.
- `lib/whatsapp_runtime.js`: WhatsApp lifecycle.
- `lib/messenger.js`: campaign send loop.
- `socket/campaign_socket.js`: authenticated Socket.IO gateway.

## Frontend Structure

- `public/index.html`: dashboard shell.
- `public/login.html`: login page.
- `public/js/*`: dashboard modules, API client, state and UI helpers.
- `shared/message_renderer.js`: shared frontend/backend template renderer.

## Known Architecture Boundaries

The system is modular enough for staging use, but `lib/db.js` is still too broad and should be split into repositories before the codebase grows further.
