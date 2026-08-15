/**
 * Guard: the DB-backed suites actually EXECUTE.
 *
 * ── The regression class ─────────────────────────────────────────────
 *
 * `tests/integration/db-helper.ts` probes for a live Postgres and exports
 * `DB_AVAILABLE`. 166 suites consume it as
 *
 *     const describeFn = DB_AVAILABLE ? describe : describe.skip;
 *
 * so a `false` probe converts every one of them into a skip — and a run full
 * of skips is GREEN. The suites behind that flag are not incidental: they
 * include every cross-tenant isolation test, `rls-isolation`, `rls-coverage`,
 * `epic-b-encryption`, `audit-immutability`, `multi-tenant-jwt`,
 * `last-owner-guard`, and the only behavioural tests for the reviewer gate and
 * the task reconcilers.
 *
 * The failure mode is silence in both directions: the probe fails quietly, and
 * the skip reports quietly. Nothing in the run says "your isolation tests did
 * not run."
 *
 * ── What this guard adds over the fail-closed probe ──────────────────
 *
 * `db-helper` now throws unless `ALLOW_DB_SKIP=1`, which handles the probe
 * failing. This guard covers the OTHER way the population can collapse: the
 * suites themselves being deleted, renamed out of the glob, or quietly
 * un-gated one at a time. A count that trends to zero has the same effect as a
 * failing probe — no isolation coverage — and would otherwise be invisible,
 * because deleting a test never turns anything red.
 *
 * It is a COLLAPSE detector, not a growth ratchet. The floor sits below the
 * live count on purpose: adding or removing a handful of suites in normal work
 * should not force an edit here, but losing a third of them should stop the
 * build.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    assertDbAvailableOrSkipAllowed,
    unavailableDbMessage,
} from '../integration/db-availability';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Live count at the time of writing: 169 files import the helper, 166 of them
 * gating a `describe`. The floor is deliberately slack — see the header.
 */
const DB_GATED_SUITE_FLOOR = 150;

/**
 * Suites whose absence would specifically mean a guarantee is unproven.
 *
 * The floor above catches a COLLAPSE — it cannot notice one suite going
 * missing among 180. These are the individual files where that matters, so
 * deleting or un-gating one turns the build red by name.
 *
 * NOTE THE LIMIT, so nobody reads more into a green than is there: this guard
 * runs in the DB-free Ratchets job and deliberately does not import
 * `db-helper`. It can prove a suite still EXISTS and is still DB-gated. It
 * cannot prove the suite EXECUTED — that is what the fail-closed throw in
 * db-helper is for, and the two are complementary rather than interchangeable.
 */
const LOAD_BEARING = [
    'tests/integration/rls-isolation.test.ts',
    'tests/integration/tenant-isolation-usecases.test.ts',
    'tests/integration/task-isolation.test.ts',
    'tests/integration/epic-b-encryption.test.ts',
    'tests/integration/audit-immutability.test.ts',
    'tests/integration/multi-tenant-jwt.test.ts',
    'tests/integration/last-owner-guard.test.ts',
    'tests/guardrails/rls-coverage.test.ts',
    // The ONLY behavioural coverage of the process-map optimistic concurrency
    // control — an up-front expectedVersion check that avoids a destructive
    // delete-and-insert when the commit would lose the race, plus a
    // conditional updateMany catching a commit that lands between the check
    // and the version bump. The surrounding unit suites are large (1,548 lines
    // across three files) and none of them exercises a real concurrent commit,
    // so if this file goes the guarantee is untested and nothing says so.
    'tests/integration/process-map-concurrency.test.ts',
] as const;

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
    }
    return out;
}

const testFiles = walk(path.join(ROOT, 'tests'));
const dbGated = testFiles.filter((f) => /\bDB_AVAILABLE\b/.test(fs.readFileSync(f, 'utf8')));

describe('DB-backed suites execute rather than skip', () => {
    it('keeps a population of DB-gated suites (a collapse turns the build red)', () => {
        expect(dbGated.length).toBeGreaterThanOrEqual(DB_GATED_SUITE_FLOOR);
    });

    it.each(LOAD_BEARING)('%s still exists and is DB-gated', (rel) => {
        const full = path.join(ROOT, rel);
        expect(fs.existsSync(full)).toBe(true);
        expect(fs.readFileSync(full, 'utf8')).toMatch(/\bDB_AVAILABLE\b/);
    });

    /**
     * The decision itself, exercised in all three states.
     *
     * This deliberately does NOT import `db-helper`: that module probes a live
     * database at import time and throws when it is missing, and the CI
     * `Ratchets` job — which runs this file — is DB-free by design. A guard
     * that demanded a database from that job would be asserting the invariant
     * in the one place it does not apply. So the decision lives in
     * `db-availability.ts` as a pure function, and the runtime enforcement
     * stays where it belongs: inside the suites that actually need a database.
     */
    describe('the fail-closed decision', () => {
        const URL = 'postgresql://user:hunter2@localhost:5432/db';

        it('throws when the database is unavailable and skipping was not requested', () => {
            expect(() => assertDbAvailableOrSkipAllowed(false, undefined, URL)).toThrow(
                /Integration database is unavailable/,
            );
        });

        it('allows the skip only for the explicit opt-in', () => {
            expect(() => assertDbAvailableOrSkipAllowed(false, '1', URL)).not.toThrow();
            // Anything else is not an opt-in — including the truthy-looking ones.
            for (const value of ['0', 'true', 'yes', '', undefined]) {
                expect(() => assertDbAvailableOrSkipAllowed(false, value, URL)).toThrow();
            }
        });

        it('says nothing when the database is available', () => {
            expect(() => assertDbAvailableOrSkipAllowed(true, undefined, URL)).not.toThrow();
        });

        it('never puts the database password in the message', () => {
            const message = unavailableDbMessage(URL);
            expect(message).not.toContain('hunter2');
            expect(message).toContain('//user:***@');
        });

        it('tells the reader both ways out', () => {
            const message = unavailableDbMessage(URL);
            expect(message).toContain('docker-compose up -d');
            expect(message).toContain('ALLOW_DB_SKIP=1');
        });
    });

    it('never lets CI take the escape hatch', () => {
        // The flag exists for local work. If it is ever set in a workflow file,
        // the fail-closed probe is inert and every suite is free to skip again.
        const workflows = path.join(ROOT, '.github', 'workflows');
        for (const file of fs.readdirSync(workflows).filter((f) => f.endsWith('.yml'))) {
            const src = fs.readFileSync(path.join(workflows, file), 'utf8');
            expect({ file, hasFlag: /ALLOW_DB_SKIP/.test(src) }).toEqual({
                file,
                hasFlag: false,
            });
        }
    });
});
