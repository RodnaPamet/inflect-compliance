/**
 * A PROPOSAL CANNOT CLAIM A PROVENANCE THAT SWITCHES QUARANTINE OFF.
 *
 * ═══ WHAT THIS LOCKS OUT ═══
 *
 * `guardAgentProposal` is the one decision that keeps injected content out of
 * the review queue, and its ladder has a provenance term:
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
 * Two layers now, because neither alone is enough:
 *
 *   1. THE TYPE. `sourceId` is `DataOnlySourceId` — the allowlist minus every
 *      id whose label may carry instruction, derived from the table rather
 *      than listed a second time. A `platform.*` literal at that position is a
 *      compile error, which is stronger than any assertion here: the bad call
 *      cannot be WRITTEN. That is asserted below with `@ts-expect-error`, which
 *      `npm run typecheck` fails on if the parameter is ever widened back —
 *      an unused `@ts-expect-error` is itself an error.
 *
 *   2. THE CLAMP. A type is not a runtime property. An `as` cast, an id read
 *      out of a row, or a JS caller all arrive with whatever string they like,
 *      so `resolveProposalProvenance` refuses an instruction-bearing label and
 *      returns the untrusted one. Every assertion below drives the runtime.
 *
 * The positive control is the half that makes the rest mean anything: a guard
 * that quarantined EVERY proposal would satisfy the refusals and be useless.
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

describe('an instruction-bearing sourceId cannot disarm the quarantine', () => {
    it.each(INSTRUCTION_BEARING_IDS)(
        '%s — a malicious proposal claiming it is still QUARANTINED',
        (sourceId) => {
            // The cast is the attack: it is what a caller who evaded the type
            // would have written, and the only way to reach the runtime clamp
            // from a file the compiler is checking.
            const result = guardAgentProposal({
                kind: 'RISK',
                payload: OBEYED,
                sourceId: sourceId as DataOnlySourceId,
            });
            expect(result.verdict).toBe('QUARANTINED');
            expect(result.quarantined).toBe(true);
            // The REPORTED label is the clamped one, not the claimed one.
            // A result that quarantined while announcing `SYSTEM` would tell
            // every downstream reader a provenance the guard did not use.
            expect(result.provenance).not.toBe(INSTRUCTION_BEARING_PROVENANCE);
            expect(mayCarryInstruction(result.provenance)).toBe(false);
        },
    );

    it('the claim is refused, not merely outvoted by the scan', () => {
        // Same clamp on CLEAN content, where no rule fires at all — so the
        // assertion above cannot be satisfied by "the scanner is strict".
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
        // "Unused '@ts-expect-error' directive" on each line below.
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

    it('the data-only union is DERIVED from the allowlist, not a second list', () => {
        // A hand-maintained enum drifts the moment somebody adds a row to the
        // table. This asserts the two agree today, which is the property a
        // derivation gives for free and a copy does not.
        const derived = DATA_ONLY_IDS.slice().sort();
        const fromTable = Object.keys(CONTENT_SOURCE_PROVENANCE)
            .filter((id) => isDataOnlySourceId(id))
            .sort();
        expect(derived).toStrictEqual(fromTable);
    });
});

describe('the clamp reads one rule, and it is the rule the ladder reads', () => {
    it('every label the guard can report is one the ladder will quarantine on', () => {
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
