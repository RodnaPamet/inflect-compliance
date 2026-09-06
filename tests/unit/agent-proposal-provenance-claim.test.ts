/**
 * A PROPOSAL CANNOT CLAIM A PROVENANCE IT HAS NOT EARNED.
 *
 * ═══ WHAT THIS LOCKS OUT ═══
 *
 * `guardAgentProposal` is the one decision that keeps injected content out of
 * the review queue. Its ladder USED TO carry a provenance term:
 *
 *     if (worstIsMalicious && !mayCarryInstruction(provenance)) → QUARANTINED
 *
 * `mayCarryInstruction` is true for exactly one label, `SYSTEM`, and the
 * allowlist resolves five `platform.*` ids to it. So the function's `sourceId`
 * parameter — typed `string | null` — was a kill-switch: one argument, on the
 * one function that decides whether an agent's output becomes a compliance
 * record, and the failure is SILENT. Proposals stop being quarantined; the
 * queue looks healthy; nothing errors.
 *
 * No caller passed one, so it was LATENT rather than live. Nothing forbade the
 * next one, and "no caller does this today" is a fact about the present, not a
 * property of the code.
 *
 * ═══ WHAT REPLACED IT — three parts, and only two of them are enforced here ══
 *
 *   1. THE LADDER LOST THE TERM. A proposal is agent output by construction, so
 *      the second operand could never be false once (2) landed, and an operand
 *      no test can reach is not defence in depth. `worstIsMalicious` alone now
 *      quarantines. That is a REMOVAL, and the assertions below that a
 *      malicious proposal is QUARANTINED no longer distinguish it from the
 *      clamp — they pin the OUTCOME, which is what callers depend on.
 *
 *   2. THE CLAMP. `resolveProposalProvenance` refuses an instruction-bearing
 *      claim and reports `THIRD_PARTY_INGESTED` instead. This is what the
 *      runtime assertions below actually detect, and what they detect it
 *      through is the REPORTED LABEL: `createAgentProposal` writes
 *      `guard.provenance` onto the `AiDecisionLog` row and the audit entry, so
 *      an honoured `SYSTEM` claim would leave the durable record of an agent's
 *      proposal saying the platform authored it.
 *
 *   3. THE TYPE. `sourceId` is `DataOnlySourceId` — the allowlist minus every
 *      id whose label may carry instruction, derived from the table rather than
 *      listed a second time. A `platform.*` literal at that position is a
 *      compile error, which is stronger than any runtime assertion: the bad
 *      call cannot be WRITTEN. Asserted below with `@ts-expect-error`, which is
 *      itself an error when unused.
 *
 * ═══ WHICH CHECK ENFORCES WHICH ═══
 *
 * The type-level assertions in this file are enforced by `npm run typecheck`
 * ALONE, not by running it. `tsconfig.json` sets `isolatedModules`, so ts-jest
 * transpiles without checking, and a widened `sourceId` leaves this file GREEN
 * under jest while `tsc --noEmit` reports three unused `@ts-expect-error`
 * directives. Measured, not assumed: widening the parameter was mutation-tested
 * against this suite and all 34 tests still passed. Anything below that must
 * fail under jest is written as a runtime `expect`.
 *
 * The positive control is the half that makes the rest mean anything: a guard
 * that clamped EVERY label would satisfy the refusals and be useless.
 */
import {
    CONTENT_SOURCE_PROVENANCE,
    INSTRUCTION_BEARING_PROVENANCE,
    isDataOnlySourceId,
    mayCarryInstruction,
    resolveContentProvenance,
    type ContentProvenance,
    type DataOnlySourceId,
} from '@/lib/agentic/content-provenance';
import { guardAgentProposal } from '@/app-layer/ai/guard/proposal-guard';
import { CLEAN_PROPOSAL, INJECTION_CASES } from '../fixtures/prompt-injection-corpus';

/** A payload an agent would submit if it had obeyed an injected instruction. */
const OBEYED = INJECTION_CASES[0].obeyedProposal;

/**
 * Every id in the allowlist whose label may carry instruction. Read out of the
 * table, not typed out again — a sixth `platform.*` row added tomorrow joins
 * this list without anybody editing the test.
 */
const INSTRUCTION_BEARING_IDS = Object.entries(CONTENT_SOURCE_PROVENANCE)
    .filter(([, label]) => label === INSTRUCTION_BEARING_PROVENANCE)
    .map(([id]) => id);

