/**
 * The sandbox lifecycle decisions that CAN be recorded, and the ones that cannot.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS SPLIT IS THE WHOLE DESIGN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 5.1 (#3971) asks to bridge "sandbox created, policy changed, execution
 * refused, sandbox deleted" into the hash-chained `AuditLog`, and then adds the
 * constraint that makes it honest:
 *
 *     "Which decisions are bridgeable depends on what 0.1g measured: a decision
 *     OpenShell never records cannot be bridged, and claiming otherwise would
 *     put a gap in the compliance record rather than in the vendor's."
 *
 * 0.1g (#3932) measured that the gateway's OCSF log records **no sandbox
 * lifecycle decision at all** — created, policy changed, network denied,
 * deleted and token minted all produce zero records, and a deleted sandbox is
 * recoverable from neither the log nor the API afterwards. v0.1.6 widened the
 * auth-adjacent coverage and still records none of the five.
 *
 * So the bridge does NOT read the vendor's log. It records the decisions **our
 * own code makes**, at the moment it makes them: this repository creates the
 * sandbox, attaches the credential, refuses, and deletes. Those four facts are
 * ours to know and ours to record, and they need no cooperation from a log that
 * does not exist.
 *
 * What stays unrecordable is anything the GATEWAY decides unilaterally, and
 * `UNOBSERVABLE_DECISIONS` below is that list with its measurement attached —
 * which is the other half of the acceptance: "any decision 0.1g found
 * unobservable is recorded as such instead of silently absent."
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO AUDIT IMPORT HERE, DELIBERATELY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This module is pure data. `executor.ts` already keeps the gateway client out
 * of the main `src/` graph by taking its transport as a parameter — "no part of
 * the main `src/` graph reaches a gateway client" — and the same reasoning
 * applies in the other direction: the executor must not reach the audit writer
 * either, or a tool execution would depend on a database. The executor emits
 * these values; `openshell-audit-bridge.ts` in the app layer is what turns them
 * into rows.
 *
 * @module lib/agentic/openshell/sandbox-decisions
 */

/** Why an execution was refused before the tool ran. */
export type RefusalReason =
    /** `createSandbox` threw. Nothing was created, so nothing leaked. */
    | 'creation-failed'
    /**
     * `onSandboxReady` threw — in practice a credential provider that could not
     * be attached. The sandbox existed and was deleted; the tool never ran.
     * 4.1's note: "an unattached collector fails in a way that looks exactly
     * like a revoked key", so it must be distinguishable in the record.
     */
    | 'provider-attach-failed';

/**
 * One decision, as the executor saw it.
 *
 * A discriminated union so the bridge's mapping can be exhaustive: adding a
 * member fails the build in `openshell-audit-bridge.ts` until somebody decides
 * what row it writes.
 */
export type SandboxDecision =
    | { readonly kind: 'sandbox-created'; readonly sandboxId: string }
    | {
          readonly kind: 'execution-refused';
          readonly reason: RefusalReason;
          /** Absent when creation itself failed — there was no sandbox. */
          readonly sandboxId?: string;
      }
    | {
          readonly kind: 'sandbox-deleted';
          readonly sandboxId: string;
          /**
           * The gateway's own four-valued outcome, carried verbatim. ACCEPTED
           * means admitted, not performed, and UNSPECIFIED is the proto3 zero
           * with no assurance at all — so the record must not flatten them into
           * "deleted".
           */
          readonly outcome: string;
          /** True when the delete did not settle and the sandbox may leak. */
          readonly settled: boolean;
      };

export const SANDBOX_DECISION_KINDS = [
    'sandbox-created',
    'execution-refused',
    'sandbox-deleted',
] as const;

/**
 * Decisions this deployment CANNOT record, each with what established it.
 *
 * Not a TODO list. These are gaps in the vendor's instrumentation, and the
 * acceptance for 5.1 is that they appear here rather than as an absence
 * somebody later reads as "it never happened". A reviewer asking "does the
 * audit trail cover sandbox network denials?" gets the answer, with the
 * measurement, instead of silence.
 */
export const UNOBSERVABLE_DECISIONS: ReadonlyArray<{
    readonly decision: string;
    readonly why: string;
    readonly establishedBy: string;
}> = [
    {
        decision: 'network-denied-inside-the-sandbox',
        why:
            'The gateway records no denial event the host can read. 0.1g exercised a blocked '
            + 'egress and the OCSF log wrote zero records; the third-party v0.1.2 evaluation '
            + 'found the same for a blocked UDP DNS query. Our code never sees the attempt, so '
            + 'there is nothing to bridge — an empty record of denied connections is what an '
            + 'enforcing policy with compliant traffic looks like AND what this gap looks like.',
        establishedBy: '#3932 (0.1g), re-verified against v0.1.6 in #4446',
    },
    {
        decision: 'sandbox-deleted-by-the-gateway',
        why:
            'A deletion this repository did not initiate — eviction, restart, operator action. '
            + '0.1g measured that a deleted sandbox is recoverable from neither the OCSF log nor '
            + 'the API afterwards, so there is no later read that could reconstruct it. Only '
            + 'deletions we request are recordable, and those are.',
        establishedBy: '#3932 (0.1g), re-verified against v0.1.6 in #4446',
    },
    {
        decision: 'policy-changed-at-the-gateway',
        why:
            'Recordable only as DRIFT DETECTED, not as the change itself. 5.2 (#3972) compares a '
            + 'policy hash and fires when it differs, so the record says when we noticed, never '
            + 'when it happened or who did it — the gateway logs no policy-change event. The '
            + 'distinction matters: a drift row is evidence of a detection, not of an act.',
        establishedBy: '#3932 (0.1g) for the absence; #3972 (5.2) for what replaces it',
    },
] as const;
