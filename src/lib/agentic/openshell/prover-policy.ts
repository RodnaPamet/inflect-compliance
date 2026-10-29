/**
 * Translate a collector sandbox policy into the shape `openshell-prover` reads.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A TRANSLATION EXISTS AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 5.3's upgrade checklist carried "policy prover re-run" as a pending tick for
 * two releases. It was never pending — it was impossible. The gateway's policy
 * schema is version 2; `openshell-prover` accepts version 1 ONLY, and rejects
 * version 2 outright:
 *
 *     invalid policy: unsupported policy version 2; expected version 1
 *
 * Measured on 0.1.6 and on 0.1.5, which answer identically, so the two
 * components have never agreed. They are not two revisions of one format: the
 * one field name they share disagrees on type, `network_policies` being a
 * MAPPING in the prover and a SEQUENCE in the gateway and in
 * `collectorSandboxPolicy`.
 *
 * So this module is the missing piece: a total, explicit translation from what
 * we deploy to what can be proven about it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SCHEMA WAS RECOVERED, NOT GUESSED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Field names come from the prover's own CLI fixtures at the pinned tag
 * (`crates/openshell-prover-cli/tests/fixtures/*.yaml`, Apache-2.0), confirmed
 * against the binary by probing: it names unknown fields and type mismatches
 * precisely, which makes it an exact oracle. Four guesses at
 * `filesystem_policy`'s children were wrong before the fixtures settled it as
 * `read_only` / `read_write`, so the fixtures are the authority here and the
 * guesses are recorded as a warning against inventing a schema.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT CANNOT BE TRANSLATED, WHICH IS THE POINT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `enforcement` HAS NO VERSION 1 FIELD. Nothing in the prover's schema
 * expresses audit mode versus enforce mode, so:
 *
 *     A PROVER PASS SAYS NOTHING ABOUT WHETHER THE POLICY ENFORCES.
 *
 * That is 0.1b — "the most consequential fact in the roadmap" (#3927) — sitting
 * entirely outside what can be proven. A containment proof bounds the SHAPE of
 * the policy, never whether the gateway will act on it. The translation
 * therefore reports what it had to drop, every caller prints it, and a test
 * pins the dropped set so that a new field on our policy cannot join it in
 * silence. A translator that quietly discards a field makes the proof vacuous
 * in exactly the direction nobody checks.
 *
 * @module lib/agentic/openshell/prover-policy
 */

import type { CollectorSandboxPolicy, PolicyEndpoint } from './collector-policy';

/** The authored-policy shape `openshell-prover check` accepts. Version 1 only. */
export interface ProverPolicyV1 {
    readonly version: 1;
    readonly filesystem_policy: {
        readonly read_only: readonly string[];
        readonly read_write: readonly string[];
    };
    readonly process: {
        readonly run_as_user: string;
        /*
            DELIBERATELY ABSENT, and absent on both sides of every comparison.

            Our policy sets no group. The prover's comparison is decidable only
            when candidate and boundary AGREE on the field's presence: with a
            group on one side and not the other it answers `unsupported`, which
            is neither a pass nor a failure. Inventing a group to fill the hole
            would prove something about a policy we do not deploy.
        */
    };
    readonly landlock: { readonly compatibility: 'best_effort' | 'hard_requirement' };
    readonly network_policies: Readonly<
        Record<string, { readonly endpoints: ReadonlyArray<{ readonly host: string; readonly port: number }> }>
    >;
}

/**
 * The port every collector endpoint is reached on.
 *
 * Our `PolicyEndpoint` carries no port and the prover's requires one. Every
 * endpoint in `PROVIDER_ENDPOINTS` is an HTTPS cloud API, so 443 is the only
 * defensible value — but it is a fact ADDED by this translation rather than
 * carried from the policy, which is why it is a named constant with this note
 * instead of an inline literal.
 */
export const PROVER_ENDPOINT_PORT = 443;

/**
 * Fields of ours with no version 1 representation, most consequential first.
 *
 * Pinned by a test. `enforcement` is the one that matters: see the module
 * docblock. `reason` is prose for a human reviewer and loses nothing.
 */
export const UNREPRESENTABLE_FIELDS = ['enforcement', 'reason'] as const;

export interface TranslatedProverPolicy {
    readonly policy: ProverPolicyV1;
    /** What the prover cannot see, for the caller to print beside any verdict. */
    readonly unrepresentable: readonly string[];
}

/*
    EXHAUSTIVENESS, ENFORCED BY THE COMPILER.

    The failure this prevents is silent: add a field to `CollectorSandboxPolicy`
    — a seccomp profile, a capability set, an egress proxy — and a translator
    that ignores it keeps returning a policy the prover happily proves, about a
    sandbox that is no longer the one we deploy. The proof would still say
    `within_boundary` and would now be about the wrong thing.

    So every key of both types is listed, and the assertions below fail to
    COMPILE if either type gains or loses one. Whoever adds the field then has
    to decide: translate it, or add it to `UNREPRESENTABLE_FIELDS` and say why.
*/
type PolicyField = keyof CollectorSandboxPolicy;
type EndpointField = keyof PolicyEndpoint;
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const HANDLED_POLICY_FIELDS = ['provider', 'networkPolicies', 'landlock', 'filesystem', 'runAs'] as const;
const HANDLED_ENDPOINT_FIELDS = ['host', 'enforcement', 'reason'] as const;

const _policyFieldsExhaustive: MutuallyAssignable<
    PolicyField,
    (typeof HANDLED_POLICY_FIELDS)[number]
> = true;
const _endpointFieldsExhaustive: MutuallyAssignable<
    EndpointField,
    (typeof HANDLED_ENDPOINT_FIELDS)[number]
> = true;
void _policyFieldsExhaustive;
void _endpointFieldsExhaustive;

/** Every policy field this translation reads, for the test that counts them. */
export const TRANSLATED_POLICY_FIELDS = HANDLED_POLICY_FIELDS;
export const TRANSLATED_ENDPOINT_FIELDS = HANDLED_ENDPOINT_FIELDS;

/**
 * Translate one collector policy. Pure; the caller writes the file and runs the
 * prover.
 *
 * `rootReadOnly` becomes `read_only: ['/']` and the scratch directory the only
 * `read_write` entry, which is what the policy means. Note that the prover does
 * NOT reason about path prefixes — `/usr/bin` against a `/usr` boundary answers
 * `unsupported`, not `within_boundary` — so a boundary must repeat these paths
 * exactly rather than state a broader ancestor.
 */
export function toProverPolicyV1(policy: CollectorSandboxPolicy): TranslatedProverPolicy {
    const { provider, networkPolicies, landlock, filesystem, runAs } = policy;

    return {
        policy: {
            version: 1,
            filesystem_policy: {
                read_only: filesystem.rootReadOnly ? ['/'] : [],
                read_write: [filesystem.scratchDir],
            },
            // `allowRoot: false` is expressed by WHICH user is named, because
            // the prover has no boolean for it. A boundary naming the same
            // non-root user refuses `root` and `0` alike, measured.
            process: { run_as_user: runAs.user },
            landlock: { compatibility: landlock.compatibility },
            // Keyed by provider for a human reading the file. The key is NOT
            // load-bearing: the prover compares endpoint SETS and ignores the
            // name, measured by renaming the key and getting the same verdict.
            network_policies: {
                [provider]: {
                    endpoints: networkPolicies.map((e) => ({
                        host: e.host,
                        port: PROVER_ENDPOINT_PORT,
                    })),
                },
            },
        },
        unrepresentable: [...UNREPRESENTABLE_FIELDS],
    };
}
