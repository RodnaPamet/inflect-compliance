/**
 * EVERY FLUE MODEL CALL LEAVES AN ART 12 ROW.
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 *
 * Plan point 4: "ONE decision-log row per model call — EU AI Act Art 12; stamp
 * `humanOutcome` on review — Art 14, closed loop." An adversarial audit of
 * Phase 1 found that nothing wrote one for a Flue run.
 *
 * That is the worst place for the gap to be. Every other AI feature in this
 * product writes one; the reasoning loop is the feature with the most model
 * calls and the least human in the way, and it wrote none. No Art 12 record
 * means no PENDING row, which means Art 14 has nothing to stamp — the "closed
 * loop" the bullet names was open at both ends.
 *
 * ── WHAT IS STRUCTURAL HERE AND WHAT IS NOT ─────────────────────────────────
 *
 * This file keeps the claims about the row's SHAPE — which writer, which
 * digest, which columns are deliberately left null. Those are properties of
 * one function and a source read binds them exactly.
 *
 * The claims about the row's CARDINALITY and its VALUES moved to
 * `tests/unit/flue-per-turn-accounting.test.ts`, which drives `executeFlueRun`
 * with `@flue/runtime` virtually mocked and reads the rows back off
 * `logAiDecision`. They had to move: this file's ordering assertion could not
 * tell one row per dispatch from one row per model call, and that was the
 * defect. A needle asserting a line exists is not an assertion that a value is
 * ever written down.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf, declarationOf, functionBodyOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const EXECUTE = 'src/lib/agentic/flue/execute.ts';
// The recorder MOVED out of `execute.ts` so a CJS suite can load it — see the
// module docstring. `execute.ts` still owns the call site, so both files are
// read here and each assertion names the one that owns its claim.
const RECORDER = 'src/lib/agentic/flue/model-decision.ts';

describe('the Art 12 row', () => {
    const src = read(EXECUTE);
    const recorderSrc = read(RECORDER);
    const recorder = functionBodyOf(recorderSrc, 'recordModelDecision');

    it('is written by the run, through the shared writer', () => {
        // `logAiDecision`, not a hand-rolled create: it digests the input,
        // sanitises and bounds the summary, and is the one place those rules
        // live for every AI feature.
        //
        // Bound to `settleTurns` rather than grepped for: `recordModelDecision`
        // appears in the file as an import, a call and several comments, and a
        // whole-file needle is satisfied by any of them — including the ones
        // that would still be there with the call deleted.
        const settle = declarationOf(src, 'settleTurns');
        expect(settle).toContain('await recordModelDecision(');
        // AND the argument that carries the Art 14 join. #2791 made the
        // recorder take the run id for `sessionRef`; a per-turn rewrite that
        // dropped it would still write Art 12 rows and would silently leave
        // every one of them unreviewable.
        expect(settle).toContain('runId,');
        expect(recorder).toContain('logAiDecision(');
    });

    it('carries ONE model call, not a dispatch’s worth of them', () => {
        // The shape of the second gap. `recordModelDecision` took the response
        // aggregate (`usage: FlueUsageReport`) and ran once per dispatch, so a
        // six-turn run left one row holding six calls' summed tokens. It now
        // takes a `TurnRecord` — the runtime's leaf-level per-call usage — and
        // the loop that calls it is what makes the rows plural.
        //
        // The CARDINALITY is proved behaviourally in
        // `tests/unit/flue-per-turn-accounting.test.ts`; this is the type-level
        // half, which is what stops the aggregate being handed back in.
        // THIS call's tokens, passed as the recorder's `usage` argument —
        // `turn.tokensIn`/`turn.tokensOut`, never the dispatch aggregate
        // `usage.totalTokens` the old per-dispatch row carried.
        expect(declarationOf(src, 'settleTurns')).toContain('{ tokensIn: turn.tokensIn, tokensOut: turn.tokensOut }');
        expect(declarationOf(src, 'settleTurns')).toContain('for (const [i, turn] of pending');
    });

    it('digests the dispatched message, which is what makes it a join key', () => {
        // `sanitizedInput` is hashed and never stored. Taking the digest over
        // the message is what lets /agents/decisions?digest= land on the
        // decisions taken over this run's prompt.
        expect(recorder).toMatch(/sanitizedInput:\s*message/);
    });

    it('names the workflow, so three agentic workflows are distinguishable', () => {
        expect(recorder).toMatch(/feature:\s*`agentic-run:\$\{def\.key\}`/);
    });

    it('records the token SPLIT, not just a total', () => {
        // Art 12 wants in and out. The sum hides which shape a call had, and
        // only one of those shapes is a runaway generation.
        expect(recorder).toContain('tokensIn');
        expect(recorder).toContain('tokensOut');
    });

    it('and the call’s own latency, which a dispatch-level row could not carry', () => {
        // `turn.durationMs` is the model call's wall clock. The per-dispatch
        // row left `latencyMs` unset entirely — there was no single duration
        // to report for six calls.
        // The call's OWN wall clock, which only a `turn` event carries — the
        // response aggregate has no per-call duration. Passed positionally to
        // the recorder, which writes it to `latencyMs`.
        expect(declarationOf(src, 'settleTurns')).toContain('turn.durationMs');
        expect(recorder).toContain('latencyMs,');
    });

    it('links the registered agent’s AI system', () => {
        // A Flue run is refused unless an ACTIVE RegisteredAgent vouches for
        // it, and that row carries a non-null aiSystemId — so the record is
        // findable from the system it belongs to.
        expect(recorder).toContain('aiSystemId');
        expect(functionBodyOf(recorderSrc, 'aiSystemIdFor')).toContain('registeredAgent');
    });

    it('does NOT claim a guard verdict it did not obtain', () => {
        // The honest omission. No guard runs on model OUTPUT yet (4a). Writing
        // the worst verdict seen across the run's TOOL calls would put a
        // verdict about other content in a column that reads as a verdict
        // about this one.
        expect(recorder).not.toMatch(/guardVerdict:/);
    });

    it('does not fail the run when the record cannot be written', () => {
        // The call happened. Refusing to settle a completed run because its
        // record failed would lose the work as well as the record — the same
        // posture appendAuditEntry takes at every other sink here.
        expect(recorder).toContain('catch');
        expect(recorder).toContain('logger.error');
    });

    it('writes the rows AFTER the step ledger, not instead of it', () => {
        // Two records with different owners: the step is the engine's, the
        // decision rows are the regulator's. The one that cannot be written
        // must not stop the one that can.
        //
        // Anchored on the CALL to `settleTurns`, not on `recordModelDecision`,
        // which now sits inside a closure DECLARED above the ledger write. The
        // two indices must both be found, or a rename turns this into `-1 <
        // -1` — false, which is the right direction, but the explicit floor
        // says why.
        const body = functionBodyOf(src, 'executeFlueRun');
        expect(body.indexOf("'MODEL_CALL'")).toBeGreaterThan(-1);
        expect(body.indexOf("'MODEL_CALL'")).toBeLessThan(
            body.indexOf('await settleTurns(reply.text'),
        );
    });
});
