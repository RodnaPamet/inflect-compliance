#!/usr/bin/env node
/**
 * Has any migration THIS database already applied been edited since?
 *
 * ─── The hazard ─────────────────────────────────────────────────────
 *
 * `prisma migrate deploy` never re-runs a migration it has already
 * applied. So editing a migration file that some database already ran
 * leaves that database silently disagreeing with the repo, forever, and
 * *nothing in the Prisma toolchain says so*. Measured on this repo
 * against a database with one edited-after-apply migration:
 *
 *     $ prisma migrate status   →  "Database schema is up to date!"
 *     $ prisma migrate deploy   →  "No pending migrations to apply."
 *
 * Both are, strictly, true. Neither is the answer to the question.
 *
 * What it looks like when it bites: `OBLIGATION_UNMAPPED` was added to a
 * CHECK constraint in `20260906150000_agentic_evidence_artefact` after
 * the local base test DB had already applied that migration. Tests then
 * failed with SQLSTATE 23514 — a constraint violation, pointing squarely
 * at the product code, which was correct. The defect was in the database,
 * and nothing on the screen mentioned the database.
 *
 * Editing an unshipped migration is legitimate here — this repo's policy
 * is forward-fix and the migration had not left the branch. The gap was
 * never the edit. It was that nothing NOTICED.
 *
 * ─── Why this is a developer tool and NOT a CI gate ─────────────────
 *
 * CI builds its databases fresh on every run, so a CI database has never
 * had time to disagree with the repo: wired as a blocking gate this check
 * could only ever verify a case that cannot occur there. This repo has a
 * written rule against exactly that (CLAUDE.md, "Never gate CI on prose" /
 * the epic-ratchet lifecycle: a check whose true-positive rate is
 * structurally zero fires only on the innocent). The failure mode it
 * catches is one-developer-one-machine — invisible where everyone looks,
 * painful where one person is working. So it is run by hand:
 *
 *     npm run db:check-migration-drift
 *     npm run db:check-migration-drift -- --url postgresql://…
 *     npm run db:check-migration-drift -- --json
 *
 * ─── The instrument ─────────────────────────────────────────────────
 *
 * Prisma records a checksum per applied migration in `_prisma_migrations`.
 * It is the SHA-256 hex digest of the raw bytes of that migration's
 * `migration.sql` — verified empirically before this script was written to
 * rely on it (276 of 277 applied rows on a real migrated database
 * reproduce exactly; the 277th was the genuine drift above), and pinned
 * against Prisma-authored rows by
 * `tests/integration/applied-migration-checksum-drift.test.ts` so a future
 * Prisma release that changes the algorithm turns that test red rather
 * than turning this script silently blind.
 *
 * Two rows in `_prisma_migrations` are deliberately NOT compared:
 *
 *   • rolled-back rows (`rolled_back_at IS NOT NULL`) — the migration was
 *     not applied, so its checksum describes an attempt, not the database.
 *     A real one of these sits in this repo's test DB today
 *     (`20260906120000_agent_proposal_approval`, rolled back then
 *     re-applied) and comparing it would report a permanent false drift.
 *   • unfinished rows (`finished_at IS NULL`) — same reasoning.
 *
 * ─── Exit codes (an absence is not a pass) ──────────────────────────
 *
 *   0  clean        — compared N applied migrations, all agree
 *   1  drift        — at least one applied migration disagrees; named
 *   2  unavailable  — could not check at all (no URL, unreachable host,
 *                     no migration history, nothing applied)
 *
 * 2 exists because a check that could not run must never be mistaken for
 * one that ran and found nothing. "No drift reported" is not evidence of
 * no drift unless the last line says how many migrations were compared.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = path.join(ROOT, 'prisma', 'migrations');

export const EXIT_CLEAN = 0;
export const EXIT_DRIFT = 1;
export const EXIT_UNAVAILABLE = 2;

/** Prisma's checksum: SHA-256 hex of the raw bytes of migration.sql. */
export function checksumOfMigrationFile(filePath) {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * Prisma-only connection parameters. `pg` does not understand them and a
 * couple (notably `schema`) would otherwise be passed to the server as an
 * unrecognised startup option, so a URL copied straight out of `.env`
 * would fail to connect and this script would report `unavailable` for a
 * database that is in fact perfectly reachable — the exact confusion the
 * exit-code split exists to prevent.
 */
const PRISMA_ONLY_PARAMS = [
    'schema', 'connection_limit', 'pool_timeout', 'pgbouncer',
    'sslaccept', 'sslcert', 'sslidentity', 'sslpassword', 'socket_timeout',
    'statement_cache_size', 'connect_timeout',
];

export function toPgConnectionString(url) {
    const u = new URL(url);
    for (const p of PRISMA_ONLY_PARAMS) u.searchParams.delete(p);
    return u.toString();
}

function parseEnvFile(file, key) {
    try {
        const re = new RegExp(`^${key}=["']?([^"'\\n]*)["']?$`, 'm');
        return readFileSync(file, 'utf8').match(re)?.[1] || undefined;
    } catch {
        return undefined;
    }
}

/**
 * `DIRECT_DATABASE_URL` first: it is the one Prisma migrations themselves
 * run through, so it is the connection whose `_prisma_migrations` table is
 * authoritative. `DATABASE_URL` (PgBouncer) reaches the same rows, but
 * preferring the direct string keeps this reading what migrate wrote.
 */
export function resolveDatabaseUrl(argv = [], env = process.env, root = ROOT) {
    const flag = argv.indexOf('--url');
    if (flag !== -1 && argv[flag + 1]) return { url: argv[flag + 1], source: '--url' };
    if (env.DIRECT_DATABASE_URL) return { url: env.DIRECT_DATABASE_URL, source: 'DIRECT_DATABASE_URL' };
    if (env.DATABASE_URL) return { url: env.DATABASE_URL, source: 'DATABASE_URL' };
    for (const file of ['.env.test', '.env']) {
        const p = path.join(root, file);
        for (const key of ['DIRECT_DATABASE_URL', 'DATABASE_URL']) {
            const v = parseEnvFile(p, key);
            if (v) return { url: v, source: `${file}:${key}` };
        }
    }
    return { url: undefined, source: 'none' };
}

function redact(url) {
    try {
        const u = new URL(url);
        if (u.password) u.password = '***';
        return u.toString();
    } catch {
        return '<unparseable url>';
    }
}

/**
 * The whole check, as data. Returns
 * `{ status: 'clean'|'drift'|'unavailable', … }` and never throws for an
 * expected condition — an unreachable database is a RESULT, not a crash,
 * because a stack trace and a clean run look far too similar in a scroll
 * of terminal output.
 */
export async function checkAppliedMigrationDrift({ url, migrationsDir = MIGRATIONS_DIR } = {}) {
    if (!url) {
        return {
            status: 'unavailable',
            reason: 'no-database-url',
            detail: 'No database URL. Pass --url, or set DIRECT_DATABASE_URL / DATABASE_URL, or add one to .env.',
        };
    }
    if (!existsSync(migrationsDir) || readdirSync(migrationsDir).length === 0) {
        return { status: 'unavailable', reason: 'no-migrations-directory', detail: `No migrations found at ${migrationsDir}.` };
    }

    let client;
    try {
        client = new Client({ connectionString: toPgConnectionString(url), connectionTimeoutMillis: 10_000 });
        await client.connect();
    } catch (err) {
        return {
            status: 'unavailable',
            reason: 'unreachable',
            detail: `Could not connect to ${redact(url)}: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    try {
        let rows;
        try {
            // Only rows describing a migration this database ACTUALLY ran.
            ({ rows } = await client.query(
                `SELECT migration_name, checksum
                   FROM _prisma_migrations
                  WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
                  ORDER BY started_at`,
            ));
        } catch (err) {
            return {
                status: 'unavailable',
                reason: 'no-migration-history',
                detail:
                    `${redact(url)} has no readable _prisma_migrations table ` +
                    `(${err instanceof Error ? err.message : String(err)}). ` +
                    `A database built with \`prisma db push\` keeps no migration history, so ` +
                    `nothing can be compared — this is NOT the same as "no drift".`,
            };
        }

        if (rows.length === 0) {
            return {
                status: 'unavailable',
                reason: 'no-applied-migrations',
                detail: `${redact(url)} has an empty migration history: 0 applied migrations, so 0 could be compared.`,
            };
        }

        const edited = [];
        const missing = [];
        for (const row of rows) {
            const file = path.join(migrationsDir, row.migration_name, 'migration.sql');
            if (!existsSync(file)) {
                missing.push({ migration: row.migration_name, file });
                continue;
            }
            const onDisk = checksumOfMigrationFile(file);
            if (onDisk !== row.checksum) {
                edited.push({ migration: row.migration_name, applied: row.checksum, onDisk });
            }
        }

        const compared = rows.length;
        if (edited.length === 0 && missing.length === 0) {
            return { status: 'clean', compared, database: redact(url) };
        }
        return { status: 'drift', compared, database: redact(url), edited, missing };
    } finally {
        await client.end().catch(() => {});
    }
}

