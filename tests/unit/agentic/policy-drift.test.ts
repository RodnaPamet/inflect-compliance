/**
 * Policy drift and the fallback that looks like an outage — 5.2 (#3972).
 *
 * The issue's acceptance: "drift detection fires on a changed live policy AND
 * on a fallback-to-default, each proven by a test that produces the condition".
 * Both conditions are produced below from a real hash comparison rather than by
 * passing a pre-made verdict in.
 *
 * The load-bearing test is the one asserting the two outcomes DIFFER. Asserting
 * each label separately is satisfiable by renaming one into the other; a
 * difference is not. And collapsing them is the specific failure #3972 names —
 * a fallback filed as drift gets triaged as an outage, and the event that the
 * committed policy is not in force goes unrecorded.
 */
import {
    DRIFT_OUTCOMES_REPORTABLE,
    POLICY_SOURCES,
    classifyPolicyDrift,
    hashCommittedPolicy,
    type LivePolicyStatus,
} from '@/lib/agentic/openshell/policy-drift';
import { collectorSandboxPolicy } from '@/lib/agentic/openshell/collector-policy';

const COMMITTED = collectorSandboxPolicy('aws_compliance.benchmark.soc_2');
const COMMITTED_HASH = hashCommittedPolicy(COMMITTED);

/** A restrictive default, standing in for the artefact a deploy would record. */
const DEFAULT_HASH = hashCommittedPolicy({ deny: 'all', endpoints: [] });

const status = (over: Partial<LivePolicyStatus> = {}): LivePolicyStatus => ({
    sandboxId: 'sb-1',
    effectivePolicyHash: COMMITTED_HASH,
    policySource: 'POLICY_SOURCE_GLOBAL',
    ...over,
});

const classify = (s: LivePolicyStatus | null) =>
    classifyPolicyDrift({ committedHash: COMMITTED_HASH, status: s, restrictiveDefaultHash: DEFAULT_HASH });

describe('1. the committed policy in force reports nothing', () => {
    it('matches when the live hash is the committed hash', () => {
        expect(classify(status()).outcome).toBe('in-force');
    });

    it('and in-force is not a reportable finding', () => {
        expect(DRIFT_OUTCOMES_REPORTABLE).not.toContain('in-force');
    });
});

describe('2. a CHANGED live policy fires — the first condition #3972 names', () => {
    it('reports drift when the live policy is neither committed nor the default', () => {
        // Produced by hashing a REAL edited policy, not by asserting a label:
        // one endpoint dropped is exactly what `policy set` does silently.
        const edited = {
            ...COMMITTED,
            networkPolicies: COMMITTED.networkPolicies.slice(0, 1),
        };
        const liveHash = hashCommittedPolicy(edited);
        expect(liveHash).not.toBe(COMMITTED_HASH);

        const finding = classify(status({ effectivePolicyHash: liveHash }));
        expect(finding.outcome).toBe('drifted');
        expect(finding.reason).toContain('replaced');
    });

    it('carries both hashes, so the finding can be audited without re-reading', () => {
        const finding = classify(status({ effectivePolicyHash: 'deadbeef' }));
        expect(finding.committedHash).toBe(COMMITTED_HASH);
        expect(finding.liveHash).toBe('deadbeef');
        expect(finding.sandboxId).toBe('sb-1');
    });
});

describe('3. a FALLBACK-TO-DEFAULT fires — the second condition, and the subtler one', () => {
    it('reports the fallback when the live policy is the restrictive default', () => {
        const finding = classify(status({ effectivePolicyHash: DEFAULT_HASH }));
        expect(finding.outcome).toBe('fell-back-to-default');
    });

    it('says it will look like an outage and is not one', () => {
        // The reason text is the part an operator reads first, and #3972's whole
        // point is that the instinct here is to restore service.
        const finding = classify(status({ effectivePolicyHash: DEFAULT_HASH }));
        expect(finding.reason).toMatch(/outage/i);
        expect(finding.reason).toMatch(/not loaded|was not loaded/i);
    });

    it('is DISTINGUISHABLE from drift — asserted as a difference, not a label', () => {
        // A label can be renamed into agreement. A difference cannot, so this is
        // what actually holds the two cases apart.
        const fellBack = classify(status({ effectivePolicyHash: DEFAULT_HASH }));
        const drifted = classify(status({ effectivePolicyHash: 'something-else-entirely' }));
        expect(fellBack.outcome).not.toBe(drifted.outcome);
        expect(fellBack.reason).not.toBe(drifted.reason);
    });

    it('both are reportable, so neither is silently dropped', () => {
        expect(DRIFT_OUTCOMES_REPORTABLE).toContain('drifted');
        expect(DRIFT_OUTCOMES_REPORTABLE).toContain('fell-back-to-default');
    });
});

describe('4. a status that cannot be believed is not a pass', () => {
    it('an unreadable status is unverifiable, never in-force', () => {
        // A check that could not read the live policy has NOT found it
        // unchanged, which is the direction this has to fail in.
        const finding = classify(null);
        expect(finding.outcome).toBe('unverifiable');
        expect(finding.outcome).not.toBe('in-force');
    });

    it('an empty hash is unverifiable rather than a mismatch', () => {
        // Reporting drift here would raise a security finding out of a missing
        // field, which burns the signal the real one needs.
        expect(classify(status({ effectivePolicyHash: '' })).outcome).toBe('unverifiable');
    });

    it('POLICY_SOURCE_UNSPECIFIED is not treated as evidence of anything', () => {
        // It is the proto3 zero, so unset, dropped-by-a-proxy and
        // explicitly-zero are the same bytes. The verdict must come from the
        // hash, so an in-force policy reported with no source is still in force.
        expect(POLICY_SOURCES[0]).toBe('POLICY_SOURCE_UNSPECIFIED');
        const finding = classify(status({ policySource: 'POLICY_SOURCE_UNSPECIFIED' }));
        expect(finding.outcome).toBe('in-force');
    });
});

describe('5. the hash is over facts, not bytes', () => {
    it('key order does not change it', () => {
        // Re-serialising the same policy with keys in a different order must not
        // read as drift, or the detector cries wolf on every refactor.
        const a = hashCommittedPolicy({ x: 1, y: [1, 2], z: { p: true, q: null } });
        const b = hashCommittedPolicy({ z: { q: null, p: true }, y: [1, 2], x: 1 });
        expect(a).toBe(b);
    });

    it('but a changed VALUE does change it', () => {
        // The control for the test above: an order-insensitive hash that is also
        // value-insensitive would report every policy as in force.
        expect(hashCommittedPolicy({ x: 1 })).not.toBe(hashCommittedPolicy({ x: 2 }));
    });

    it('array order DOES change it, because endpoint order is not noise', () => {
        expect(hashCommittedPolicy([1, 2])).not.toBe(hashCommittedPolicy([2, 1]));
    });
});
