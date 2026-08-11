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

const ROOT = path.resolve(__dirname, '../..');

/**
 * Live count at the time of writing: 169 files import the helper, 166 of them
 * gating a `describe`. The floor is deliberately slack — see the header.
 */
const DB_GATED_SUITE_FLOOR = 150;

/** Suites whose absence would specifically mean "isolation is unproven". */
const LOAD_BEARING = [
    'tests/integration/rls-isolation.test.ts',
    'tests/integration/tenant-isolation-usecases.test.ts',
    'tests/integration/task-isolation.test.ts',
    'tests/integration/epic-b-encryption.test.ts',
    'tests/integration/audit-immutability.test.ts',
    'tests/integration/multi-tenant-jwt.test.ts',
    'tests/integration/last-owner-guard.test.ts',
    'tests/guardrails/rls-coverage.test.ts',
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

    it('runs against a live database unless skipping was explicitly allowed', () => {
        // Importing the helper is itself the assertion: it throws when the
        // probe failed and ALLOW_DB_SKIP is unset. Requiring it here turns
        // that into ONE named failure rather than 166 module-load errors, so
        // the run says what is wrong in its first line.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { DB_AVAILABLE } = require('../integration/db-helper') as {
            DB_AVAILABLE: boolean;
        };

        if (process.env.ALLOW_DB_SKIP === '1') {
            // Local escape hatch in use — the population assertions above still
            // hold, but execution cannot be claimed.
            return;
        }
        expect(DB_AVAILABLE).toBe(true);
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