/** The rest — the ids a proposal may legitimately claim. */
const DATA_ONLY_IDS = Object.entries(CONTENT_SOURCE_PROVENANCE)
    .filter(([, label]) => label !== INSTRUCTION_BEARING_PROVENANCE)
    .map(([id]) => id);

// The population itself is an assertion. If the allowlist ever stops naming a
// SYSTEM id, every refusal below would pass vacuously — "ran and found nothing"
// and "never ran" are the same output otherwise.
it('the corpus this test needs is non-empty in both directions', () => {
    expect(INSTRUCTION_BEARING_IDS.length).toBeGreaterThan(0);
    expect(DATA_ONLY_IDS.length).toBeGreaterThan(0);
    expect(mayCarryInstruction(INSTRUCTION_BEARING_PROVENANCE)).toBe(true);
});

describe('an instruction-bearing sourceId changes neither the verdict nor the label', () => {
    it.each(INSTRUCTION_BEARING_IDS)(
        '%s — a malicious proposal claiming it is QUARANTINED, and reported untrusted',
        (sourceId) => {
            // The cast is the attack: it is what a caller who evaded the type
            // would have written, and the only way to reach the runtime clamp
            // from a file the compiler is checking.
            const result = guardAgentProposal({
                kind: 'RISK',
                payload: OBEYED,
                sourceId: sourceId as DataOnlySourceId,
            });
            // The first two lines pin the OUTCOME and detect nothing on their
            // own — the ladder no longer reads provenance, so they would hold
            // with the clamp deleted. They are here because this is the
            // property every caller depends on, and a change that broke it
            // would have to break it in front of these lines.
            expect(result.verdict).toBe('QUARANTINED');
            expect(result.quarantined).toBe(true);
            // THESE two are the clamp's detector. The REPORTED label is the
            // clamped one, not the claimed one: `createAgentProposal` writes it
            // to the decision log and the audit row, so a result announcing
            // `SYSTEM` would put a false provenance in the durable record.
            expect(result.provenance).not.toBe(INSTRUCTION_BEARING_PROVENANCE);
            expect(mayCarryInstruction(result.provenance)).toBe(false);
        },
    );

    it('the claim is refused, not merely outvoted by the scan', () => {
        // The same clamp on CLEAN content, where no rule fires at all and the
        // verdict is not in question — so this cannot be satisfied by "the
        // scanner is strict" or by "the ladder quarantines everything".
        const result = guardAgentProposal({
            kind: 'FINDING',
            payload: CLEAN_PROPOSAL,
            sourceId: 'platform.aggregate' as DataOnlySourceId,
        });
        expect(result.verdict).toBe('CLEAN');
        expect(result.provenance).toBe('THIRD_PARTY_INGESTED');
    });

    it('and the same id resolved OUTSIDE the propose path still means what it says', () => {
        // The clamp belongs to the proposal seam, not to the provenance module.
        // If `resolveContentProvenance` had been changed instead, every other
        // consumer of the allowlist would silently lose the SYSTEM label.
        for (const sourceId of INSTRUCTION_BEARING_IDS) {
            expect(resolveContentProvenance(sourceId)).toBe(INSTRUCTION_BEARING_PROVENANCE);
            expect(isDataOnlySourceId(sourceId)).toBe(false);
        }
    });
});

describe('positive control — the guard is not simply refusing everything', () => {
    it.each(DATA_ONLY_IDS)('%s — a data-only sourceId resolves unchanged', (sourceId) => {
        const result = guardAgentProposal({
            kind: 'RISK',
            payload: CLEAN_PROPOSAL,
            sourceId: sourceId as DataOnlySourceId,
        });
        // Untouched by the clamp: what the allowlist says is what the guard used.
        expect(result.provenance).toBe(resolveContentProvenance(sourceId));
        expect(result.verdict).toBe('CLEAN');
        expect(isDataOnlySourceId(sourceId)).toBe(true);
    });

    it('a clean proposal with no sourceId at all is CLEAN and third-party', () => {
        const result = guardAgentProposal({ kind: 'FINDING', payload: CLEAN_PROPOSAL });
        expect(result.verdict).toBe('CLEAN');
        expect(result.provenance).toBe('THIRD_PARTY_INGESTED');
    });

    it('an injected proposal with no sourceId is still QUARANTINED', () => {
        const result = guardAgentProposal({ kind: 'RISK', payload: OBEYED });
        expect(result.verdict).toBe('QUARANTINED');
    });
});

