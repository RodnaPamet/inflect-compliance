/**
 * Jest globalSetup: runs once before all suites.
 * - Migrates the base/template test DB.
 * - When Jest runs >1 worker, TEMPLATE-clones the migrated base into
 *   one DB per worker (`<base>_w<id>`) so parallel integration tests
 *   (which TRUNCATE in beforeEach) never contend on a shared DB —
 *   the deadlock/data-race flake class. Serial runs (`--runInBand`,
 *   CI) skip cloning and stay on the shared base DB (unchanged path).
 * - Writes a marker the worker-side `getTestDatabaseUrl()` reads.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import {
    migrateTestDb,
    getBaseTestDatabaseUrl,
    getDbName,
    adminConnectionString,
    PER_WORKER_MARKER,
} from '../helpers/db';

interface GlobalConfig { maxWorkers?: number }

export default async function globalSetup(globalConfig?: GlobalConfig) {
    const base = getBaseTestDatabaseUrl();
    const baseName = getDbName(base);

    console.log(`\n[test-setup] Database URL: ${base.replace(/:[^@]*@/, ':***@')}`);

    // CI already applied the schema ONCE per job (`prisma migrate deploy`,
    // before Jest starts). This hook runs on every Jest process boot, so
    // with four shards plus the coverage run it re-shelled the same
    // migrate 6-10 times per push — each one a cold `prisma` CLI start
    // against an already-migrated database.
    //
    // Locally it stays: a developer's test DB may be behind the schema,
    // and `npm test` is expected to just work.
    if (process.env.CI === 'true' || process.env.CI === '1') {
        console.log('[test-setup] CI: schema already applied by the workflow, skipping migrate');
    } else {
        console.log(`[test-setup] Running migrations on base DB...`);
        try {
            migrateTestDb();
            console.log(`[test-setup] Migrations complete`);
        } catch (err) {
            console.warn(`[test-setup] Migration skipped: ${err}`);
        }
    }

    const maxWorkers = globalConfig?.maxWorkers ?? 1;
    let marker = { perWorker: false, count: 1, baseName, baseUrl: base };

    if (maxWorkers > 1) {
        // TEMPLATE-clone the migrated base into one DB per worker. Fast
        // (Postgres copies the data files); roles are cluster-global so
        // RLS app_user etc. are shared, policies/grants are copied.
        try {
            const admin = new Client({ connectionString: adminConnectionString() });
            await admin.connect();
            // CREATE DATABASE ... TEMPLATE requires the template idle.
            // Terminate any stray sessions on it (e.g. a leaked client
            // from a prior run) so the clone never fails spuriously.
            await admin.query(
                `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                 WHERE datname = $1 AND pid <> pg_backend_pid()`,
                [baseName],
            );
            for (let i = 1; i <= maxWorkers; i++) {
                const wdb = `${baseName}_w${i}`;
                await admin.query(`DROP DATABASE IF EXISTS "${wdb}" WITH (FORCE)`);
                await admin.query(`CREATE DATABASE "${wdb}" TEMPLATE "${baseName}"`);
            }
            await admin.end();
            marker = { perWorker: true, count: maxWorkers, baseName, baseUrl: base };
            console.log(`[test-setup] Per-worker DB isolation: ${baseName}_w1..w${maxWorkers}`);
        } catch (err) {
            // No CREATEDB / older Postgres / template busy — degrade to the
            // shared base DB (correct only when run serially, but never
            // crashes setup).
            console.warn(
                `[test-setup] Per-worker DB isolation unavailable (${err instanceof Error ? err.message : err}); ` +
                    `falling back to the shared base DB — run integration with --runInBand to stay deadlock-free.`,
            );
        }
    }

    fs.mkdirSync(path.dirname(PER_WORKER_MARKER), { recursive: true });
    fs.writeFileSync(PER_WORKER_MARKER, JSON.stringify(marker));

    if (!base.includes('test')) {
        console.warn(`[test-setup] WARNING: DATABASE_URL does not look like a test database!`);
    }
}
