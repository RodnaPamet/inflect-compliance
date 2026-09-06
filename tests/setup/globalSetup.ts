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
    perWorkerDbName,
    acquireTestDbRunLock,
    rememberTestDbRunLock,
    PER_WORKER_MARKER,
} from '../helpers/db';
import type { PerWorkerInfo } from '../helpers/db';

interface GlobalConfig { maxWorkers?: number }

export default async function globalSetup(globalConfig?: GlobalConfig) {
    const base = getBaseTestDatabaseUrl();
    const baseName = getDbName(base);

    console.log(`\n[test-setup] Database URL: ${base.replace(/:[^@]*@/, ':***@')}`);

    // ── One run at a time for this (checkout, base database) pair ──
    //
    // Everything from here on is destructive to databases a SECOND concurrent
    // run in this checkout would derive the very same names for: the migrate,
    // the pg_terminate_backend sweep, the DROP ... WITH (FORCE), the TEMPLATE
    // clone, and then every resetDatabase() TRUNCATE for the rest of the run.
    // Without the lock the two runs demolish each other silently and the
    // wreckage is reported as failing product tests in files neither run
    // touched. So the lock is taken BEFORE the first destructive statement and
    // held (by an open connection) until globalTeardown releases it.
    //
    // Three outcomes, three different responses, and the third is the point:
    // a run that could not CHECK must not be mistaken for a run that checked
    // and found nothing. 'unchecked' is only safe to continue from because it
    // means no database was reachable to corrupt in the first place -- and it
    // still says so, loudly, rather than passing in silence.
    const runLock = await acquireTestDbRunLock();
    if (runLock.status === 'conflict') {
        throw new Error(runLock.message);
    }
    if (runLock.status === 'unchecked') {
        console.warn(
            `[test-setup] Concurrent-run check DID NOT RUN: ${runLock.reason}.\n` +
                `[test-setup] Nothing was reachable to corrupt, so this run continues -- but it is ` +
                `NOT protected against a second concurrent run.`,
        );
    } else {
        rememberTestDbRunLock(runLock);
        console.log(
            `[test-setup] Holding the concurrent-run lock (key ${runLock.key[0]}/${runLock.key[1]})`,
        );
    }

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
    // Annotated, not inferred: inferring from this initializer gives a type
    // with no `workerDbs`, and the assignment below then fails to compile.
    let marker: PerWorkerInfo = { perWorker: false, count: 1, baseName, baseUrl: base };

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
            // Named via perWorkerDbName so the tag that keeps two checkouts
            // apart is applied here, in teardown, and at connect time from
            // ONE definition. The DROP below is `WITH (FORCE)` — it
            // terminates any attached session — which is precisely why the
            // name must not be derivable by another checkout.
            const workerDbs: string[] = [];
            for (let i = 1; i <= maxWorkers; i++) {
                const wdb = perWorkerDbName(baseName, i);
                workerDbs.push(wdb);
                await admin.query(`DROP DATABASE IF EXISTS "${wdb}" WITH (FORCE)`);
                await admin.query(`CREATE DATABASE "${wdb}" TEMPLATE "${baseName}"`);
            }
            await admin.end();
            // Record the names actually created, so teardown drops exactly
            // these rather than recomputing and possibly disagreeing.
            marker = { perWorker: true, count: maxWorkers, baseName, baseUrl: base, workerDbs };
            console.log(
                `[test-setup] Per-worker DB isolation: ${workerDbs[0]}..w${maxWorkers}`,
            );
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