describe('the type refuses the call the clamp catches', () => {
    it('a platform.* literal is not assignable to sourceId', () => {
        // NOT a runtime assertion — the assertion is that this file COMPILES,
        // and it only does while `sourceId` excludes the instruction-bearing
        // ids. Widen the parameter back to `string | null` and tsc reports
        // "Unused '@ts-expect-error' directive" on each line below. `tsc`, not
        // jest: see the header — under `isolatedModules` this test body still
        // passes, so do not read a green run here as the parameter being safe.
        guardAgentProposal({
            kind: 'RISK',
            payload: OBEYED,
            // @ts-expect-error - 'platform.aggregate' is instruction-bearing
            sourceId: 'platform.aggregate',
        });
        guardAgentProposal({
            kind: 'RISK',
            payload: OBEYED,
            // @ts-expect-error - 'platform.prompt-scaffold' is instruction-bearing
            sourceId: 'platform.prompt-scaffold',
        });
        guardAgentProposal({
            kind: 'RISK',
            payload: OBEYED,
            // @ts-expect-error - an arbitrary string is not an allowlisted id
            sourceId: 'platform.something-invented-later',
        });
        // The positive half: a data-only id compiles with no directive. If this
        // needed one, the type would be refusing every caller rather than the
        // dangerous ones.
        const ok: DataOnlySourceId = 'agent.proposal';
        expect(guardAgentProposal({ kind: 'RISK', payload: OBEYED, sourceId: ok }).verdict).toBe(
            'QUARANTINED',
        );
    });

    it('the union names exactly the allowlist\'s non-instruction-bearing ids', () => {
        // THE ORACLE IS HAND-WRITTEN ON PURPOSE, and it is the only thing in
        // this file that is. It was a second expression computed from
        // `CONTENT_SOURCE_PROVENANCE` by the same rule as the first, which
        // cannot fail and never touched `DataOnlySourceId` at all.
        //
        // Two independent checks meet on this literal:
        //
        //   • THE COMPILER ties it to the TYPE. `Record<DataOnlySourceId, _>`
        //     rejects a missing key (TS2741) and an excess one (TS2353), so the
        //     literal is exactly the union's members. That half is `npm run
        //     typecheck`, not this run — see the header.
        //   • THE `expect` BELOW ties it to the TABLE, and that half is red
        //     under jest.
        //
        // Together: the type names exactly the table's data-only ids. Add
        // `'foo.bar': 'THIRD_PARTY_INGESTED'` to the allowlist and BOTH fire —
        // the literal is missing a key of the union, and its keys no longer
        // equal the table's. Flip an existing id off `SYSTEM` and both fire
        // again. Neither can be satisfied by the other's mechanism.
        const unionMembers: Record<DataOnlySourceId, true> = {
            'ui.authenticated-form': true,
            'ui.review-decision': true,
            'api.authenticated-session': true,
            'upload.evidence-file': true,
            'upload.policy-document': true,
            'upload.vendor-document': true,
            'questionnaire.inbound-answer': true,
            'questionnaire.vendor-response': true,
            'scanner.vulnerability-import': true,
            'integration.servicenow': true,
            'integration.sharepoint': true,
            'integration.github': true,
            'integration.okta': true,
            'integration.entra-id': true,
            'integration.google-workspace': true,
            'integration.active-directory': true,
            'integration.workday': true,
            'integration.bamboohr': true,
            'webhook.inbound': true,
            'agent.proposal': true,
            'agent.tool-result': true,
        };
        expect(Object.keys(unionMembers).sort()).toStrictEqual(DATA_ONLY_IDS.slice().sort());
        // And the exclusion is real in both directions: no member of the union
        // is one of the ids the table calls instruction-bearing.
        for (const id of INSTRUCTION_BEARING_IDS) {
            expect(Object.keys(unionMembers)).not.toContain(id);
        }
    });
});

describe('no id in the whole allowlist can buy an instruction-bearing label', () => {
    it('every label the guard can report is a data-only one', () => {
        const reported = new Set<ContentProvenance>();
        for (const sourceId of Object.keys(CONTENT_SOURCE_PROVENANCE)) {
            reported.add(
                guardAgentProposal({
                    kind: 'RISK',
                    payload: CLEAN_PROPOSAL,
                    sourceId: sourceId as DataOnlySourceId,
                }).provenance,
            );
        }
        expect(reported.size).toBeGreaterThan(0);
        for (const label of reported) expect(mayCarryInstruction(label)).toBe(false);
    });
});
