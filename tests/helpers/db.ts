/**
 * Enhanced test database helpers.
 *
 * Extends the existing db-helper.ts with:
 * - migrateTestDb(): run prisma migrate deploy against test DB
 * - resetDatabase(): truncate all tables for clean state
 * - prismaTestClient(): get a connected PrismaClient for tests
 * - getTestDatabaseUrl(): resolve the test database URL
 *
 * Usage (integration tests):
 *   import { DB_AVAILABLE } from './db-helper';
 *   import { prismaTestClient, resetDatabase } from '../helpers/db';
 *   if (!DB_AVAILABLE) { test.skip('DB not available', () => {}); return; }
 *   const prisma = prismaTestClient();
 *   afterAll(() => prisma.$disconnect());
 *   beforeEach(() => resetDatabase(prisma));
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execSync } from 'child_process';

/**
 * The base/template test database URL.
 * Priority: DATABASE_URL_TEST env > .env.test > test container default > .env > fallback.
 */
export function getBaseTestDatabaseUrl(): string {
    // 1. Explicit test env var (set by CI scripts or jest.setup.js)
    if (process.env.DATABASE_URL_TEST) return process.env.DATABASE_URL_TEST;

    // 2. .env.test file
    const envTestPath = path.resolve(__dirname, '../../.env.test');
    try {
        const content = fs.readFileSync(envTestPath, 'utf8');
        const match = content.match(/^DATABASE_URL_TEST=["']?([^"'\n]*)["']?$/m)
            || content.match(/^DATABASE_URL=["']?([^"'\n]*)["']?$/m);
        if (match?.[1]) return match[1];
    } catch { /* no .env.test */ }

    // 3. Test container default (docker-compose.test.yml → port 5434)
    const testContainerUrl = 'postgresql://test:test@127.0.0.1:5434/inflect_test?schema=public';

    // 4. Parse from .env (dev database)
    const envPath = path.resolve(__dirname, '../../.env');
    try {
        const content = fs.readFileSync(envPath, 'utf8');
        const match = content.match(/^DATABASE_URL="(.*)"/m);
        if (match?.[1]) return match[1];
    } catch { /* no .env */ }

    // Return test container URL as preferred fallback over hard-coded dummy
    return testContainerUrl;
}

// ─── Per-worker DB isolation (flake fix 2026-06) ──────────────────────
//
// Integration tests share one DB and TRUNCATE in beforeEach — safe only
// serially (`test:ci --runInBand`). Run in PARALLEL (`jest`), workers
// truncate each other's data mid-test → deadlocks + data races. Fix:
// when Jest runs >1 worker, globalSetup TEMPLATE-clones the migrated
// base DB into one DB per worker and writes a marker; each worker then
// targets its own DB. Serial runs (CI) skip this and stay on the shared
// base DB — that path is unchanged.
//
// ─── Why the name carries a checkout tag (2026-08-19) ─────────────────
//
// The worker name used to be `<base>_w<id>` — a pure function of the
// database name in the URL. Two CHECKOUTS of this repo on one machine
// pointing at one Postgres therefore derive identical names, and
// globalSetup drops them with:
//
//     DROP DATABASE IF EXISTS "<name>" WITH (FORCE)
//
// `FORCE` calls pg_terminate_backend on every attached session first. So
// the second run to start does not race the first — it hangs up on it,
// mid-transaction. The symptom is "Test suite failed to run" with ZERO
// failed tests, in whichever DB-backed suite happened to be holding a
// connection: a suite that never got to speak, in a file unrelated to
// whatever either checkout was changing.
//
// The marker below is repo-local while the databases were global, so each
// side kept a private record asserting ownership of a shared resource.
//
// The tag is derived from the REPO ROOT, deliberately, and not from the
// URL: two checkouts can reach the same database by different routes
// (one via `.env.test`, another via this file's own default), so any
// scheme keyed on the connection string can agree by accident. The repo
// root cannot.
//
// One checkout behaves exactly as before — the tag is stable per path.
//
// RESIDUAL, on purpose: the shared BASE/template DB is still terminated
// before cloning (CREATE DATABASE ... TEMPLATE requires the template
// idle). That can still interrupt a SERIAL run (`--runInBand`) in another
// checkout, which stays on the base DB. Parallel-vs-parallel — the case
// that actually bites, since `npm test` is parallel — is fully isolated.

