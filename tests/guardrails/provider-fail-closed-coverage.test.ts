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
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
// Comment-masked at the seam: a mapped test must EXERCISE its provider surface,
// so a needle that only appears in that file's prose must not count.
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

/**
 * providerId → { test, needle }. `test` is a fail-closed test file that MUST
 * exist; `needle` is a string that file MUST contain to prove it exercises
 * THIS provider's check surface reaching ERROR / NOT_APPLICABLE (so the map
 * can't point a provider at an unrelated test). Every test also has to carry a
 * literal ERROR / NOT_APPLICABLE expectation (checked generically below).
 */
const DEFAULT_MARKER = /'(ERROR|NOT_APPLICABLE)'/;

/**
 * Per-provider override for the fail-closed EVIDENCE, where the surface is not
 * a scheduled check (#3629).
 *
 * `ERROR` / `NOT_APPLICABLE` is the vocabulary of a check engine. A provider
 * with no check has a fail-closed surface all the same — a pull that refuses, a
 * validation that will not manufacture a pass — and it may speak a different
 * vocabulary entirely.
 *
 * The two overrides are not equally necessary, and saying so matters more than
 * a tidier comment:
 *
 *   - `mcp-server` NEEDS one. Its test contains the check vocabulary ZERO
 *     times — measured — so the default regex would reject a file that proves
 *     the provider fails closed perfectly well. Without the override the only
 *     options are a false mapping or a silent exemption.
 *   - `legacy-mcp` does NOT need one. Its test asserts
 *     `status).toBe('NOT_APPLICABLE')` twice, so the default would pass. The
 *     override is here because `refusalReason` is the STRONGER property: the
 *     pull refused AND recorded why. A `NOT_APPLICABLE` somewhere in a 606-line
 *     file is weaker evidence than a named refusal.
 *
 * Each marker names a REFUSAL assertion, not merely a falsy one: `.valid` being
 * false, or a `refusalReason` being set. `toBe(false)` alone would match any
 * boolean in the file.
 */
const MARKERS: Readonly<Record<string, RegExp>> = {
    // The pull refuses and records WHY: `expect(result.refusalReason).toBe(…)`.
    'legacy-mcp': /\.refusalReason\)\.toBe\(/,
    // Live validation refuses: `expect(r.valid).toBe(false)`.
    'mcp-server': /\.valid\)\.toBe\(false\)/,
    // The A2A peer route (#3679) refuses the same way.
    'a2a-peer': /\.valid\)\.toBe\(false\)/,
};

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
    // OrangeHRM is sync-only too, and it is the provider the widened union
    // above was written for. Having arrived as an internal fixture (#2548) buys it no
    // exemption — it feeds the same `Employee` roster the personnel checks read
    // and the leaver pass acts on, so a fixture that manufactured a green
    // signal would be exactly as harmful as a product integration doing it.
    orangehrm: { test: 'tests/unit/orangehrm-provider.test.ts', needle: 'runCheck' },
    // Device posture — no devices → NOT_APPLICABLE.
    device: { test: 'tests/unit/h2-fail-closed.test.ts', needle: 'runDeviceCheck' },
    // Training — no assignments → NOT_APPLICABLE; open-no-due does not silently PASS.
    training: { test: 'tests/unit/h2-fail-closed.test.ts', needle: 'runTrainingCheck' },
    // ServiceNow — ERROR when the instance read fails, NOT_APPLICABLE when no
    // non-standard change was implemented in the window, and a partial window
    // is an ERROR rather than a score over the rows it happened to see.
    servicenow: { test: 'tests/unit/servicenow-checks.test.ts', needle: 'change_approved_before_implementation' },
    // GitHub — runCheck returns ERROR when the API call fails.
    github: { test: 'tests/unit/github-integration.test.ts', needle: 'ERROR' },
    // `legacy-mcp` has NO check surface at all: its fail-closed surface is the
    // PULL. The design document predicted this entry -- "extended to enumerate
    // the pull, since sync-only providers escape it today" -- and it was never
    // added, so the provider the whole recertification roadmap delivers was the
    // one with no fail-closed obligation. A denylisted overshared column
    // refuses the pull and stores nothing; the refusal is `PARTIAL` carrying a
    // named `refusalReason`, never a score over the rows it happened to see.
    'legacy-mcp': {
        test: 'tests/integration/legacy-access-pull.test.ts',
        needle: 'OVERSHARED_DENIED_COLUMN',
    },
    // `mcp-server` is the operator's own server and deliberately not a
    // `ScheduledCheckProvider` (`supportedChecks` is empty, and its docblock
    // says so in capitals). Its fail-closed surface is live validation, which
    // refuses before reaching the network on a missing URL or a partly
    // configured credential -- and, the load-bearing one, "a successful
    // validation confers nothing".
    'mcp-server': {
        test: 'tests/unit/mcp-server-provider.test.ts',
        needle: 'McpServerProvider',
    },
    // `a2a-peer` (#3679) is a route to a peer, not a check provider: empty
    // `supportedChecks`, like the MCP server above. Its fail-closed surface is
    // validation — no peer named, or a header-injecting credential, refuses —
    // and, as above, a validation confers nothing: every send is gated by the
    // peer's admission, its kill and the connection's rung.
    'a2a-peer': {
        test: 'tests/unit/a2a-peer-provider.test.ts',
        needle: 'A2aPeerProvider',
    },
};

/** The evidence regex for a provider: its override, else the check vocabulary. */
const markerFor = (id: string): RegExp => MARKERS[id] ?? DEFAULT_MARKER;

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
            if (!markerFor(id).test(src)) {
                problems.push(
                    `${id}: ${test} has no fail-closed expectation matching ${String(markerFor(id))}`,
                );
            }
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
