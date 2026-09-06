/**
 * INVARIANT: a migration this database has already applied, edited on disk
 * afterwards, is REPORTED — by name — and a database that could not be
 * checked at all never reads as a clean one.
 *
 * Why this needs a real database rather than a fixture: the whole check
 * rests on a claim about somebody else's software — that the `checksum`
 * column Prisma writes into `_prisma_migrations` is the SHA-256 of the raw
 * bytes of `migration.sql`. A fixture would only prove this repo agrees
 * with itself. So the first test below reproduces Prisma's OWN recorded
 * checksums, written by `prisma migrate deploy` and never by this suite;
 * if a future Prisma release changes the algorithm, that test goes red
 * instead of `scripts/check-applied-migration-drift.mjs` going silently
 * blind and reporting "clean" forever.
 *
 * The two directions are both load-bearing. A drift detector that cannot
 * detect drift is this repo's Assets-status precedent
 * (`tests/guards/item-29-status-buttons.test.ts` asserted the schema
 * *mentioned* `status` and stayed green for months while the control
 * persisted nothing), and a detector that reports drift unconditionally is
 * just as useless — so the clean direction is asserted too, and the drift
 * direction asserts that EXACTLY the tampered migration is named.
 */
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { DB_AVAILABLE, DB_URL } from './db-helper';
import { getBaseTestDatabaseUrl, getDbName, withDbName, adminConnectionString } from '../helpers/db';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-applied-migration-drift.mjs');
const MIGRATIONS_DIR = path.join(ROOT, 'prisma', 'migrations');

const EXIT_CLEAN = 0;
const EXIT_DRIFT = 1;
const EXIT_UNAVAILABLE = 2;

interface DriftResult {
    status: 'clean' | 'drift' | 'unavailable';
    reason?: string;
    compared?: number;
    edited?: { migration: string; applied: string; onDisk: string }[];
    missing?: { migration: string }[];
}

