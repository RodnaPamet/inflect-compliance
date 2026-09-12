/**
 * AuditLog Immutability — Architectural Guardrails
 *
 * Static analysis tests ensuring no code that can reach the database ever
 * attempts to UPDATE or DELETE AuditLog rows. This is complementary to the
 * DB trigger — the trigger is the enforcement point, but catching
 * violations at code-level prevents runtime surprises.
 *
 * WHY THE PRISMA-CALL SCANS COVER `tests/` TOO (#2510)
 * ────────────────────────────────────────────────────
 * They used to stop at `src/`, and 21 teardowns under `tests/` had grown an
 * `auditLog.deleteMany({ where: { tenantId } })`. Classified mechanically at
 * the base commit, TWELVE of the 21 were already silenced — 6 carrying a
 * literal `.catch(() => {})`, 3 sitting in their own same-line
 * `try { … } catch {}` (each carrying a "best effort" comment), and 3 more
 * passed as thunks into a per-iteration `try { await fn(); } catch {}`
 * upstream. Twelve recorded instances of somebody
 * hitting the trigger and making it quiet. A wrapped call can neither fail
 * nor succeed; it is pure noise that reads as cleanup.
 *
 * The remaining NINE were bare. In seven of those the audit delete is the
 * first statement of its block, so the raise skipped the sibling cleanup
 * that followed it — removing the call is what restores that cleanup. In the
 * other two (`platform-admin-tenant-creation`, `tenant-lifecycle`) it is the
 * LAST statement and the siblings had already run, so nothing was being
 * skipped there; only the leak below applies.
 *
 * FOUR MORE reached the same table through a model-name array
 * (`for (const m of ['lossEvent', 'auditLog', …]) (db as any)[m].deleteMany`).
 * Those carry no `auditLog.deleteMany(` for a textual scan to find, which is
 * why the scan below is not the only check in this file — see
 * `DYNAMIC_MODEL_INDEX_WRITE`.
 *
 * The reason it took 21 sites to notice is the interesting part.
 * `audit_log_immutable` is a `BEFORE DELETE OR UPDATE … FOR EACH ROW`
 * trigger that raises unconditionally — but **a BEFORE-ROW trigger never
 * fires on a zero-row match.** So the statement is a silent no-op on any box
 * whose AuditLog holds nothing for that tenant, and raises the moment it
 * holds something. An empty selection is a PASS, here in a teardown rather
 * than an assertion. Prisma maps the SQLSTATE to P2003 ("Foreign key
 * constraint violated on the (not available)"), which points nowhere near
 * the cause. #2509 shipped one of these — green locally, RED in CI — and
 * that is what surfaced the class.
 *
 * The rows are safe to leave in the sense that matters — the trail is
 * append-only by design and those suites use tenant ids unique to
 * themselves, so no assertion can see another run's rows. Be precise about
 * the cost, though: `AuditLog_tenantId_fkey` is ON DELETE RESTRICT, so the
 * surviving audit rows also block the teardown's own `tenant.deleteMany`,
 * and each such run leaks its Tenant row as well. That was ALREADY happening
 * — the delete raised and was swallowed — so removing these calls does not
 * cause it; it just stops hiding it. The shared `inflect_test` database grows
 * accordingly, which is a real cost tracked separately rather than a reason
 * to keep a call that cannot work. A suite that genuinely
 * needs a clean slate uses the repo's other idiom — a
 * `SET LOCAL session_replication_role = 'replica'` transaction around a raw
 * `DELETE FROM "AuditLog"`, which disables the trigger instead of tripping
 * it. That idiom is why the two RAW-SQL scans below stay scoped to `src/`;
 * see the comment above them.
 *
 * POPULATION COMES FROM GIT
 * ─────────────────────────
 * `repoFiles()` from `tests/helpers/repo-files.ts`, not an `fs.readdirSync`
 * walk with a hand-written `node_modules` skip. That walk was the
 * anti-pattern CLAUDE.md documents under "A source scan's population comes
 * from git": the skip list is a hand-maintained denominator and nothing
 * checks it against reality.
 *
 * BE PRECISE ABOUT WHAT THAT DID AND DID NOT COST HERE. This guard was NOT
 * in violation of `tests/guardrails/source-scan-population.test.ts`. That
 * ratchet fires on a binding of `path.resolve(__dirname, '../..')`, and this
 * one bound `path.resolve(__dirname, '..', '..', 'src')` — a third segment,
 * which stops the match. Nor would widening the same walk to `tests/` have
 * reached `.claude/worktrees/<id>/`: that tree is a SIBLING of `tests/`, not
 * inside it. Measured today the two populations agree exactly — the walk and
 * `repoFiles({ under: 'tests' })` both yield 2382 files.
 *
 * What the move buys is that the denominator stops being hand-maintained.
 * The skip list knows about `node_modules` and dot-directories and nothing
 * else, while `.gitignore` already excludes `tests/load/results/`,
 * `tests/stress/results/` and `tests/e2e/.tenant-tracker.jsonl` — and
 * nothing would ever make the list learn about the next entry. Asking git
 * removes the list, and with it the question.
 */