/**
 * Cross-process marker written by globalSetup describing the DB mode.
 * Repo-local (NOT os.tmpdir): a predictable name in the world-writable
 * temp dir is a symlink-race vector (CodeQL js/insecure-temporary-file).
 * node_modules/.cache is repo-scoped + gitignored.
 */
export const PER_WORKER_MARKER = path.resolve(
    __dirname,
    '../../node_modules/.cache/inflect-test-perworker.json',
);

export interface PerWorkerInfo {
    perWorker: boolean;
    count: number;
    baseName: string;
    baseUrl: string;
    /**
     * The exact per-worker database names globalSetup created. Teardown
     * drops THESE rather than recomputing them, so a future change to the
     * naming scheme can never orphan a set of databases that a running
     * teardown no longer knows how to name. Absent on markers written
     * before 2026-08-19; readers fall back to recomputing.
     */
    workerDbs?: string[];
}

/**
 * A short, stable tag for THIS checkout, folded into every per-worker
 * database name so two checkouts on one machine never derive the same
 * one. Derived from the repo root path — see the section comment above
 * for why not from the connection URL.
 */
export function checkoutTag(): string {
    return tagForRoot(path.resolve(__dirname, '../..'));
}

/**
 * The pure half of `checkoutTag`, split out so the property that matters —
 * two different roots never collide — is directly testable. Testing it
 * through `checkoutTag()` alone could only ever assert that one checkout
 * agrees with itself, which is the one thing that was never broken.
 */
export function tagForRoot(repoRoot: string): string {
    return crypto.createHash('sha256').update(repoRoot).digest('hex').slice(0, 8);
}

/**
 * The database name for one worker. The single place the scheme is
 * spelled — globalSetup (create), teardown (drop) and getTestDatabaseUrl
 * (connect) must agree, and three hand-rolled copies is how they stop
 * agreeing.
 *
 * Postgres truncates identifiers at 63 bytes, silently. `inflect_test` +
 * tag + suffix is ~24, but a long base name could reach the limit and
 * two workers would then collapse onto ONE database — the exact bug this
 * function exists to prevent, wearing a different hat. So it refuses
 * instead of truncating.
 */
export function perWorkerDbName(baseName: string, workerId: string | number): string {
    const name = `${baseName}_${checkoutTag()}_w${workerId}`;
    if (Buffer.byteLength(name) > 63) {
        throw new Error(
            `Per-worker DB name exceeds Postgres' 63-byte identifier limit: ${name}. ` +
                `Postgres would truncate it silently and two workers could share one database. ` +
                `Shorten the base database name in the test DATABASE_URL.`,
        );
    }
    return name;
}

/** Swap the database name in a Postgres URL, preserving everything else. */
export function withDbName(url: string, dbName: string): string {
    const u = new URL(url);
    u.pathname = '/' + dbName;
    return u.toString();
}

