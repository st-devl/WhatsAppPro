# Data Privacy

## Stored Data

- Contact names, surnames and phone numbers.
- Contact groups.
- Message templates.
- Campaign run and recipient status.
- Audit events with redacted metadata.
- Uploaded media files.
- WhatsApp session files.

## Privacy Controls

- Runtime data is excluded from Git.
- Audit metadata masks phone, e-mail, IP, names and message bodies.
- Logs use structured redaction for sensitive fields.
- Upload paths are tenant-scoped and traversal-protected.

## Operational Rules

- Do not commit `.env`, database files, uploads or WhatsApp auth sessions.
- Treat exported audit logs as sensitive operational records.
- Delete uploaded campaign media according to `MEDIA_RETENTION_MS`.
- Keep production backups outside the application image.
