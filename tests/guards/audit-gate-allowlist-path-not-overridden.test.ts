/**
 * The audit gate's allowlist override is a TEST affordance, not a CI knob.
 *
 * `scripts/audit-gate.mjs` reads `AUDIT_ALLOWLIST_PATH` so its own tests can
 * point it at a fixture instead of the repo's real allowlist. That override had
 * to exist because the tests previously asserted gate behaviour against
 * whatever the repo happened to exempt, with the advisory ids copied into the
 * test as a constant — a mirror that went stale the moment the entries changed,
 * breaking tests about RETRY behaviour over an unrelated fact.
 *
 * The affordance has an obvious abuse: set it in a workflow and the gate
 * enforces whatever file that names — an empty one passes every advisory while
 * the gate still prints PASSED.
 *
 * ── WHY THIS PARSES YAML INSTEAD OF GREPPING IT ─────────────────────────────
 *
 * The first version of this guard read the workflow files as TEXT and matched
 * `/AUDIT_ALLOWLIST_PATH/`. That is wrong in the direction that matters: a
 * COMMENT saying "never set AUDIT_ALLOWLIST_PATH here" would have tripped it,
 * so the guard would have failed on a file doing exactly the right thing —
 * and, worse, it counts a mention as a setting. The repo's raw-source ratchet
 * caught it and was correct to: an assertion whose subject is unmasked source
 * is an assertion prose can satisfy.
 *
 * Parsing removes the question. `env:` is a mapping; a comment is not a key.
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';

import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');

const files = existsSync(WORKFLOWS)
    ? readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    : [];

/** Every env-map KEY anywhere in a parsed workflow, at any nesting depth. */
function envKeysOf(node: unknown, out: string[] = []): string[] {
    if (node === null || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
        for (const item of node) envKeysOf(item, out);
        return out;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'env' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
            out.push(...Object.keys(value as Record<string, unknown>));
        }
        envKeysOf(value, out);
    }
    return out;
}

describe('AUDIT_ALLOWLIST_PATH stays out of CI', () => {
    it('found workflows to scan, and they parse — an empty scan passes vacuously', () => {
        expect(files.length).toBeGreaterThan(3);
        // Parse-ability is part of the denominator: a file that threw would be
        // silently absent from every assertion below if this swallowed errors.
        const parsed = files.map((f) => yaml.load(readFileSync(path.join(WORKFLOWS, f), 'utf8')));
        expect(parsed.filter((d) => d && typeof d === 'object').length).toBe(files.length);
    });

    it('no workflow sets AUDIT_ALLOWLIST_PATH in any env map', () => {
        const offenders = files.filter((f) => {
            const doc = yaml.load(readFileSync(path.join(WORKFLOWS, f), 'utf8'));
            return envKeysOf(doc).includes('AUDIT_ALLOWLIST_PATH');
        });
        expect({
            why:
                'Setting this in CI points the npm-audit gate at a file other than ' +
                'security/audit-allowlist.json — an empty one passes every advisory while the ' +
                'gate still prints PASSED. It exists for the gate\'s own tests only.',
            offenders,
        }).toEqual({ why: expect.any(String), offenders: [] });
    });

    it('the env walker actually finds env keys — proved, not assumed', () => {
        // Detector proof. Without it, a walker that returned [] for everything
        // would make the assertion above pass on a workflow that DID set the
        // variable, which is the failure this guard exists to prevent.
        const synthetic = yaml.load(
            'jobs:\n  a:\n    env:\n      FOO: "1"\n    steps:\n      - env:\n          BAR: "2"\n',
        );
        expect(envKeysOf(synthetic).sort()).toEqual(['BAR', 'FOO']);
        // ...and a COMMENT naming the variable is not a setting.
        const commented = yaml.load('jobs:\n  a:\n    # AUDIT_ALLOWLIST_PATH must never be set\n    env:\n      OK: "1"\n');
        expect(envKeysOf(commented)).toEqual(['OK']);
    });

    it('the gate still defaults to the repo allowlist when the variable is unset', () => {
        // The positive control for the override itself: a broken default would
        // hide behind every assertion above. Read through `codeOf`, so a
        // comment describing the fallback cannot stand in for the fallback.
        const gate = codeOf(readFileSync(path.join(ROOT, 'scripts', 'audit-gate.mjs'), 'utf8'));
        expect(gate).toMatch(/AUDIT_ALLOWLIST_PATH\s*\|\|\s*path\.join\(\s*ROOT,\s*'security'/);
    });
});