function runScript(url: string, extra: string[] = []) {
    const res = spawnSync(process.execPath, [SCRIPT, '--url', url, ...extra], {
        encoding: 'utf8',
        timeout: 60_000,
    });
    return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function runScriptJson(url: string): { code: number | null; result: DriftResult } {
    const { code, stdout } = runScript(url, ['--json']);
    return { code, result: JSON.parse(stdout) as DriftResult };
}

function sha256OfMigration(name: string): string | undefined {
    const file = path.join(MIGRATIONS_DIR, name, 'migration.sql');
    if (!fs.existsSync(file)) return undefined;
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// A scratch database of this suite's own, so nothing here can disturb the
// shared base test DB (which other suites, and possibly another checkout,
// are connected to). Named from the pid so a crashed run cannot collide
// with a live one; dropped in afterAll.
const SCRATCH_DB = `migdrift_test_${process.pid}`;

if (!DB_AVAILABLE) {
    describe.skip('applied-migration checksum drift', () => {
        it('skipped: no database', () => { /* gate handled by db-helper */ });
    });
} else {
    describe('applied-migration checksum drift', () => {
        const scratchUrl = withDbName(DB_URL, SCRATCH_DB);
        let admin: Client;
        /** How the scratch DB got its rows — reported in failures. */
        let seededBy = 'unknown';

        beforeAll(async () => {
            admin = new Client({ connectionString: adminConnectionString() });
            await admin.connect();
            await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);

            const templateName = getDbName(getBaseTestDatabaseUrl());
            try {
                // The real thing: a byte-for-byte copy of a migrated database,
                // including the `_prisma_migrations` rows Prisma itself wrote.
                await admin.query(`CREATE DATABASE "${SCRATCH_DB}" TEMPLATE "${templateName}"`);
                seededBy = `TEMPLATE ${templateName}`;
            } catch {
                // `CREATE DATABASE ... TEMPLATE` needs the template idle, and
                // under `--runInBand` the base DB is the one this very suite is
                // connected to. Rather than terminate a live run's connections
                // (which would break unrelated suites), copy the rows across —
                // still Prisma-authored checksums, still a database this test
                // created, just not a file-level clone.
                await admin.query(`CREATE DATABASE "${SCRATCH_DB}"`);
                const src = new Client({ connectionString: DB_URL });
                const dst = new Client({ connectionString: scratchUrl });
                await src.connect();
                await dst.connect();
                const { rows } = await src.query(
                    'SELECT id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count FROM _prisma_migrations',
                );
                await dst.query(`CREATE TABLE _prisma_migrations (
                    id varchar(36) PRIMARY KEY,
                    checksum varchar(64) NOT NULL,
                    finished_at timestamptz,
                    migration_name varchar(255) NOT NULL,
                    logs text,
                    rolled_back_at timestamptz,
                    started_at timestamptz NOT NULL DEFAULT now(),
                    applied_steps_count integer NOT NULL DEFAULT 0
                )`);
                for (const r of rows) {
                    await dst.query(
                        'INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
                        [r.id, r.checksum, r.finished_at, r.migration_name, r.logs, r.rolled_back_at, r.started_at, r.applied_steps_count],
                    );
                }
                await src.end();
                await dst.end();
                seededBy = 'row-copy (template busy)';
            }
        }, 180_000);

        afterAll(async () => {
            if (admin) {
                await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`).catch(() => {});
                await admin.end().catch(() => {});
            }
        }, 60_000);

        /** Applied = finished, not rolled back. The script's own population. */
        async function appliedRows(): Promise<{ migration_name: string; checksum: string }[]> {
            const c = new Client({ connectionString: scratchUrl });
            await c.connect();
            const { rows } = await c.query(
                'SELECT migration_name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY started_at',
            );
            await c.end();
            return rows;
        }

        /**
         * Put the scratch DB into the state a fresh `migrate deploy` produces:
         * every applied row's checksum equal to its file on disk. Done by
         * WRITING the expected value rather than by resetting, because the
         * shared base DB this clone came from may legitimately be carrying the
         * very drift this tool exists to find.
         */
        async function normaliseToDisk(): Promise<number> {
            const c = new Client({ connectionString: scratchUrl });
            await c.connect();
            const { rows } = await c.query(
                'SELECT id, migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
            );
            let n = 0;
            for (const r of rows) {
                const sha = sha256OfMigration(r.migration_name);
                if (sha === undefined) {
                    // Applied here but absent from this branch — drop it, so the
                    // clean-direction test measures ONLY checksum agreement.
                    await c.query('DELETE FROM _prisma_migrations WHERE id = $1', [r.id]);
                    continue;
                }
                await c.query('UPDATE _prisma_migrations SET checksum = $1 WHERE id = $2', [sha, r.id]);
                n++;
            }
            await c.end();
            return n;
        }

        it("reproduces Prisma's own recorded checksums as SHA-256 of migration.sql", async () => {
            // Grounding for the whole tool. These rows were written by
            // `prisma migrate deploy`, never by this suite (seededBy says how
            // they got here). If Prisma ever changes the algorithm this is the
            // assertion that notices, rather than the checker quietly deciding
            // every migration has drifted — or, worse, none has.
            const rows = await appliedRows();
            expect(rows.length).toBeGreaterThan(200);

            let sha256Matches = 0;
            let sha1Matches = 0;
            let md5Matches = 0;
            for (const row of rows) {
                const file = path.join(MIGRATIONS_DIR, row.migration_name, 'migration.sql');
                if (!fs.existsSync(file)) continue;
                const bytes = fs.readFileSync(file);
                if (createHash('sha256').update(bytes).digest('hex') === row.checksum) sha256Matches++;
                if (createHash('sha1').update(bytes).digest('hex') === row.checksum) sha1Matches++;
                if (createHash('md5').update(bytes).digest('hex') === row.checksum) md5Matches++;
            }

            expect({ seededBy, sha256Matches: sha256Matches > 200 }).toEqual({ seededBy, sha256Matches: true });
            // The negative half: we identified THE algorithm, not merely one
            // that happens to agree. Without this, "sha256 matches a lot" would
            // also be satisfied by a checker that accepted any digest at all.
            expect(sha1Matches).toBe(0);
            expect(md5Matches).toBe(0);
        }, 120_000);

        it('reports clean, naming how many migrations it compared, when every applied migration matches its file', async () => {
            const normalised = await normaliseToDisk();
            const { code, result } = runScriptJson(scratchUrl);

            expect(result.status).toBe('clean');
            expect(code).toBe(EXIT_CLEAN);
            // The count is part of the result: "no drift reported" means
            // nothing unless the check says how much it looked at.
            expect(result.compared).toBe(normalised);
        }, 120_000);

        it('names the edited migration, and only that one, when an applied migration was changed on disk after apply', async () => {
            await normaliseToDisk();
            const rows = await appliedRows();
            // Deliberately not the first or last row — a checker that reported
            // "the newest migration" or "the first mismatch it could think of"
            // would pass on an edge and fail here.
            const victim = rows[Math.floor(rows.length / 2)].migration_name;
            const stale = createHash('sha256').update('what this database actually ran').digest('hex');

            const c = new Client({ connectionString: scratchUrl });
            await c.connect();
            await c.query(
                'UPDATE _prisma_migrations SET checksum = $1 WHERE migration_name = $2 AND finished_at IS NOT NULL AND rolled_back_at IS NULL',
                [stale, victim],
            );
            await c.end();

            const { code, result } = runScriptJson(scratchUrl);
            expect(result.status).toBe('drift');
            expect(code).toBe(EXIT_DRIFT);
            expect(result.edited?.map((e) => e.migration)).toEqual([victim]);
            expect(result.edited?.[0].applied).toBe(stale);
            expect(result.edited?.[0].onDisk).toBe(sha256OfMigration(victim));

            // The human-readable form has to be actionable on its own: the name
            // of the migration, and what to do about it.
            const human = runScript(scratchUrl);
            expect(human.code).toBe(EXIT_DRIFT);
            expect(human.stderr).toContain(victim);
            expect(human.stderr).toContain('npm run db:reset');
        }, 120_000);

        it('ignores rows for migrations this database never actually ran — rolled back, and failed part-way', async () => {
            // Not hypothetical: the shared test DB carries a real rolled-back
            // row for `20260906120000_agent_proposal_approval` alongside its
            // successful retry. Its checksum describes an ATTEMPT, not the
            // database, so comparing it would report permanent drift on a
            // database that is in fact correct — a false alarm that would train
            // people to ignore this check.
            //
            // Both shapes Prisma writes for a migration that did not take leave
            // `finished_at` NULL, so that clause alone excludes them today and
            // `rolled_back_at IS NULL` is belt-and-braces. Both fixtures are
            // here because the shapes are what must stay excluded, whichever
            // clause happens to be doing the work.
            const applied = await normaliseToDisk();
            const c = new Client({ connectionString: scratchUrl });
            await c.connect();
            for (const [id, rolledBack] of [
                ['rolled-back-fixture', true],
                ['failed-part-way-fixture', false],
            ] as [string, boolean][]) {
                await c.query(
                    `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, rolled_back_at, started_at, applied_steps_count)
                     VALUES ($1, $2, NULL, $3, ${rolledBack ? 'now()' : 'NULL'}, now(), 0)`,
                    [id, 'f'.repeat(64), '20260906150000_agentic_evidence_artefact'],
                );
            }
            await c.end();

            const { code, result } = runScriptJson(scratchUrl);
            expect(result.status).toBe('clean');
            expect(code).toBe(EXIT_CLEAN);
            // The two fixtures were excluded from the population, not merely
            // found to agree: the compared count is unchanged by adding them.
            expect(result.compared).toBe(applied);
        }, 120_000);

        it('reports a database it cannot reach as unavailable, never as clean', async () => {
            // An absence is ambiguous: "checked, found nothing" and "could not
            // check" must not share an exit code or a wording.
            const { code, result } = runScriptJson(withDbName(DB_URL, `${SCRATCH_DB}_does_not_exist`));
            expect(result.status).toBe('unavailable');
            expect(result.reason).toBe('unreachable');
            expect(code).toBe(EXIT_UNAVAILABLE);
            expect(code).not.toBe(EXIT_CLEAN);

            const human = runScript(withDbName(DB_URL, `${SCRATCH_DB}_does_not_exist`));
            expect(human.stdout).toBe('');
            expect(human.stderr).toContain('NOT CHECKED');
            // Needle bound to the verdict line, not the word: the body of this
            // message says `Treat this as "unknown", not "clean"`, so a bare
            // `not.toContain('clean')` would be satisfied by prose rather than
            // by the absence of a clean verdict.
            expect(human.stderr).not.toContain('migration drift: clean');
            expect(human.stderr).not.toContain('applied migrations compared');
        }, 120_000);

        it('reports a database with no migration history, and one with an empty history, as unavailable rather than clean', async () => {
            const emptyDb = `${SCRATCH_DB}_nohist`;
            const emptyUrl = withDbName(DB_URL, emptyDb);
            await admin.query(`DROP DATABASE IF EXISTS "${emptyDb}" WITH (FORCE)`);
            await admin.query(`CREATE DATABASE "${emptyDb}"`);
            try {
                // `prisma db push` builds a schema and keeps no history at all.
                // Zero rows compared is not evidence of zero drift.
                const noTable = runScriptJson(emptyUrl);
                expect(noTable.result.status).toBe('unavailable');
                expect(noTable.result.reason).toBe('no-migration-history');
                expect(noTable.code).toBe(EXIT_UNAVAILABLE);

                const c = new Client({ connectionString: emptyUrl });
                await c.connect();
                await c.query(`CREATE TABLE _prisma_migrations (
                    id varchar(36) PRIMARY KEY,
                    checksum varchar(64) NOT NULL,
                    finished_at timestamptz,
                    migration_name varchar(255) NOT NULL,
                    logs text,
                    rolled_back_at timestamptz,
                    started_at timestamptz NOT NULL DEFAULT now(),
                    applied_steps_count integer NOT NULL DEFAULT 0
                )`);
                await c.end();

                const emptyHistory = runScriptJson(emptyUrl);
                expect(emptyHistory.result.status).toBe('unavailable');
                expect(emptyHistory.result.reason).toBe('no-applied-migrations');
                expect(emptyHistory.code).toBe(EXIT_UNAVAILABLE);
            } finally {
                await admin.query(`DROP DATABASE IF EXISTS "${emptyDb}" WITH (FORCE)`).catch(() => {});
            }
        }, 120_000);

        it('is wired to a package script, because a check nobody can run is not a check', () => {
            const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
            expect(pkg.scripts['db:check-migration-drift']).toBe(
                'node scripts/check-applied-migration-drift.mjs',
            );
        });
    });
}