function report(result, source) {
    if (result.status === 'clean') {
        console.log(`✓ migration drift: clean — ${result.compared} applied migrations compared against prisma/migrations, all agree.`);
        console.log(`  database: ${result.database} (from ${source})`);
        return EXIT_CLEAN;
    }

    if (result.status === 'unavailable') {
        // Loud and distinct on purpose. A check that could not run must not
        // be readable as a check that ran and found nothing.
        console.error(`? migration drift: NOT CHECKED (${result.reason})`);
        console.error(`  ${result.detail}`);
        console.error(`  Nothing was compared. Treat this as "unknown", not "clean".`);
        return EXIT_UNAVAILABLE;
    }

    console.error(`✗ migration drift: ${result.edited.length + result.missing.length} of ${result.compared} applied migrations disagree with prisma/migrations.`);
    console.error(`  database: ${result.database} (from ${source})`);
    for (const e of result.edited) {
        console.error('');
        console.error(`  EDITED AFTER APPLY  ${e.migration}`);
        console.error(`    applied to this database: ${e.applied}`);
        console.error(`    prisma/migrations/${e.migration}/migration.sql: ${e.onDisk}`);
        console.error(`    This database ran the OLD text. prisma migrate deploy will not re-run it,`);
        console.error(`    and prisma migrate status will keep calling the schema up to date.`);
    }
    for (const m of result.missing) {
        console.error('');
        console.error(`  APPLIED BUT ABSENT FROM THE REPO  ${m.migration}`);
        console.error(`    expected ${path.relative(ROOT, m.file)}`);
        console.error(`    This database ran a migration that is not on this branch (a branch switch, or a deleted migration).`);
    }
    console.error('');
    console.error('  Fix, for a development or test database — rebuild it from the migrations on disk:');
    console.error('      npm run db:reset');
    console.error('  For the shared test database: npm run db:test:down && npm run db:test:up, then npm run db:reset.');
    console.error('  For a database with data you cannot lose: write a NEW forward-fix migration');
    console.error('  (this repo never reverts migrations — see docs/change-management-policy.md).');
    return EXIT_DRIFT;
}

async function main() {
    const argv = process.argv.slice(2);
    const { url, source } = resolveDatabaseUrl(argv);
    const result = await checkAppliedMigrationDrift({ url });
    if (argv.includes('--json')) {
        console.log(JSON.stringify({ ...result, source }, null, 2));
        return result.status === 'clean' ? EXIT_CLEAN : result.status === 'drift' ? EXIT_DRIFT : EXIT_UNAVAILABLE;
    }
    return report(result, source);
}

// Only run when invoked directly, so the test can import the pieces above.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().then(
        (code) => { process.exitCode = code; },
        (err) => {
            console.error(`? migration drift: NOT CHECKED (unexpected-error)`);
            console.error(`  ${err instanceof Error ? err.stack : String(err)}`);
            process.exitCode = EXIT_UNAVAILABLE;
        },
    );
}
