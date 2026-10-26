/**
 * The Powerpipe collectors' sandbox policy — 4.1 (#3961).
 *
 * `agent-sandbox-policy-review` (2.1) states the bar these assertions enforce:
 * `H3.egress_enforced` is met "only when EVERY endpoint in the sandbox's
 * network policy is set to enforce", and "one endpoint in audit mode is enough
 * to fail it. A policy is not partly enforced; the agent reaches whatever the
 * weakest endpoint allows."
 *
 * So the enforcement assertion is PER ENDPOINT, not over the policy. A
 * whole-policy check ("the policy enforces") is satisfiable by a policy with
 * one audit endpoint in it, which is exactly the shape the skill refuses.
 */
import {
    COLLECTOR_PROVIDERS,
    COLLECTOR_RUN_AS_USER,
    COLLECTOR_SCRATCH_DIR,
    collectorSandboxPolicy,
    providerOfBenchmark,
} from '@/lib/agentic/openshell/collector-policy';

const BENCHMARKS: ReadonlyArray<[string, string]> = [
    ['aws_compliance.benchmark.soc_2', 'aws'],
    ['azure_compliance.benchmark.soc_2', 'azure'],
    ['gcp_compliance.benchmark.cis_v300', 'gcp'],
];

describe('1. the provider is derived, and an unknown one is REFUSED', () => {
    it.each(BENCHMARKS)('%s belongs to %s', (benchmarkId, provider) => {
        expect(providerOfBenchmark(benchmarkId)).toBe(provider);
    });

    it('refuses a benchmark whose prefix names no cloud', () => {
        // A default would hand one cloud's allowlist to another cloud's
        // benchmark: an egress policy permitting the wrong hosts and denying
        // the right ones, which presents as a broken collector and gets read
        // as a network problem.
        expect(() => providerOfBenchmark('acme_compliance.benchmark.soc_2')).toThrow(
            /cannot derive a cloud provider/,
        );
    });

    it('covers every provider the policy knows, so none is unreachable', () => {
        expect(BENCHMARKS.map(([, p]) => p).sort()).toEqual([...COLLECTOR_PROVIDERS].sort());
    });
});

describe('2. EVERY endpoint enforces — asserted one endpoint at a time', () => {
    it.each(BENCHMARKS)('%s: no endpoint is left in audit mode', (benchmarkId) => {
        const policy = collectorSandboxPolicy(benchmarkId);
        expect(policy.networkPolicies.length).toBeGreaterThan(0);
        for (const endpoint of policy.networkPolicies) {
            expect(endpoint.enforcement).toBe('NETWORK_ENFORCEMENT_MODE_ENFORCE');
        }
    });

    it('every endpoint carries the field at all — an absent field IS audit mode', () => {
        // The proto3 zero value is "log violations and allow traffic", so an
        // endpoint that simply omits `enforcement` is not undefined-but-safe;
        // it is permissive. This asserts presence separately from value.
        for (const [benchmarkId] of BENCHMARKS) {
            for (const endpoint of collectorSandboxPolicy(benchmarkId).networkPolicies) {
                expect(Object.prototype.hasOwnProperty.call(endpoint, 'enforcement')).toBe(true);
                expect(endpoint.enforcement).not.toBeUndefined();
            }
        }
    });

    it('every endpoint says WHY it is allowed', () => {
        // An allowlist entry without a reason cannot be reviewed, and the
        // review is the only thing that keeps it narrow.
        for (const [benchmarkId] of BENCHMARKS) {
            for (const endpoint of collectorSandboxPolicy(benchmarkId).networkPolicies) {
                expect(endpoint.reason.length).toBeGreaterThan(10);
            }
        }
    });
});

describe('3. confinement is a hard requirement, not best effort', () => {
    it.each(BENCHMARKS)('%s: landlock is hard_requirement', (benchmarkId) => {
        // `best_effort` — which NVIDIA's own `generate-sandbox-policy` scaffolds
        // as a "sensible default" — means a host without Landlock runs the
        // sandbox with NO filesystem isolation and reports success.
        expect(collectorSandboxPolicy(benchmarkId).landlock.compatibility).toBe('hard_requirement');
    });

    it.each(BENCHMARKS)('%s: root is read-only with one scratch directory', (benchmarkId) => {
        const fs = collectorSandboxPolicy(benchmarkId).filesystem;
        expect(fs.rootReadOnly).toBe(true);
        expect(fs.scratchDir).toBe(COLLECTOR_SCRATCH_DIR);
    });

    it.each(BENCHMARKS)('%s: runs as a non-root user', (benchmarkId) => {
        const runAs = collectorSandboxPolicy(benchmarkId).runAs;
        expect(runAs.allowRoot).toBe(false);
        expect(runAs.user).toBe(COLLECTOR_RUN_AS_USER);
        // Root would make the read-only root advisory rather than enforced.
        expect(runAs.user).not.toBe('0');
        expect(runAs.user).not.toBe('root');
    });
});
