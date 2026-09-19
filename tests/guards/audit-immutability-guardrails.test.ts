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
 * cause it; it just stops hiding it.
 *
 * WHY THE RAW-SQL SCANS NOW COVER `tests/` TOO (#2523)
 * ────────────────────────────────────────────────────
 * The note above used to end "…which is a real cost tracked separately", and
 * the two RAW-SQL scans below deliberately stopped at `src/`, because the
 * repo's OTHER idiom — a `SET LOCAL session_replication_role = 'replica'`
 * transaction around a raw `DELETE FROM "AuditLog"` — disables the trigger
 * instead of tripping it, and therefore actually deletes. That is a
 * different finding from #2510's: a visible, working bypass rather than a
 * call that could neither fail nor succeed. Measured at #2523's base commit:
 * 134 raw audit DML statements across 100 files, and widening the scans
 * would have turned all of them red on a decision nobody had taken.
 *
 * BE PRECISE ABOUT THAT 134, BECAUSE IT IS THREE DIFFERENT THINGS.
 * Classified mechanically at the base commit: **113** carried the bypass and
 * therefore worked. **12** are the opposite of a bypass — the immutability
 * ASSERTIONS, which issue the forbidden statement deliberately and assert the
 * trigger refuses it. The remaining **9** were simply BROKEN: no replica-role
 * transaction anywhere, so the statement raises the moment the table is
 * non-empty. Those nine were #2510's failure mode wearing raw SQL, and
 * routing them through the helper is what makes them start working.
 *
 * THE NINE, NAMED, because "which of these actually did anything" is the
 * question a reader arrives with. All at base commit `f31514057`, one
 * statement each — eight a raw `DELETE FROM "AuditLog"` with no bypass:
 *
 *     tests/integration/audit-middleware.test.ts
 *     tests/integration/automation-actor-authority.test.ts
 *     tests/integration/automation-update-status-gates.test.ts
 *     tests/integration/control-test-flow.test.ts
 *     tests/integration/data-lifecycle.test.ts
 *     tests/integration/epic8-regression-guards.test.ts
 *     tests/integration/task-source-reconcile.test.ts
 *     tests/integration/task-status-change-sequence.test.ts
 *
 * …and the ninth an `UPDATE "AuditLog"`, in
 * `tests/guardrails/dsar-workflow-coverage.test.ts`, described below. Eight
 * of the nine reach a real database and now work through the helper; that
 * ninth does not reach one at all.
 *
 * (Commit `bb52047e0` claimed this list was already here. It was not — it
 * named only two of the nine, one of those in an unrelated paragraph. The
 * list above is what makes that claim true, added after the #2533 review
 * caught it.)
 *
 * The decision was taken: ALLOW the bypass, through exactly one documented
 * helper, and forbid the idiom everywhere else. `tests/helpers/audit-cleanup.ts`
 * now owns it, and these scans read `['src', 'tests']` with that ONE module
 * exempt.
 *
 * ONE site does not call the helper, and should not — it is the ninth of
 * those nine. The C6 case in `tests/guardrails/dsar-workflow-coverage.test.ts`
 * drives a deliberately wrong `UPDATE "AuditLog" …` through an instrumented
 * probe to prove the erasure oracle reports `UNVERIFIABLE_RAW_SQL`. That file
 * mocks `@/lib/prisma` and builds no real client, so `reachesDatabase`
 * already excludes it — the same reasoning recorded above for the
 * Prisma-verb scans. Rewriting it would delete the detector.
 *
 * THE EXEMPTION IS DERIVED, NOT NAMED. There is no allowlist array of
 * filenames here. The helper exports its own `__filename` and this file runs
 * it through `repoRelative`, the same way it resolves its own SELF skip — so
 * renaming or moving the helper moves the exemption with it, and deleting it
 * breaks this file's import rather than silently widening what is permitted.
 *
 * THE SECOND EXEMPTION, AND WHY IT IS SPELLED DIFFERENTLY (#2287 Stage 3)
 * ──────────────────────────────────────────────────────────────────────
 * The Prisma UPDATE scan now has exactly one exemption of its own:
 * `src/app-layer/jobs/dsar-erasure.ts`. That is not a hole somebody opened to
 * get a diff green — it is the one write the DATABASE itself was narrowed to
 * permit. `20260917130000_audit_log_immutable_permit_pseudonymization`
 * replaced the unconditional refusal with a single allowed shape: `userId`
 * from a value to NULL, `to_jsonb(NEW) - 'userId' = to_jsonb(OLD) - 'userId'`.
 * GDPR Art. 17 erasure is that write, and there is nowhere else for it to
 * live. DELETE is still refused by the trigger unconditionally, and this file
 * still refuses it there too — the exemption is on the UPDATE scan ONLY.
 *
 * It is a PATH CONSTANT rather than an exported `__filename`, deliberately.
 * The cleanup helper can export its own path because it is a test module;
 * making a `src/` module export `__filename` for a guard's benefit puts
 * test-only machinery in production source, and `__filename` is not a thing
 * to depend on across a bundler. What replaces the derivation is verification:
 * `the DSAR pseudonymization exemption is narrow, load-bearing and live`
 * asserts the path resolves to a file these scans actually read, that
 * removing the exemption would turn the UPDATE scan RED, and that the file it
 * covers contains exactly ONE audit UPDATE, inside the erasure transaction,
 * whose `data` is the single column the trigger permits. A rename fails that
 * test loudly AND surfaces the renamed file in the scan — both directions.
 *
 * AND IT SETTLES THE COST NOTED ABOVE: with teardowns actually deleting
 * their audit rows, `AuditLog_tenantId_fkey` stops firing and the suites
 * stop leaking a Tenant row per run. Measured on `audit-middleware.test.ts`
 * against the shared `inflect_test`: one run of the old teardown left +1
 * Tenant row and +8 AuditLog rows behind, through the helper +0 and +0 —
 * and the suite reported 9/9 passing either way, which is why a leaking
 * teardown is invisible from inside the suite that leaks.
 *
 * WHAT THE SCANS COULD NOT SEE, AND WHAT THEY STILL CANNOT (#2533 review)
 * ──────────────────────────────────────────────────────────────────────
 * Three spellings were demonstrated GREEN against the shipped patterns, by
 * mutation rather than by reading. All three are ordinary SQL, not exotica:
 *
 *   1. `DELETE FROM "OrgAuditLog" …` — the OTHER trigger-protected trail,
 *      the one `deleteOrgAuditRowsForOrganizations` exists for. The literal
 *      patterns wanted `AuditLog` immediately after the optional quote, so
 *      the `Org` prefix missed them; the interpolated scan needs a `${`,
 *      which a literal has not got. A full replica-role transaction around
 *      that statement, dropped into an ordinary test file, left this suite
 *      11/11 green. This PR is the one that brought `OrgAuditLog` into
 *      scope, so this PR is the one that left that trail unguarded.
 *   2. `DELETE FROM "public"."AuditLog" …` — same defect, schema qualifier
 *      instead of a table-name prefix.
 *   3. `TRUNCATE TABLE "AuditLog"` — and this one is the worst of the
 *      three, because it needs NO bypass whatsoever. `audit_log_immutable`
 *      is a BEFORE **ROW** trigger and TRUNCATE is a statement-level
 *      operation, so it never fires: the trail is gone with no
 *      `session_replication_role` anywhere for a reader to notice.
 *
 * All three are covered now — `(?:Org)?`, an optional schema qualifier, and
 * a third literal pattern — and widening cost nothing: measured across the
 * scanned population, not one existing file newly matches.
 *
 * STILL BLIND, and stated plainly rather than left as "a spelling nobody
 * has written yet":
 *
 *   - THE LIST ONE MODULE AWAY. `AUDIT_TABLE_AS_STRING` is evaluated
 *     per-file, so the interpolated-table scan only fires while the
 *     `['Control', 'AuditLog', …]` literal and the
 *     `DELETE FROM "${table}"` that consumes it live in the SAME file.
 *     Moving `TENANT_CHILD_TABLES` into a shared constants module would
 *     reopen exactly the shape this PR exists to close, silently, with no
 *     file changing behaviour. Re-demonstrated GREEN 13/13 against the
 *     WIDENED patterns, with the list in one new module and the loop in
 *     another. Closing it needs import resolution, not another regex, and
 *     is not attempted here.
 *   - CONCATENATION. `'DELETE FROM "' + table + '"'` matches nothing.
 *   - THE ROLE SWITCH ITSELF IS NOT POLICED. These scans forbid raw DML
 *     against the audit TABLES; they say nothing about
 *     `session_replication_role`. Measured on this branch, 72 files under
 *     `tests/` besides the helper still open their own replica-role
 *     transactions — 94 statements — for `TenantMembership`'s last-OWNER
 *     guard and for FK ordering, and each is a natural place for a future
 *     audit delete to be written. A scan on the role switch itself, with
 *     the same derived exemption, would be the stronger form of this guard.
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
 * inside it. The two populations agreed exactly when the move landed
 * (#2510) — the walk and `repoFiles({ under: 'tests' })` yielded the same
 * file for file. No live count is quoted here on purpose: the figure that
 * used to sit in this sentence ("both yield 2382 files") was already stale
 * by ten when #2533's review read it, which is an argument for asking git
 * rather than for pasting in a fresher number.
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

import { AUDIT_CLEANUP_MODULE } from '../helpers/audit-cleanup';
import { REPO_ROOT, repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf, functionBodyOf, sqlCodeOf } from '../helpers/source-blocks';

const SRC_DIR = path.resolve(__dirname, '..', '..', 'src');
const PRISMA_DIR = path.resolve(__dirname, '..', '..', 'prisma');

/**
 * Population floors. Every scan below reports violations as an empty array,
 * and an empty array is also what a scan of ZERO files produces — the same
 * "empty selection is a PASS" shape that let the 21 teardowns survive. These
 * floors make a collapsed population fail loudly instead. They are
 * order-of-magnitude rather than exact, so ordinary churn never touches
 * them: both trees hold thousands of files and the prisma-mocking doubles
 * that `reachesDatabase` filters out are a low-hundreds minority of
 * `tests/`.
 *
 * A PRECISE COUNT IS DELIBERATELY NOT RECORDED HERE. It is derived data, it
 * rots on the next test added, and nothing below asserts on it — this
 * docblock used to carry one anyway ("2660 files under `src`, 2382 under
 * `tests`") and both halves were stale inside a day. The live figure is not
 * lost by leaving it out: `toBeGreaterThan` prints the actual count as
 * `Received:` the moment the floor is the thing that fails, which is the
 * only moment it matters.
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
/**
 * A LITERAL audit table in raw SQL. Both trails, and an optional schema
 * qualifier — neither is decoration; see the "#2533 review" section above.
 *
 * These two used to read `["']?AuditLog["']?`, which requires `AuditLog`
 * DIRECTLY after the optional quote. So `DELETE FROM "OrgAuditLog"` matched
 * neither of them (wrong table name) nor the interpolated scan below (it
 * needs a `${`), and `DELETE FROM "public"."AuditLog"` matched nothing
 * either. A complete replica-role transaction around either statement, in an
 * ordinary test file, left this suite 11/11 green.
 *
 * `RAW_TRUNCATE` is new and is the one to read twice: a BEFORE **ROW**
 * trigger does not fire on a statement-level TRUNCATE at all, so
 * `TRUNCATE TABLE "AuditLog"` destroys the trail needing no bypass to
 * disable and leaving none for a reader to spot.
 */
const RAW_UPDATE = /UPDATE\s+(?:["']?\w+["']?\s*\.\s*)?["']?(?:Org)?AuditLog["']?/i;
const RAW_DELETE = /DELETE\s+(?:FROM\s+)?(?:["']?\w+["']?\s*\.\s*)?["']?(?:Org)?AuditLog["']?/i;
const RAW_TRUNCATE =
    /TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?(?:["']?\w+["']?\s*\.\s*)?["']?(?:Org)?AuditLog["']?/i;

/**
 * The raw-SQL twin of `DYNAMIC_MODEL_INDEX_WRITE`, and it existed here too.
 *
 * `for (const table of TENANT_CHILD_TABLES) await tx.$executeRawUnsafe(
 *      \`DELETE FROM "${table}" WHERE "tenantId" = $1\`, id)`
 *
 * contains no `DELETE FROM "AuditLog"` for `RAW_DELETE` to find, yet
 * 'AuditLog' sat in that list among two dozen ordinary table names — no
 * position is recorded here, because an entry's index is derived data that
 * the next edit to the list would rot. Three files under `tests/` were
 * written this way. A textual guard cannot see a shape it has no
 * pattern for, and this is the cheap shape to reach for next time.
 *
 * BOTH halves are required, which keeps it off the many files that
 * legitimately interpolate a table name (`soft-delete-lifecycle.ts`,
 * `key-rotation.ts`, the DEK-rotation jobs) without ever naming an audit
 * table, and off the files that name one in prose or a filter.
 *
 * THE UPDATE ARM NEEDS `SET`, AND THAT IS NOT TIDINESS. Written as a bare
 * `UPDATE\s+["'`]?\$\{` it matched `` `AMW Risk Update ${testRunId}` `` —
 * an English fixture title in `audit-middleware.test.ts`, three times over.
 * "Update " before an interpolation is ordinary prose; `UPDATE "<x>" SET` is
 * not. `DELETE FROM` is already specific enough to stand alone.
 */
const RAW_DML_ON_INTERPOLATED_TABLE =
    /DELETE\s+FROM\s+["'`]?\$\{|UPDATE\s+["'`]?\$\{[^}]*\}["'`]?\s+SET\b/i;
const AUDIT_TABLE_AS_STRING = /['"`](?:Org)?AuditLog['"`]/;

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

/**
 * The ONE module allowed to write raw SQL against the audit trails.
 *
 * Derived, never named: `AUDIT_CLEANUP_MODULE` is that module's own
 * `__filename`, resolved here exactly the way SELF is. A rename cannot leave
 * a stale literal behind, and a deletion breaks the import above rather than
 * quietly removing the guard's only exception. There is deliberately no
 * allowlist array of filenames in this file.
 */
const AUDIT_CLEANUP_HELPER = repoRelative(AUDIT_CLEANUP_MODULE).replace(/\.js$/, '.ts');

/**
 * The ONE `src/` module permitted to UPDATE an audit row through Prisma:
 * DSAR erasure's pseudonymization (`userId` -> NULL). See the "SECOND
 * EXEMPTION" section of this file's header for why it exists, why it is a
 * path rather than a derivation, and what verifies it instead.
 *
 * Exempt from `UPDATE_CALL` and NOTHING ELSE — the delete verbs, the raw-SQL
 * patterns and the dynamic-model-index shape all still apply to it.
 */
const DSAR_ERASURE_SOURCE = repoRelative(
    path.resolve(SRC_DIR, 'app-layer', 'jobs', 'dsar-erasure.ts'),
);

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

/**
 * Repo-relative paths whose code matches `pattern`, across `subtrees`.
 *
 * `exemptRel` is a single DERIVED path, not a list — the same shape as the
 * `rel === SELF` skip above. Callers pass `AUDIT_CLEANUP_HELPER`; nothing
 * here can be extended into an allowlist without changing this signature.
 */
function scan(
    subtrees: readonly string[],
    pattern: RegExp,
    label: string,
    exemptRel?: string,
): string[] {
    const violations: string[] = [];
    for (const subtree of subtrees) {
        for (const { rel, code } of dbReachingSources(subtree)) {
            if (rel === exemptRel) continue;
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
        // One exemption, and it is the write the DB trigger was narrowed to
        // permit — see `DSAR_ERASURE_SOURCE` and the test below, which is what
        // keeps this from being a hole rather than a carve-out.
        expect(scan(['src', 'tests'], UPDATE_CALL, 'mutates audit rows', DSAR_ERASURE_SOURCE))
            .toEqual([]);
    });

    it('the DSAR pseudonymization exemption is narrow, load-bearing and live', () => {
        // It names a file these scans actually read. A rename breaks this line
        // AND surfaces the renamed file in the scan above — the exemption
        // cannot rot into one that silently covers nothing.
        expect(DSAR_ERASURE_SOURCE).toBe('src/app-layer/jobs/dsar-erasure.ts');
        expect(dbReachingSources('src').some((f) => f.rel === DSAR_ERASURE_SOURCE)).toBe(true);

        const code = codeOf(
            fs.readFileSync(path.resolve(REPO_ROOT, DSAR_ERASURE_SOURCE), 'utf-8'),
        );

        // LOAD-BEARING, not decorative: without the exemption the scan above
        // is RED. (Measured that way — it was, before the exemption existed.)
        expect(UPDATE_CALL.test(code)).toBe(true);

        // NARROW, in three directions.
        //
        // (1) UPDATE only. The trigger refuses DELETE on an audit row
        //     unconditionally and always will; nothing about erasure changes
        //     that, so the delete verbs are forbidden here as everywhere.
        expect(DELETE_CALL.test(code)).toBe(false);
        // (2) Prisma only. Raw SQL against the trail is not covered by this
        //     exemption in any spelling, and neither is the dynamic index.
        expect(RAW_UPDATE.test(code)).toBe(false);
        expect(RAW_DELETE.test(code)).toBe(false);
        expect(RAW_TRUNCATE.test(code)).toBe(false);
        expect(DYNAMIC_MODEL_INDEX_WRITE.test(code) && AUDIT_LOG_AS_STRING.test(code)).toBe(false);
        // (3) ONE call, in the erasure transaction, writing the ONE column the
        //     trigger permits. `to_jsonb(NEW) - 'userId' = to_jsonb(OLD) -
        //     'userId'` is the database half of this same claim; a second
        //     field in that `data` is how the hash chain gets rewritten inside
        //     something called a pseudonymization.
        expect(code.match(/auditLog\s*\.\s*(?:update|updateMany)\s*\(/g)).toHaveLength(1);
        const eraseBody = functionBodyOf(code, 'eraseUserWithin');
        expect(UPDATE_CALL.test(eraseBody)).toBe(true);
        expect(eraseBody).toMatch(/data:\s*\{\s*userId:\s*null\s*,?\s*\}/);
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

    // ── Raw SQL: `src/` AND `tests/`, one derived exemption (#2523) ───

    it('the literal raw-SQL patterns see both trails, a schema qualifier and TRUNCATE', () => {
        // Every line below was GREEN against the patterns this PR first
        // shipped — not as a hypothetical, as a mutation: the Org statement
        // went into an ordinary test file wrapped in a full replica-role
        // transaction and the suite reported 11/11. These are the anchors
        // for that fix, so that narrowing the patterns back reddens HERE
        // rather than only on whatever file happens to carry the shape.
        expect(RAW_DELETE.test('DELETE FROM "OrgAuditLog" WHERE "organizationId" = $1')).toBe(true);
        expect(RAW_DELETE.test('DELETE FROM "public"."AuditLog" WHERE "tenantId" = $1')).toBe(true);
        expect(RAW_UPDATE.test('UPDATE "OrgAuditLog" SET "actorType" = $1')).toBe(true);
        expect(RAW_TRUNCATE.test('TRUNCATE TABLE "AuditLog"')).toBe(true);
        expect(RAW_TRUNCATE.test('TRUNCATE "OrgAuditLog" CASCADE')).toBe(true);

        // …and they still DISCRIMINATE. A widened pattern that matched every
        // raw statement would make the three scans below vacuous in the
        // opposite direction — red on ordinary teardown of ordinary tables.
        expect(RAW_DELETE.test('DELETE FROM "TenantMembership" WHERE "tenantId" = $1')).toBe(false);
        expect(RAW_UPDATE.test('UPDATE "Tenant" SET "name" = $1')).toBe(false);
        expect(RAW_TRUNCATE.test('TRUNCATE TABLE "Control"')).toBe(false);

        // The shapes that remain blind, asserted rather than described, so
        // that closing one of them turns this line red and forces the
        // docblock above to be corrected in the same diff.
        expect(RAW_DELETE.test(`'DELETE FROM "' + table + '"'`)).toBe(false);
    });

    it('the raw-SQL exemption resolves to a file these scans actually read', () => {
        // If the derivation breaks, this fails FIRST and says so, instead of
        // the exemption silently covering nothing (or, worse, the helper's
        // own sanctioned SQL being reported as the violation).
        expect(AUDIT_CLEANUP_HELPER).toMatch(/^tests\/helpers\/[\w-]+\.ts$/);
        expect(dbReachingSources('tests').some((f) => f.rel === AUDIT_CLEANUP_HELPER)).toBe(true);

        // …and the exemption is load-bearing rather than decorative: the
        // file it resolves to really does contain the forbidden idioms, so
        // removing it from the skip would turn this scan red.
        const code = codeOf(
            fs.readFileSync(path.resolve(REPO_ROOT, AUDIT_CLEANUP_HELPER), 'utf-8'),
        );
        expect(RAW_DELETE.test(code)).toBe(true);

        // BOUND, not a whole-file `toContain`. The claim is not "the bypass
        // appears somewhere in this file" — it is that the bypass lives in
        // THAT function, which is what makes the module a single seam. A
        // whole-file needle would also be a Class-D ambiguous read against a
        // DRIFT_ALLOWANCE-0 ratchet, and narrowing is the fix the ratchet
        // asks for rather than a number to move.
        expect(functionBodyOf(code, 'withAuditTriggersDisabled')).toContain(
            `SET LOCAL session_replication_role = 'replica'`,
        );

        // The helper's UPDATE path is spelled `UPDATE "${table}" SET …`, so
        // RAW_UPDATE — which wants a LITERAL table name — does not see it and
        // the interpolated-table scan does. That asymmetry is the whole point
        // of having the third scan: if the exemption covered only what
        // RAW_UPDATE can read, the helper's own tamper statement would be an
        // unreported violation and every copy of it elsewhere would be too.
        expect(
            RAW_DML_ON_INTERPOLATED_TABLE.test(code) && AUDIT_TABLE_AS_STRING.test(code),
        ).toBe(true);
    });

    it('no raw SQL UPDATE on an audit table outside the audited helper', () => {
        expect(
            scan(
                ['src', 'tests'],
                RAW_UPDATE,
                'raw SQL UPDATE on an audit table — route it through tests/helpers/audit-cleanup.ts '
                    + '(tamperAuditRow / tamperOrgAuditRow), the only sanctioned bypass',
                AUDIT_CLEANUP_HELPER,
            ),
        ).toEqual([]);
    });

    it('no raw SQL DELETE on an audit table outside the audited helper', () => {
        expect(
            scan(
                ['src', 'tests'],
                RAW_DELETE,
                'raw SQL DELETE on an audit table — route it through tests/helpers/audit-cleanup.ts '
                    + '(deleteAuditRowsForTenants), the only sanctioned bypass',
                AUDIT_CLEANUP_HELPER,
            ),
        ).toEqual([]);
    });

    it('no raw SQL TRUNCATE on an audit table outside the audited helper', () => {
        // Reported separately from the DELETE scan because the remedy is
        // different: a TRUNCATE is not a delete somebody forgot to route
        // through the helper — the helper has no TRUNCATE to route it to,
        // and there is no bypass beside it to explain what the author meant.
        expect(
            scan(
                ['src', 'tests'],
                RAW_TRUNCATE,
                'raw SQL TRUNCATE on an audit table — the helper has no TRUNCATE to route to; '
                    + 'delete by tenant with deleteAuditRowsForTenants from tests/helpers/audit-cleanup.ts',
                AUDIT_CLEANUP_HELPER,
            ),
        ).toEqual([]);
    });

    it('no raw SQL reaches an audit table through an interpolated table name', () => {
        // The raw-SQL twin of DYNAMIC_MODEL_INDEX_WRITE, and it caught a real
        // site: `tests/e2e/global-teardown.ts` looped a hand-maintained
        // `TENANT_CHILD_TABLES` list — 'AuditLog' among them — through
        // `DELETE FROM "${table}" WHERE "tenantId" = $1`. RAW_DELETE sees
        // NOTHING in that: the table name is a string in an array and the
        // statement interpolates it. Two more test files had the same shape.
        const violations: string[] = [];
        for (const subtree of ['src', 'tests']) {
            for (const { rel, code } of dbReachingSources(subtree)) {
                if (rel === AUDIT_CLEANUP_HELPER) continue;
                if (RAW_DML_ON_INTERPOLATED_TABLE.test(code) && AUDIT_TABLE_AS_STRING.test(code)) {
                    violations.push(
                        `${rel}: names "AuditLog" beside a raw DELETE/UPDATE on an interpolated table`,
                    );
                }
            }
        }
        expect(violations).toEqual([]);
    });

    test('Prisma audit middleware excludes AuditLog from WRITE_ACTIONS', () => {
        const prismaFile = path.resolve(SRC_DIR, 'lib', 'prisma.ts');
        // Masked, like every other source read in this file: the assertion
        // below is about the EXCLUDED_MODELS set, and a comment naming
        // 'AuditLog' beside it would otherwise satisfy it (#2246 Class A).
        const content = codeOf(fs.readFileSync(prismaFile, 'utf-8'));

        // The EXCLUDED_MODELS set must include 'AuditLog'
        expect(content).toMatch(/EXCLUDED_MODELS.*=.*new\s+Set\(\[[\s\S]*?'AuditLog'/);
    });

    test('migration file for immutability trigger exists', () => {
        const migrationDir = path.join(PRISMA_DIR, 'migrations');
        const dirs = fs.readdirSync(migrationDir);
        // FIRST, not latest, and deliberately: this asserts the ORIGINAL
        // migration still says what it said. It is a historical record, and the
        // `REVOKE UPDATE` below is the half that is still live — privileges were
        // never granted back. The LIVE trigger definition is a different file;
        // see the test after this one.
        const immutableMigration = dirs.sort().find(d => d.includes('audit_log_immutable_trigger'));

        expect(immutableMigration).toBeDefined();

        // Verify it contains the trigger function and trigger creation.
        //
        // MASKED AT THE READ, and every assertion below is why (#2287). Read
        // raw, all five were satisfiable by this file's own `--` header, and
        // two of them were MEASURED green against the real thing deleted:
        //
        //   · `BEFORE UPDATE OR DELETE` — narrow the CREATE TRIGGER to
        //     `BEFORE DELETE`, so audit rows become updatable, and the header
        //     line `--   BEFORE UPDATE OR DELETE trigger → raises an
        //     exception` keeps this green. 14/14 at the base commit.
        //   · `REVOKE UPDATE` — replace the statement with a `--` copy of
        //     itself. 14/14. That is the PRIVILEGE gate on `AuditLog`, the
        //     half that was deliberately NOT loosened when the trigger was
        //     narrowed for DSAR pseudonymization; `app_user` still cannot
        //     update an audit row at all, which is why erasure has to run via
        //     `runInGlobalContext`.
        const sqlFile = path.join(migrationDir, immutableMigration!, 'migration.sql');
        const sql = sqlCodeOf(fs.readFileSync(sqlFile, 'utf-8'));

        expect(sql).toContain('audit_log_immutable_guard');
        expect(sql).toContain('BEFORE UPDATE OR DELETE');
        expect(sql).toContain('IMMUTABLE_AUDIT_LOG');
        expect(sql).toContain('REVOKE UPDATE');
        expect(sql).toContain('REVOKE');
    });

    test('the LIVE trigger definition permits only DSAR pseudonymization', () => {
        // `CREATE OR REPLACE FUNCTION` means the newest migration defining
        // `audit_log_immutable_guard` is the one that is actually running. The
        // test above reads the FIRST such migration, which after #2287 is a
        // historical file describing a contract the database no longer has —
        // reading it alone would certify "all UPDATEs blocked", which is no
        // longer true. Resolve the LATEST and assert what is really enforced.
        const migrationDir = path.join(PRISMA_DIR, 'migrations');
        const defining = fs
            .readdirSync(migrationDir)
            .sort()
            .filter((d) => {
                const f = path.join(migrationDir, d, 'migration.sql');
                // Masked: this selects WHICH migration is the live definition,
                // so a later migration merely MENTIONING the function in a
                // `--` note would be resolved as the one that is running.
                return (
                    fs.existsSync(f) &&
                    sqlCodeOf(fs.readFileSync(f, 'utf-8')).includes('FUNCTION audit_log_immutable_guard')
                );
            });

        // Non-vacuous: at least the original and the narrowing exist, and the
        // list is the population this claim reasons over.
        expect(defining.length).toBeGreaterThanOrEqual(2);

        const raw = fs.readFileSync(path.join(migrationDir, defining[defining.length - 1], 'migration.sql'), 'utf-8');
        // MASK `--` AND `/* … */` BEFORE ASSERTING. Measured the hard way,
        // twice, in both directions:
        //
        //   · FALSIFIED by prose — the migration's own header explains why
        //     granting UPDATE back to app_user would be wrong, and that
        //     sentence matched the `not.toMatch` at the bottom of this test.
        //   · SATISFIED by prose (#2287) — delete the `to_jsonb(NEW) -
        //     'userId' = to_jsonb(OLD) - 'userId'` clause, the one thing
        //     stopping a permitted "pseudonymization" from also rewriting
        //     `entryHash` / `previousHash`, and park it in a TRAILING `--`
        //     comment. 14/14 GREEN with the hash chain unprotected.
        //
        // That second one is why this is `sqlCodeOf` and no longer a local
        // `raw.replace(/^[^\S\n]*--.*$/gm, '')`: that strip only removed a
        // comment occupying a WHOLE LINE, so a comment after code on a line
        // survived it intact. Masking is now at the READ, shared, and lexes
        // the language the file is actually written in.
        const live = sqlCodeOf(raw);

        // The permitted shape, spelled out. `to_jsonb(NEW) - 'userId' =
        // to_jsonb(OLD) - 'userId'` is the part that makes "every other column
        // unchanged" generic over the schema: an enumerated column list would
        // silently permit a NEW column to change inside a pseudonymization.
        expect(live).toContain(`to_jsonb(NEW) - 'userId' = to_jsonb(OLD) - 'userId'`);
        expect(live).toContain(`OLD."userId" IS NOT NULL`);
        expect(live).toContain(`NEW."userId" IS NULL`);
        // Gated on the operation, so a DELETE (where NEW is NULL) cannot fall
        // through the NULL test into the permitted branch.
        expect(live).toContain(`TG_OP = 'UPDATE'`);
        // Still attached to both operations, and still raising by default.
        expect(live).toContain('BEFORE UPDATE OR DELETE');
        expect(live).toContain('IMMUTABLE_AUDIT_LOG');

        // Privileges were NOT granted back. app_user remains unable to UPDATE an
        // audit row at all, permitted shape or not, so the erasure must run in a
        // context that does not drop to that role. A `GRANT UPDATE ... TO
        // app_user` here would widen this to every tenant request in the product.
        expect(live).not.toMatch(/GRANT[^;]*UPDATE[^;]*app_user/i);
    });
});
