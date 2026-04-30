const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../lib/db');

const command = process.argv[2] || 'status';
const jsonOutput = process.argv.includes('--json');

function printHumanStatus(status) {
    console.log('Migration status');
    console.log(`  db_file: ${status.db_file}`);
    console.log(`  exists: ${status.exists ? 'yes' : 'no'}`);
    console.log(`  applied: ${status.migration_count}/${status.total_migrations}`);
    console.log(`  latest: ${status.latest_migration?.id || '-'}`);
    console.log(`  pending: ${status.pending_count}`);
    status.pending.forEach(migration => {
        console.log(`    - ${migration.id}: ${migration.description}`);
    });
}

function printApplyResult(result) {
    console.log('Migration apply');
    console.log(`  before: ${result.before.migration_count}/${result.before.total_migrations}`);
    console.log(`  after: ${result.after.migration_count}/${result.after.total_migrations}`);
    console.log(`  applied_now: ${result.applied_count}`);
    console.log(`  pending: ${result.after.pending_count}`);
    console.log(`  backup_dir: ${result.backup_dir}`);
    if (result.after.pending_count > 0) {
        result.after.pending.forEach(migration => {
            console.log(`    - ${migration.id}: ${migration.description}`);
        });
    }
}

(async () => {
    if (command === 'status') {
        const status = await db.getMigrationStatus();
        if (jsonOutput) {
            console.log(JSON.stringify(status, null, 2));
        } else {
            printHumanStatus(status);
        }
        process.exit(0);
    }

    if (command === 'apply') {
        const result = await db.applyPendingMigrations();
        if (jsonOutput) {
            console.log(JSON.stringify(result, null, 2));
        } else {
            printApplyResult(result);
        }
        process.exit(result.after.pending_count === 0 ? 0 : 11);
    }

    console.error(`Unknown migration command: ${command}`);
    console.error('Usage: node scripts/migrate.js status|apply [--json]');
    process.exit(2);
})().catch(err => {
    console.error(err);
    process.exit(1);
});
