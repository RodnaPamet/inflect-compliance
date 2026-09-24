/**
 * The audit gate's allowlist override is a TEST affordance, not a CI knob.
 *
 * `scripts/audit-gate.mjs` reads `AUDIT_ALLOWLIST_PATH` so its own tests can
 * point it at a fixture instead of the repo's real allowlist. That override
 * had to exist because the tests previously asserted gate behaviour against
 * whatever the repo happened to exempt, with the advisory ids copied into the
 * test as a constant — a mirror that went stale the moment the real entries
 * were removed, breaking tests about RETRY behaviour over an unrelated fact.
 *
 * The affordance has an obvious abuse: set it in a workflow and the gate
 * enforces an empty file, passing everything while still printing PASSED. This
 * guard makes that abuse a failing test rather than a quiet green build.
 *
 * Asserted against the workflow SOURCE, because that is where such a variable
 * would be written, and a scan with no population is the failure this whole
 * file exists to prevent — so the count is checked first.
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');

const files = existsSync(WORKFLOWS)
    ? readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    : [];

describe('AUDIT_ALLOWLIST_PATH stays out of CI', () => {
    it('found workflows to scan — an empty scan would pass this vacuously', () => {
        expect(files.length).toBeGreaterThan(3);
    });

    it('no workflow sets AUDIT_ALLOWLIST_PATH', () => {
        const offenders = files.filter((f) =>
            /AUDIT_ALLOWLIST_PATH/.test(readFileSync(path.join(WORKFLOWS, f), 'utf8')),
        );
        expect({
            why:
                'Setting this in CI would point the npm-audit gate at a file other than ' +
                'security/audit-allowlist.json — an empty one passes every advisory while the ' +
                'gate still prints PASSED. It exists for the gate\'s own tests only.',
            offenders,
        }).toEqual({ why: expect.any(String), offenders: [] });
    });

    it('the gate still defaults to the repo allowlist when the variable is unset', () => {
        // The positive control for the override itself: if the default were
        // broken, every assertion above would still pass while the gate read
        // nothing in production.
        const gate = readFileSync(path.join(ROOT, 'scripts', 'audit-gate.mjs'), 'utf8');
        expect(gate).toMatch(/AUDIT_ALLOWLIST_PATH\s*\|\|\s*path\.join\(\s*ROOT,\s*'security'/);
    });
});
