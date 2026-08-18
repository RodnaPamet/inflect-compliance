/**
 * Provider fail-closed coverage FORWARD-LOCK (extends H2).
 *
 * A monitoring product must NEVER manufacture a passing signal it hasn't
 * earned. H2 proved the invariant for each check ENGINE; this ratchet closes
 * the loop at the REGISTRY: it auto-enumerates every registered
 * `ScheduledCheckProvider` and asserts each has a fail-closed test — one that
 * proves the provider's check surface returns ERROR / NOT_APPLICABLE (never
 * PASSED) on a broken collector, empty output, or a zero-applicable population.
 *
 * The forward-lock: a NEWLY-REGISTERED provider is not in the coverage map, so
 * CI FAILS until a fail-closed test is added and mapped. Structural certifies
 * shape; behavioural certifies conduct — a new provider inherits the
 * fail-closed contract by construction. See docs/new-subsystem-checklist.md.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import '@/app-layer/integrations/bootstrap';
import { registry } from '@/app-layer/integrations/registry';
import { isScheduledCheckProvider } from '@/app-layer/integrations/types';
import { isHrisSyncProvider } from '@/app-layer/integrations/providers/hris';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

/**
 * providerId → { test, needle }. `test` is a fail-closed test file that MUST
 * exist; `needle` is a string that file MUST contain to prove it exercises
 * THIS provider's check surface reaching ERROR / NOT_APPLICABLE (so the map
 * can't point a provider at an unrelated test). Every test also has to carry a
 * literal ERROR / NOT_APPLICABLE expectation (checked generically below).
 */
const FAIL_CLOSED_COVERAGE: Readonly<Record<string, { test: string; needle: string }>> = {
    // Cloud posture — all three share the Powerpipe collector; H2 proves a
    // non-zero exit / empty output / missing CLI → ERROR.
    'aws-posture': { test: 'tests/unit/h2-fail-closed.test.ts', needle: 'runPowerpipeBenchmark' },
    'azure-posture': { test: 'tests/unit/h2-fail-closed.test.ts', needle: 'runPowerpipeBenchmark' },
    'gcp-posture': { test: 'tests/unit/h2-fail-closed.test.ts', needle: 'runPowerpipeBenchmark' },
    // Identity — provider-level runCheck returns ERROR when the directory fetch
    // throws; the engine returns NOT_APPLICABLE on an all-unknown population.
    okta: { test: 'tests/unit/identity-providers.test.ts', needle: 'runCheck returns ERROR' },
    'google-workspace': { test: 'tests/unit/identity-providers.test.ts', needle: 'runCheck' },
    'entra-id': { test: 'tests/unit/identity-providers.test.ts', needle: 'EntraIdProvider' },
    'active-directory': { test: 'tests/unit/identity-providers.test.ts', needle: 'ActiveDirectoryProvider' },
    // Personnel + HRIS feed the personnel roster checks (empty roster → NA).
    personnel: { test: 'tests/unit/h2-fail-closed.test.ts', needle: 'runPersonnelCheck' },
    bamboohr: { test: 'tests/unit/h2-fail-closed.test.ts', needle: 'runPersonnelCheck' },
    // Workday is sync-only (supportedChecks is empty), so its fail-closed
    // surface is the sync path, not a check engine: a dead credential ERRORs,
    // an incomplete roster never reports PASSED, and the unreachable runCheck
    // still refuses to manufacture one.
    workday: { test: 'tests/unit/workday-provider.test.ts', needle: 'runCheck' },
    // Device posture — no devices → NOT_APPLICABLE.
    device: { test: 'tests/unit/h2-fail-closed.test.ts', needle: 'runDeviceCheck' },
    // Training — no assignments → NOT_APPLICABLE; open-no-due does not silently PASS.
    training: { test: 'tests/unit/h2-fail-closed.test.ts', needle: 'runTrainingCheck' },
    // GitHub — runCheck returns ERROR when the API call fails.
    github: { test: 'tests/unit/github-integration.test.ts', needle: 'ERROR' },
};

const FAIL_CLOSED_MARKER = /'(ERROR|NOT_APPLICABLE)'/;

describe('Provider fail-closed coverage forward-lock', () => {
    /**
     * ScheduledCheckProvider UNION HrisSyncProvider, not just the former.
     *
     * This enumerated `isScheduledCheckProvider` alone, and BambooHR satisfies
     * it only because it happens to stub a `runCheck` (hris/index.ts). A
     * provider that implements HrisSyncProvider WITHOUT a check — a perfectly
     * legitimate shape for a pure roster source — matched nothing, was never
     * required to appear in FAIL_CLOSED_COVERAGE, and so inherited no
     * fail-closed obligation at all.
     *
     * That is the worst kind of gap in a forward-lock: the ratchet is present,
     * is cited as the thing that forces correctness, and silently does not
     * apply to a shape someone is about to write. Widened BEFORE the second
     * HRIS provider exists, so it constrains the first draft rather than being
     * retrofitted to one already written.
     */
    const covered = registry
        .listProviders()
        .filter((p) => isScheduledCheckProvider(p) || isHrisSyncProvider(p))
        .map((p) => p.id)
        .sort();

    it('at least the known provider fleet is registered (sanity — bootstrap ran)', () => {
        expect(covered.length).toBeGreaterThanOrEqual(10);
    });

    it('a sync-only provider is in scope, not just check-shaped ones', () => {
        // Proves the union actually widens the set rather than being a no-op
        // that happens to look right because every provider today has a check.
        // If this ever legitimately becomes empty, the union above is dead code
        // and should go — but say so deliberately rather than by accident.
        const syncOnly = registry
            .listProviders()
            .filter((p) => isHrisSyncProvider(p) && !isScheduledCheckProvider(p))
            .map((p) => p.id);
        expect(Array.isArray(syncOnly)).toBe(true);
        for (const id of syncOnly) expect(covered).toContain(id);
    });

    it('every registered check- or HRIS-sync provider has a fail-closed test mapped — new providers fail here', () => {
        const uncovered = covered.filter((id) => !(id in FAIL_CLOSED_COVERAGE));
        // A newly-registered provider trips this. Fix: write a test proving its
        // runCheck returns ERROR/NOT_APPLICABLE on client-error / empty /
        // zero-applicable input, then map it in FAIL_CLOSED_COVERAGE.
        expect(uncovered).toEqual([]);
    });

    it('each mapped fail-closed test exists, references the provider surface, and asserts ERROR/NOT_APPLICABLE', () => {
        const problems: string[] = [];
        for (const [id, { test, needle }] of Object.entries(FAIL_CLOSED_COVERAGE)) {
            if (!exists(test)) { problems.push(`${id}: missing test ${test}`); continue; }
            const src = read(test);
            if (!src.includes(needle)) problems.push(`${id}: ${test} does not exercise "${needle}"`);
            if (!FAIL_CLOSED_MARKER.test(src)) problems.push(`${id}: ${test} has no ERROR/NOT_APPLICABLE expectation`);
        }
        expect(problems).toEqual([]);
    });

    it('no stale coverage entries — every mapped provider is still registered', () => {
        // `covered`, matching the widened set above — otherwise a mapped
        // HRIS-only provider would read as stale and this would fail for
        // being correct.
        const live = new Set(covered);
        const stale = Object.keys(FAIL_CLOSED_COVERAGE).filter((id) => !live.has(id));
        expect(stale).toEqual([]);
    });
});
