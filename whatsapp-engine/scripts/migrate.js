const db = require('../lib/db');

(async () => {
    const database = await db.getDb();
    const migrations = database.exec('SELECT id, description, applied_at FROM schema_migrations ORDER BY id');
    const rows = (migrations[0]?.values || []).map(value => ({
        id: value[0],
        description: value[1],
        applied_at: value[2]
    }));
    const journalMode = database.pragma('journal_mode', { simple: true });

    console.log(JSON.stringify({
        ok: true,
        migration_count: rows.length,
        latest_migration: rows[rows.length - 1] || null,
        journal_mode: journalMode
    }, null, 2));
})().catch(err => {
    console.error(err);
    process.exit(1);
});