/** The database name from a Postgres URL (`inflect_test`). */
export function getDbName(url: string): string {
    return new URL(url).pathname.replace(/^\//, '');
}

/** Admin connection string (to the `postgres` DB, no Prisma-only params). */
export function adminConnectionString(): string {
    const u = new URL(getBaseTestDatabaseUrl());
    u.pathname = '/postgres';
    u.search = '';
    return u.toString();
}

// --- One Jest run at a time, per (checkout, base database) (2026-09-06) ---
//
// The tag above keeps two CHECKOUTS apart. It does nothing for two
// CONCURRENT RUNS in ONE checkout: both derive the same tag, the same base
// name, and therefore the same `_w1` / `_w2` databases. globalSetup then
// DROPs those `WITH (FORCE)` and TEMPLATE-clones them, while
// `resetDatabase()` TRUNCATEs CASCADE inside the other run's `beforeEach`.
// Neither run is told anything. What surfaces is a deadlock, an FK
// violation, or a suite whose population vanished between its setup and its
// assertion -- failures that read as PRODUCT bugs, in files neither run
// touched, in whichever suite happened to be mid-transaction. That is not
// hypothetical: two agents sharing one worktree hit exactly this, and the
// time went into the product code before anyone suspected the harness.
//
// WHY A REFUSAL RATHER THAN A PER-RUN DATABASE NAME
//
// Folding a per-run discriminator (a pid, say) into the name would let both
// runs proceed -- but only for as long as teardown is reliable, and it
// demonstrably is not. globalTeardown does not run when a run is hard-killed
// (Ctrl-C, the OOM killer, an agent harness stopping a task), and the
// databases that run created outlive it. The cluster this was written
// against was already carrying nine such orphans, named for checkouts that
// no longer exist on the machine. A per-run discriminator multiplies that
// leak by every abandoned run, and the cost is paid later by somebody with
// no way to tell which orphan is still in use.
//
// A SESSION advisory lock has the opposite property: it is held by a
// connection, so the kernel releases it when the process dies. There is no
// state to clean up and nothing to orphan -- a killed run frees the lock on
// its way out. The price is that a second concurrent run is refused, which
// is the trade this repo takes elsewhere too: a loud stop beats a silent
// corruption.
//
// WHY THE KEY IS THE PAIR AND NOT EITHER HALF
//
// The key is (checkout tag, base database name) -- exactly the pair the
// database names are built from, so the lock is contended precisely when the
// names would collide.
//   - NOT the tag alone: a second run pointed at another base via
//     DATABASE_URL_TEST collides with nothing, and refusing it would make the
//     escape hatch the refusal message offers a lie.
//   - NOT the base alone: separate git worktrees derive different tags and
//     therefore different databases. They are the workflow this repo actually
//     uses to run agents in parallel, and refusing them would be a
//     regression. (Two worktrees still share the BASE/template database for
//     the brief pg_terminate_backend + TEMPLATE clone -- the residual
//     documented at the top of this section, unchanged and out of scope.)
//
// The lock is taken on the `postgres` database (`adminConnectionString()`),
// because Postgres advisory locks are scoped per database and every run has
// to contend in the same one.

/** The `(int4, int4)` pair `pg_try_advisory_lock` is called with. */
export type TestDbRunLockKey = readonly [number, number];

/** Who is holding the lock, as far as `pg_stat_activity` can say. */
export interface TestDbRunLockHolder {
    /** The other run's `application_name` -- `inflect-jest-run:<its OS pid>`. */
    applicationName: string;
    /** The POSTGRES backend pid, not the other run's process id. */
    backendPid: number;
    /** ISO timestamp of when that connection opened. */
    backendStart: string;
    /** Null for a unix-socket or loopback-local connection. */
    clientAddr: string | null;
}

export type TestDbRunLockOutcome =
    | { status: 'acquired'; key: TestDbRunLockKey; release: () => Promise<void> }
    | {
          status: 'conflict';
          key: TestDbRunLockKey;
          holder: TestDbRunLockHolder | null;
          message: string;
      }
    /**
     * The check could not be made -- no reachable Postgres, or an unusable
     * URL. Its own state on purpose: "did not check" and "checked, found
     * nothing" are the same silence otherwise, and this repo has been bitten
     * by that shape before. Callers must SAY so rather than proceed quietly.
     */
    | { status: 'unchecked'; key: TestDbRunLockKey; reason: string };

/** Prefix of the `application_name` every run advertises itself under. */
export const RUN_LOCK_LABEL_PREFIX = 'inflect-jest-run:';

/**
 * The lock key for a (checkout, base database) pair.
 *
 * Pure, and takes both inputs explicitly, so the property that matters --
 * different pairs never collide -- is testable without a repo on disk. It
 * deliberately does NOT mention `JEST_WORKER_ID`: the lock is per RUN, and
 * the workers of one run are covered by the run that took it.
 *
 * Two signed int4s rather than one bigint: `pg_try_advisory_lock` accepts
 * both, and the int4 pair keeps the key out of JS `BigInt` entirely.
 */
export function testDbRunLockKey(repoRoot: string, baseName: string): TestDbRunLockKey {
    const digest = crypto
        .createHash('sha256')
        .update(`inflect-test-db-run-lock ${tagForRoot(repoRoot)} ${baseName}`)
        .digest();
    return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

/** `testDbRunLockKey` for THIS checkout and the base DB it would use. */
export function currentTestDbRunLockKey(): TestDbRunLockKey {
    return testDbRunLockKey(path.resolve(__dirname, '../..'), currentBaseNameOrUnknown());
}

function currentBaseNameOrUnknown(): string {
    try {
        return getDbName(getBaseTestDatabaseUrl());
    } catch {
        // An unusable URL still needs a key, so the caller reaches the
        // 'unchecked' branch below with a reason rather than crashing here.
        return '<unresolved>';
    }
}

function describeError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * The refusal text. Split out from the acquisition so it can be read and
 * asserted on without a database, and so the operator advice sits next to
 * the reasoning that produced it rather than inside a query handler.
 */
export function runLockConflictMessage(
    key: TestDbRunLockKey,
    holder: TestDbRunLockHolder | null,
    scope: string,
): string {
    const who = holder
        ? [
              `  holder:    ${holder.applicationName}  (the digits are that run's process id)`,
              `             postgres backend pid ${holder.backendPid}, connected ${holder.backendStart}` +
                  (holder.clientAddr ? `, from ${holder.clientAddr}` : ''),
          ]
        : [
              '  holder:    a session holds the lock but pg_stat_activity did not name it',
              '             (it ended mid-query, or this role cannot see other backends).',
          ];
    return [
        "Refusing to start: another Jest run already holds this checkout's test databases.",
        '',
        `  this run:  ${RUN_LOCK_LABEL_PREFIX}${process.pid}`,
        ...who,
        `  lock:      key ${key[0]}/${key[1]} -- ${scope}`,
        '',
        'Both runs derive the SAME per-worker database names, and both are',
        'destructive to them: globalSetup DROPs them WITH (FORCE) and TEMPLATE-clones',
        'them, and resetDatabase() TRUNCATEs CASCADE in every beforeEach. Continuing',
        'would demolish the other run mid-test, and the damage would surface as',
        'deadlocks, FK violations and empty tables in suites neither run changed --',
        'i.e. as product bugs that are not there.',
        '',
        'Do one of these instead:',
        '  - wait for the other run to finish. The lock is released when its process',
        '    exits, including when it is killed, so nothing has to be cleaned up;',
        '  - give this run its own database:',
        '        CREATE DATABASE inflect_test_scratch TEMPLATE inflect_test;',
        '        DATABASE_URL_TEST=postgresql://test:test@127.0.0.1:5434/inflect_test_scratch \\',
        '            node_modules/.bin/jest <paths>',
        '  - or run it from a separate git worktree, which derives its own tag.',
    ].join('\n');
}

/**
 * Try to take the run lock. Never throws: every failure is a named outcome,
 * because the caller (globalSetup) has to distinguish "somebody else is
 * running" from "there is no database here at all" and act differently.
 */
export async function acquireTestDbRunLock(
    opts: { key?: TestDbRunLockKey; adminUrl?: string; label?: string } = {},
): Promise<TestDbRunLockOutcome> {
    const key = opts.key ?? currentTestDbRunLockKey();
    const scope = `checkout ${checkoutTag()}, base "${currentBaseNameOrUnknown()}"`;

    let connectionString: string;
    try {
        connectionString = opts.adminUrl ?? adminConnectionString();
    } catch (err) {
        return {
            status: 'unchecked',
            key,
            reason: `test database URL is unusable: ${describeError(err)}`,
        };
    }

    // Lazy require, mirroring the pii-middleware require below: this module is
    // imported by every integration suite, and `pg` is only needed here.
    const { Client }: typeof import('pg') = require('pg');
    // The label is how the OTHER run gets named in the refusal. Postgres
    // truncates application_name at NAMEDATALEN-1, so keep it short.
    const applicationName = (opts.label ?? `${RUN_LOCK_LABEL_PREFIX}${process.pid}`).slice(0, 63);
    const client = new Client({ connectionString, application_name: applicationName });

    try {
        await client.connect();
    } catch (err) {
        await client.end().catch(() => {});
        return { status: 'unchecked', key, reason: `cannot reach Postgres (${describeError(err)})` };
    }

    try {
        const got = await client.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_lock($1::int4, $2::int4) AS locked',
            [key[0], key[1]],
        );
        if (got.rows[0]?.locked === true) {
            return {
                status: 'acquired',
                key,
                release: async () => {
                    // Both are best-effort. Ending the connection releases a
                    // SESSION lock on its own, which is the property this
                    // design stands on -- the explicit unlock is only so a
                    // pooled or reused connection would also be correct.
                    await client
                        .query('SELECT pg_advisory_unlock($1::int4, $2::int4)', [key[0], key[1]])
                        .catch(() => {});
                    await client.end().catch(() => {});
                },
            };
        }
        const holder = await describeRunLockHolder(client, key);
        await client.end().catch(() => {});
        return {
            status: 'conflict',
            key,
            holder,
            message: runLockConflictMessage(key, holder, scope),
        };
    } catch (err) {
        await client.end().catch(() => {});
        return {
            status: 'unchecked',
            key,
            reason: `advisory-lock query failed (${describeError(err)})`,
        };
    }
}

async function describeRunLockHolder(
    client: import('pg').Client,
    key: TestDbRunLockKey,
): Promise<TestDbRunLockHolder | null> {
    try {
        // classid/objid are `oid` (unsigned); the key halves are signed int4.
        // Widen both sides to bigint rather than casting a negative int4 to
        // oid and relying on the wrap.
        const res = await client.query<{
            application_name: string | null;
            pid: number;
            backend_start: Date | string | null;
            client_addr: string | null;
        }>(
            `SELECT a.application_name, a.pid, a.backend_start, host(a.client_addr) AS client_addr
               FROM pg_locks l
               JOIN pg_stat_activity a ON a.pid = l.pid
              WHERE l.locktype = 'advisory'
                AND l.granted
                AND l.classid::bigint = $1
                AND l.objid::bigint = $2
              LIMIT 1`,
            [key[0] >>> 0, key[1] >>> 0],
        );
        const row = res.rows[0];
        if (!row) return null;
        return {
            applicationName: row.application_name || '(unnamed session)',
            backendPid: row.pid,
            backendStart: row.backend_start
                ? new Date(row.backend_start).toISOString()
                : '(unknown)',
            clientAddr: row.client_addr,
        };
    } catch {
        // Naming the holder is a nicety; refusing is the guarantee.
        return null;
    }
}

/**
 * globalSetup takes the lock and globalTeardown releases it, and they are two
 * separately-required modules -- so the handle is parked on `globalThis`
 * (the idiom teardown.ts already uses) rather than in module state. Both
 * halves live here so the key is spelled in exactly one place.
 */
type RunLockGlobals = typeof globalThis & {
    __inflectTestDbRunLock?: { release: () => Promise<void> };
};

export function rememberTestDbRunLock(outcome: TestDbRunLockOutcome): void {
    if (outcome.status !== 'acquired') return;
    (globalThis as RunLockGlobals).__inflectTestDbRunLock = { release: outcome.release };
}

export async function releaseTestDbRunLock(): Promise<void> {
    const g = globalThis as RunLockGlobals;
    const held = g.__inflectTestDbRunLock;
    if (!held) return;
    delete g.__inflectTestDbRunLock;
    await held.release().catch(() => {});
}

let _perWorker: PerWorkerInfo | undefined;
function readPerWorker(): PerWorkerInfo {
    if (_perWorker !== undefined) return _perWorker;
    try {
        _perWorker = JSON.parse(fs.readFileSync(PER_WORKER_MARKER, 'utf8')) as PerWorkerInfo;
    } catch {
        _perWorker = { perWorker: false, count: 1, baseName: '', baseUrl: '' };
    }
    return _perWorker;
}

/**
 * True when Jest is running >1 worker (per-worker DB isolation active).
 * Timing-sensitive perf tests use this to skip under CPU contention —
 * their latency budgets are only meaningful in a serial run (CI uses
 * `--runInBand`, where this is false).
 */
export function isParallelRun(): boolean {
    return readPerWorker().perWorker;
}

/**
 * The test database URL for THIS worker. Falls back to the shared base
 * URL when per-worker isolation is off (serial runs / CI).
 */
export function getTestDatabaseUrl(): string {
    const info = readPerWorker();
    // Derive from the marker's base URL when per-worker isolation is on,
    // so the test client + jest.setup.js + globalSetup all agree on the
    // exact base (host/creds/dbname) before appending the worker suffix.
    if (!info.perWorker) return getBaseTestDatabaseUrl();
    const workerId = process.env.JEST_WORKER_ID || '1';
    const base = info.baseUrl || getBaseTestDatabaseUrl();
    return withDbName(base, perWorkerDbName(getDbName(base), workerId));
}

/**
 * Run prisma migrate deploy against the test database.
 * Should be called in globalSetup or once before all integration tests.
 */
export function migrateTestDb(): void {
    // Always migrate the BASE/template DB — globalSetup TEMPLATE-clones
    // it into per-worker DBs, so the migration only needs to run once.
    const url = getBaseTestDatabaseUrl();
    try {
        execSync('npx prisma migrate deploy', {
            cwd: path.resolve(__dirname, '../..'),
            env: { ...process.env, DATABASE_URL: url },
            stdio: 'pipe',
            timeout: 60_000,
        });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[test-db] Migration failed (DB may not be running): ${msg.slice(0, 200)}`);
    }
}

/**
 * Create and return a PrismaClient connected to the test database.
 *
 * Prisma 7 — connections go through the adapter pattern instead of
 * `datasources: { db: { url } }`. The PII encryption middleware is
 * wired via `$extends` (was `$use` in v5). Both adapters take the
 * same env-derived URL.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function prismaTestClient(): any {
    if (!_client) {
        const url = getTestDatabaseUrl();
        const adapter = new PrismaPg({ connectionString: url });
        const base = new PrismaClient({ adapter });
        // GAP-21: wire the same PII middleware production uses so
        // integration tests that write to encrypted-only models
        // (User, AuditorAccount, UserIdentityLink) auto-populate the
        // *Hash columns. Tests that need to bypass the middleware
        // (e.g. rls-isolation.test.ts) construct their own raw
        // PrismaClient and provide emailHash explicitly.
        //
        // Lazy require keeps this file importable from jest's
        // globalSetup context (which doesn't apply the moduleNameMapper
        // for the `@/` alias).

        const { withPiiEncryptionExtension } = require('../../src/lib/security/pii-middleware');
        _client = withPiiEncryptionExtension(base);
    }
    return _client;
}

/**
 * The tables `resetDatabase` names explicitly. Everything reachable from
 * one of these by a foreign key is cleared too, by CASCADE — measured at
 * 105 of the 221 public base tables on 2026-09-07 against the migrated
 * `inflect_test` schema. So this list is a set of ROOTS, not an
 * inventory: a new child table of `Control` needs no entry here.
 *
 * Every name must exist. `resolveResetTables` refuses the whole reset if
 * one does not — see the note on that function for why silence was worse.
 *
 * ── Six names were removed on 2026-09-07
 * They had stopped naming tables and were failing into a bare `catch {}`
 * on every single call. Five of the six cost nothing: they had simply
 * been renamed, and each successor is reached anyway as the child of a
 * root that IS listed (verified against the cascade closure above):
 *
 *     ControlRiskLink   → RiskControl              (child of Control, Risk)
 *     ControlAssetLink  → ControlAsset             (child of Control, Asset)
 *     TestPlan          → ControlTestPlan          (child of Control)
 *     TestRun           → ControlTestRun           (child of ControlTestPlan)
 *     TestRunEvidence   → ControlTestEvidenceLink  (child of ControlTestRun)
 *
 * The sixth is not like the others and is worth knowing about:
 * `Membership` → `TenantMembership`, whose parents are `Tenant` and
 * `User` — NEITHER of which is a root here. So it is NOT in the cascade
 * closure, and this helper has silently not been clearing memberships
 * since the rename. That is left as-is deliberately: adding it would
 * change what every `beforeEach(() => resetDatabase(...))` in the suite
 * sees (memberships would vanish while their tenants and users
 * survived), which is a behavioural decision for whoever needs it and
 * not something to smuggle in beside a flake fix. It is written down
 * here so the next reader is not the third person to rediscover it.
 */
export const RESET_TABLES: readonly string[] = [
    'AuditLog', 'TaskLink', 'TaskComment', 'TaskWatcher', 'Task',
    'EvidenceReview', 'Evidence', 'FileRecord',
    'ControlRequirementLink',
    'Control', 'Risk', 'Asset',
    'AuditPackItem', 'AuditPack', 'AuditCycle',
    'PolicyVersion', 'Policy',
    'VendorDocument', 'VendorAssessment', 'VendorContact', 'Vendor',
    'Framework', 'FrameworkRequirement',
];

/**
 * Check every name in `tables` against `information_schema` and return
 * them, or throw naming the ones that are not there.
 *
 * ## Why this exists
 * The truncate loop this replaced wrapped each statement in a bare
 * `catch {}` commented "Table may not exist in schema — skip silently".
 * A renamed or mistyped table therefore became a no-op that nothing
 * reported: the reset quietly stopped resetting that table and every
 * suite stayed green until one of them saw a row it did not create.
 * Six of the twenty-nine names in the old list were in exactly that
 * state, and had been for long enough that nobody could say when.
 *
 * An absence has to be distinguishable from a success, so this refuses
 * loudly instead. Split out from `resetDatabase` so the refusal is
 * reachable from a test with a name that does not exist — proving the
 * check can fail is the only way to know it can also pass for a reason.
 */
export async function resolveResetTables(
    prisma: PrismaClient,
    tables: readonly string[] = RESET_TABLES,
): Promise<string[]> {
    // No parameters and no interpolation: the whole public table list
    // comes back and the comparison happens in JS.
    const rows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const present = new Set(rows.map((r) => r.table_name));
    const missing = tables.filter((t) => !present.has(t));
    if (missing.length > 0) {
        throw new Error(
            `[test-db] resetDatabase cannot run: ${missing.length} of ${tables.length} ` +
                `listed table(s) do not exist in the test database — ${missing.join(', ')}. ` +
                `A name here that names nothing is a table that silently stops being reset. ` +
                `Either the migration that renamed or dropped it needs the same edit in ` +
                `RESET_TABLES (tests/helpers/db.ts), or the test database is behind ` +
                `\`prisma migrate deploy\`.`,
        );
    }
    // Returned in the caller's order, so concurrent resets request the
    // same locks in the same sequence and cannot deadlock against
    // each other.
    return tables.filter((t) => present.has(t));
}