import * as fs from 'fs';
import * as path from 'path';

import { repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

const SRC_DIR = path.resolve(__dirname, '..', '..', 'src');
const PRISMA_DIR = path.resolve(__dirname, '..', '..', 'prisma');

/**
 * Population floors. Every scan below reports violations as an empty array,
 * and an empty array is also what a scan of ZERO files produces — the same
 * "empty selection is a PASS" shape that let the 21 teardowns survive. These
 * floors make a collapsed population fail loudly instead. They are
 * order-of-magnitude rather than exact, so ordinary churn never touches them
 * (measured 2026-09-12: 2660 files under `src`, 2382 under `tests`; the
 * prisma-mocking doubles that `reachesDatabase` filters out are a low-
 * hundreds minority of the latter). A precise count is deliberately NOT
 * recorded here — it is derived data, it would rot on the next test added,
 * and nothing below asserts on it.
 */
const MIN_SRC_FILES = 1500;
const MIN_TEST_FILES = 1500;

const UPDATE_CALL = /auditLog\s*\.\s*(update|updateMany)\s*\(/;
const DELETE_CALL = /auditLog\s*\.\s*(delete|deleteMany)\s*\(/;

/**
 * The SAME write, spelled so the two patterns above cannot see it.
 *
 * `for (const m of ['lossEvent', 'auditLog', …]) await (db as any)[m].deleteMany(…)`
 * contains no `auditLog.deleteMany(` anywhere — the model name is a string
 * in an array and the call is a dynamic index. Four such teardowns existed;
 * three were found by reading and the fourth stayed GREEN under the widened
 * textual scan, which is how it survived being fixed in the same pass as its
 * three siblings. A guard that cannot see a shape does not protect against
 * it, and the shape is the cheap one to reach for next time.
 *
 * BOTH halves are required to report a violation, which is what keeps this
 * from firing on the many files that legitimately mention `'auditLog'` (a
 * `where: { action: … }` filter, a model-name union, a comment). Measured
 * across every file git lists: exactly one file in the repo satisfies both,
 * and it was the defect.
 */
const DYNAMIC_MODEL_INDEX_WRITE = /\[\s*[A-Za-z_$][\w$]*\s*\]\s*\.\s*(delete|deleteMany|update|updateMany)\s*\(/;
const AUDIT_LOG_AS_STRING = /['"`]auditLog['"`]/;
const RAW_UPDATE = /UPDATE\s+["']?AuditLog["']?/i;
const RAW_DELETE = /DELETE\s+(FROM\s+)?["']?AuditLog["']?/i;

/**
 * Can a Prisma call written in this file reach Postgres?
 *
 * A file that swaps the client module for a double **and** never builds a
 * real client cannot: `prismaTestClient()` and `new PrismaClient(…)` are the
 * only other ways to obtain one in this repo (`tests/helpers/db.ts` exports
 * the former as a function, not a live instance), and a mocked
 * `@/lib/prisma` hands back the double. So an `auditLog.deleteMany` in such
 * a file deletes from an in-memory array.
 *
 * This is DERIVED from the file's own code, not an allowlist of names, and
 * it is what lets the DSAR erasure oracle exist: the entire job of the C2
 * case in `tests/guardrails/dsar-workflow-coverage.test.ts` is to drive a
 * deliberately-wrong `auditLog.deleteMany(…)` through an instrumented probe
 * and assert the oracle reports `AUDIT_DELETE_ISSUED`. Forbidding that call
 * would delete the detector for the very behaviour this file guards.
 *
 * Both halves are load-bearing. Mocking the module while ALSO calling
 * `prismaTestClient()` or `new PrismaClient(…)` leaves a live connection in
 * the file, so such a file is scanned.
 */
const MOCKS_PRISMA_MODULE =
    /jest\s*\.\s*(?:mock|doMock)\s*\(\s*['"](?:@\/lib\/prisma|@prisma\/client)['"]/;
const BUILDS_REAL_CLIENT = /\bnew\s+PrismaClient\s*\(|\bprismaTestClient\s*\(/;

export function reachesDatabase(src: string): boolean {
    return !MOCKS_PRISMA_MODULE.test(src) || BUILDS_REAL_CLIENT.test(src);
}

/**
 * Self-skip, not an exemption — the same call this file's mutation proof
 * makes on synthetic sources is a real call expression in this file's own
 * text, so a scan over `tests/` reads the detector as a violation. Resolved
 * from `__filename` so a rename cannot leave a stale literal behind.
 */
const SELF = repoRelative(__filename).replace(/\.js$/, '.ts');

interface ScannedFile {
    rel: string;
    /** Comment-masked source: a JSDoc that QUOTES the forbidden call — e.g.
     *  `tests/helpers/dsar-erasure-probe.ts` explaining the mutation it
     *  replaced — is prose, not a violation. */
    code: string;
}

const cache = new Map<string, ScannedFile[]>();

/** Files under `subtree` whose audit writes would reach a real database. */
function dbReachingSources(subtree: string): ScannedFile[] {
    const hit = cache.get(subtree);
    if (hit) return hit;
    const out: ScannedFile[] = [];
    for (const abs of repoFiles({ under: subtree, extensions: ['.ts', '.tsx'] })) {
        const rel = repoRelative(abs);
        if (rel === SELF) continue;
        const code = codeOf(fs.readFileSync(abs, 'utf-8'));
        if (!reachesDatabase(code)) continue;
        out.push({ rel, code });
    }
    cache.set(subtree, out);
    return out;
}

/** Repo-relative paths whose code matches `pattern`, across `subtrees`. */
function scan(subtrees: readonly string[], pattern: RegExp, label: string): string[] {
    const violations: string[] = [];
    for (const subtree of subtrees) {
        for (const { rel, code } of dbReachingSources(subtree)) {
            if (pattern.test(code)) violations.push(`${rel}: ${label}`);
        }
    }
    return violations;
}

describe('AuditLog Immutability Guardrails', () => {
    it('scans a real population — an empty scan would report zero violations', () => {
        expect(repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }).length)
            .toBeGreaterThan(MIN_SRC_FILES);
        expect(repoFiles({ under: 'tests', extensions: ['.ts', '.tsx'] }).length)
            .toBeGreaterThan(MIN_TEST_FILES);
        // …and narrowing to db-reaching files does not swallow the population
        // either: almost nothing in either tree mocks the client module.
        expect(dbReachingSources('src').length).toBeGreaterThan(MIN_SRC_FILES);
        expect(dbReachingSources('tests').length).toBeGreaterThan(MIN_TEST_FILES);
    });

    it('discriminates db-reaching code from an in-memory double (mutation proof)', () => {
        // The scans below report `[]` when they find nothing, so this proves
        // the classifier and the patterns discriminate rather than matching
        // everything or nothing.
        const realClient = `
            const db = new PrismaClient();
            await db.auditLog.deleteMany({ where: { tenantId } });
        `;
        const mockedDouble = `
            jest.mock('@/lib/prisma', () => ({ prisma: probe() }));
            await dbOf(options).auditLog.deleteMany({ where: { userId } });
        `;
        const mockedButAlsoLive = `
            jest.mock('@/lib/prisma', () => ({ prisma: probe() }));
            const real = prismaTestClient();
            await real.auditLog.updateMany({ where: { tenantId }, data: {} });
        `;
        const proseOnly = codeOf(
            '/** An earlier draft called prisma.auditLog.deleteMany({ where }). */\nconst x = 1;\n',
        );

        expect(reachesDatabase(realClient)).toBe(true);
        expect(reachesDatabase(mockedDouble)).toBe(false);
        expect(reachesDatabase(mockedButAlsoLive)).toBe(true);

        expect(DELETE_CALL.test(realClient)).toBe(true);
        expect(UPDATE_CALL.test(mockedButAlsoLive)).toBe(true);
        expect(DELETE_CALL.test(proseOnly)).toBe(false);
        expect(UPDATE_CALL.test(proseOnly)).toBe(false);

        // The array-driven shape, and the reason it needs its own pattern:
        // the two above see NOTHING in it.
        const viaModelArray = `
            for (const m of ['lossEvent', 'auditLog', 'risk'] as const) {
                await (globalPrisma as any)[m].deleteMany({ where: t });
            }
        `;
        expect(DELETE_CALL.test(viaModelArray)).toBe(false);
        expect(UPDATE_CALL.test(viaModelArray)).toBe(false);
        expect(DYNAMIC_MODEL_INDEX_WRITE.test(viaModelArray)).toBe(true);
        expect(AUDIT_LOG_AS_STRING.test(viaModelArray)).toBe(true);

        // …and both halves are load-bearing. A dynamic delete over models
        // that are not AuditLog is ordinary teardown, and a file that merely
        // NAMES the model is prose or a filter.
        const dynamicButNotAudit = `
            for (const m of ['lossEvent', 'risk'] as const) {
                await (globalPrisma as any)[m].deleteMany({ where: t });
            }
        `;
        const namesAuditLogOnly = `await db.thing.findMany({ where: { model: 'auditLog' } });`;
        expect(
            DYNAMIC_MODEL_INDEX_WRITE.test(dynamicButNotAudit) &&
                AUDIT_LOG_AS_STRING.test(dynamicButNotAudit),
        ).toBe(false);
        expect(
            DYNAMIC_MODEL_INDEX_WRITE.test(namesAuditLogOnly) &&
                AUDIT_LOG_AS_STRING.test(namesAuditLogOnly),
        ).toBe(false);
    });

    it('no db-reaching code calls the Prisma update verbs on AuditLog', () => {
        expect(scan(['src', 'tests'], UPDATE_CALL, 'mutates audit rows')).toEqual([]);
    });

    it('no db-reaching code calls the Prisma delete verbs on AuditLog', () => {
        expect(scan(['src', 'tests'], DELETE_CALL, 'removes audit rows')).toEqual([]);
    });

    it('no db-reaching code reaches AuditLog through a dynamic model index', () => {
        // The array-driven spelling of the same write. Reported separately
        // from the two scans above because the failure message has to say
        // WHICH shape was found — "removes audit rows" sends a reader looking
        // for a call that is not written anywhere in the file.
        const violations: string[] = [];
        for (const subtree of ['src', 'tests']) {
            for (const { rel, code } of dbReachingSources(subtree)) {
                if (DYNAMIC_MODEL_INDEX_WRITE.test(code) && AUDIT_LOG_AS_STRING.test(code)) {
                    violations.push(`${rel}: names 'auditLog' beside a dynamic [model].delete/update`);
                }
            }
        }
        expect(violations).toEqual([]);
    });

    // ── Raw SQL: `src/` only, deliberately ────────────────────────────
    //
    // Under `tests/` the established teardown idiom is a
    // `SET LOCAL session_replication_role = 'replica'` transaction wrapped
    // around `DELETE FROM "AuditLog"` — 116 call sites across ~95 files,
    // which DISABLE the trigger rather than trip it, and therefore actually
    // delete. That is a different finding from #2510's: a visible, working
    // bypass instead of a call that could neither fail nor succeed. Widening
    // these two scans would turn ~95 files red on a decision nobody has
    // taken, so they stay at `src/` and the bypass is tracked separately.
    // Application code has no such idiom and no exception.

    it('no raw SQL UPDATE on AuditLog table in application code', () => {
        expect(scan(['src'], RAW_UPDATE, 'raw SQL UPDATE on AuditLog')).toEqual([]);
    });

    it('no raw SQL DELETE on AuditLog table in application code', () => {
        expect(scan(['src'], RAW_DELETE, 'raw SQL DELETE on AuditLog')).toEqual([]);
    });

    test('Prisma audit middleware excludes AuditLog from WRITE_ACTIONS', () => {
        const prismaFile = path.resolve(SRC_DIR, 'lib', 'prisma.ts');
        const content = fs.readFileSync(prismaFile, 'utf-8');

        // The EXCLUDED_MODELS set must include 'AuditLog'
        expect(content).toMatch(/EXCLUDED_MODELS.*=.*new\s+Set\(\[[\s\S]*?'AuditLog'/);
    });

    test('migration file for immutability trigger exists', () => {
        const migrationDir = path.join(PRISMA_DIR, 'migrations');
        const dirs = fs.readdirSync(migrationDir);
        const immutableMigration = dirs.find(d => d.includes('audit_log_immutable'));

        expect(immutableMigration).toBeDefined();

        // Verify it contains the trigger function and trigger creation
        const sqlFile = path.join(migrationDir, immutableMigration!, 'migration.sql');
        const sql = fs.readFileSync(sqlFile, 'utf-8');

        expect(sql).toContain('audit_log_immutable_guard');
        expect(sql).toContain('BEFORE UPDATE OR DELETE');
        expect(sql).toContain('IMMUTABLE_AUDIT_LOG');
        expect(sql).toContain('REVOKE UPDATE');
        expect(sql).toContain('REVOKE');
    });
});
