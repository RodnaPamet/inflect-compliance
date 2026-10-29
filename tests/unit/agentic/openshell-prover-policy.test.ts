/**
 * The v2 → v1 policy translation, and the fields it cannot carry.
 *
 * The compile-time assertions in `prover-policy.ts` already fail the build if
 * `CollectorSandboxPolicy` or `PolicyEndpoint` gains a field. What they cannot
 * catch is a field LISTED as handled and then ignored — adding a name to the
 * list silences the compiler without translating anything. So the central test
 * here mutates each input field and requires the OUTPUT to move, which is a
 * property the compiler cannot express.
 *
 * @module unit/agentic/openshell-prover-policy
 */

import {
    PROVER_ENDPOINT_PORT,
    TRANSLATED_ENDPOINT_FIELDS,
    TRANSLATED_POLICY_FIELDS,
    UNREPRESENTABLE_FIELDS,
    toProverPolicyV1,
} from '@/lib/agentic/openshell/prover-policy';
import type { CollectorSandboxPolicy } from '@/lib/agentic/openshell/collector-policy';
import {
    COLLECTOR_RUN_AS_USER,
    COLLECTOR_SCRATCH_DIR,
    collectorSandboxPolicy,
} from '@/lib/agentic/openshell/collector-policy';

const base = (): CollectorSandboxPolicy => ({
    provider: 'azure',
    networkPolicies: [
        { host: 'management.azure.com', enforcement: 'NETWORK_ENFORCEMENT_MODE_ENFORCE', reason: 'r' },
    ],
    landlock: { compatibility: 'hard_requirement' },
    filesystem: { rootReadOnly: true, scratchDir: '/var/tmp/powerpipe' },
    runAs: { user: '65532', allowRoot: false },
});

describe('the prover translation carries what it can and names what it cannot', () => {
    it('emits version 1 — the gateway schema is 2 and the prover refuses it', () => {
        // The single most load-bearing line: a `2` here makes every run exit
        // with "unsupported policy version 2; expected version 1".
        expect(toProverPolicyV1(base()).policy.version).toBe(1);
    });

    it('maps rootReadOnly and the scratch dir onto read_only / read_write', () => {
        const { policy } = toProverPolicyV1(base());
        expect(policy.filesystem_policy.read_only).toEqual(['/']);
        expect(policy.filesystem_policy.read_write).toEqual(['/var/tmp/powerpipe']);
    });

    it('names the non-root user, and omits run_as_group on purpose', () => {
        const { policy } = toProverPolicyV1(base());
        expect(policy.process.run_as_user).toBe('65532');
        // Presence must MATCH the boundary or the prover answers `unsupported`,
        // which is neither a pass nor a failure. We set no group, so neither
        // side names one.
        expect(Object.keys(policy.process)).toEqual(['run_as_user']);
    });

    it('gives every endpoint the HTTPS port the policy does not carry', () => {
        const { policy } = toProverPolicyV1(base());
        expect(policy.network_policies.azure.endpoints).toEqual([
            { host: 'management.azure.com', port: PROVER_ENDPOINT_PORT },
        ]);
        expect(PROVER_ENDPOINT_PORT).toBe(443);
    });

    it('reports enforcement as unrepresentable — the point of the whole module', () => {
        // `enforcement` has NO version 1 field, so a containment proof says
        // nothing about audit versus enforce. That is 0.1b sitting outside what
        // can be proven, and it must be reported rather than implied.
        expect(toProverPolicyV1(base()).unrepresentable).toEqual(['enforcement', 'reason']);
        expect([...UNREPRESENTABLE_FIELDS]).toContain('enforcement');
    });

    it('EVERY field it claims to handle actually moves the output', () => {
        /*
            The test the compiler cannot write. A name added to
            TRANSLATED_POLICY_FIELDS silences the exhaustiveness assertion
            whether or not the field is read, so each one is perturbed here and
            the output must differ. A field that can be changed without
            changing the translation is a field being ignored.
        */
        const serialise = (p: CollectorSandboxPolicy): string =>
            JSON.stringify(toProverPolicyV1(p).policy);
        const original = serialise(base());

        const perturbed: Readonly<Record<string, CollectorSandboxPolicy>> = {
            provider: { ...base(), provider: 'gcp' },
            networkPolicies: {
                ...base(),
                networkPolicies: [
                    { host: 'other.example.com', enforcement: 'NETWORK_ENFORCEMENT_MODE_ENFORCE', reason: 'r' },
                ],
            },
            // CAST, and the reason matters. `compatibility` is typed as the
            // literal 'hard_requirement', so today the type system pins it and
            // no legal value can perturb it. The translator must still READ
            // the field rather than hardcode it — if the type ever widens, a
            // hardcoded translation would quietly prove the wrong policy. The
            // cast keeps that teeth now; the mutation that hardcodes it fails
            // this test.
            landlock: {
                ...base(),
                landlock: { compatibility: 'best_effort' },
            } as unknown as CollectorSandboxPolicy,
            filesystem: { ...base(), filesystem: { rootReadOnly: true, scratchDir: '/other' } },
            runAs: { ...base(), runAs: { user: '1000', allowRoot: false } },
        };

        // Denominator: every claimed field is perturbed, none skipped.
        expect(Object.keys(perturbed).sort()).toEqual([...TRANSLATED_POLICY_FIELDS].sort());

        const unmoved = Object.entries(perturbed)
            .filter(([, p]) => serialise(p) === original)
            .map(([field]) => field);
        expect(unmoved).toEqual([]);
    });

    it('the endpoint fields it does NOT carry are exactly the unrepresentable ones', () => {
        // host is carried; enforcement and reason are not. Stated as a set
        // equality so a new endpoint field cannot land in neither list.
        const carried = ['host'];
        expect([...TRANSLATED_ENDPOINT_FIELDS].sort()).toEqual(
            [...carried, ...UNREPRESENTABLE_FIELDS].sort(),
        );
    });

    it('translates the REAL composed policies, not just a fixture', () => {
        // A fixture that drifts from `collectorSandboxPolicy` would make every
        // test above pass about a policy nobody deploys.
        for (const id of [
            'aws_compliance.benchmark.soc_2',
            'azure_compliance.benchmark.soc_2',
            'gcp_compliance.benchmark.cis_v300',
        ]) {
            const real = collectorSandboxPolicy(id);
            const { policy } = toProverPolicyV1(real);
            expect(policy.version).toBe(1);
            expect(policy.process.run_as_user).toBe(COLLECTOR_RUN_AS_USER);
            expect(policy.filesystem_policy.read_write).toEqual([COLLECTOR_SCRATCH_DIR]);
            expect(policy.network_policies[real.provider].endpoints.length).toBe(
                real.networkPolicies.length,
            );
        }
    });
});