/**
 * Truncate the application tables in the test database.
 * Preserves system tables (_prisma_migrations, etc).
 *
 * ## One statement, on purpose
 * This used to issue one `TRUNCATE TABLE x CASCADE` per table in a loop
 * — twenty-nine statements (six of which always threw and were
 * swallowed), each its own round trip, each taking and then releasing
 * its own ACCESS EXCLUSIVE lock. On an idle machine that is merely
 * wasteful. Under concurrent load each acquisition queues behind
 * whatever else is touching that table, and the total is bounded by
 * nothing the caller controls: the reported symptom was
 * `tests/integration/agent-registry-isolation.test.ts` failing its
 * `beforeAll` with "Exceeded timeout of 30000 ms for a hook" while
 * passing on an idle box (#2350).
 *
 * Postgres takes a list, so all of it is one statement: one round trip,
 * one lock-acquisition phase, and the locks held together for a single
 * transaction rather than taken and dropped twenty-nine times.
 *
 * Measured 2026-09-07 on an isolated clone of the migrated test schema,
 * all tables empty, on the shared dev box (8 cores, Postgres on
 * 127.0.0.1:5434), per-reset medians:
 *
 *   one client, load average ~4 :  10.5s → 4.7s
 *   four clients on one DB,
 *   load average ~5             :  31.6s → 9.6s   (worst sample 38.4s → 20.6s)
 *
 * The second row is the one that matters: the old median alone exceeded
 * the 30s hook budget. These are wall-clock figures from one machine
 * under a stated load — they are here to show the SHAPE of the change,
 * and nothing asserts them.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
    const tables = await resolveResetTables(prisma);
    if (tables.length === 0) return;
    // Safe to interpolate: every name survived the information_schema
    // check above, so each is a real identifier in this database.
    const list = tables.map((t) => `"${t}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`);
}

/**
 * Disconnect the singleton test client.
 */
export async function disconnectTestClient(): Promise<void> {
    if (_client) {
        await _client.$disconnect();
        _client = null;
    }
}
