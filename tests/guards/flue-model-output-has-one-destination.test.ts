/**
 * The model's free-text output is not egress-scanned, and the reason that is
 * safe is a claim about WHERE it can go. This file is that claim.
 *
 * ── WHY A GUARD AND NOT A COMMENT ───────────────────────────────────────────
 *
 * `tools-adapter.ts` justifies the absent scan in prose, and that prose was
 * WRONG for the whole life of the read-only adapter: it said the output
 * "becomes an `AgentProposal`" while no propose tool was offered, so the path
 * it pointed at did not exist. A comment explaining why a guard is unnecessary
 * is load-bearing exactly like the guard, and nothing checked this one.
 *
 * So the two destinations are asserted rather than described:
 *
 *   1. OUTPUT THAT BECOMES AN ACTION is a tool argument, and the egress slice
 *      runs BEFORE the funnel. Already scanned.
 *   2. OUTPUT THAT BECOMES NOTHING reaches exactly one column — the Art 12
 *      row's `outputSummary`, sanitised and bounded — and no other.
 *
 * The assertion with teeth is the SECOND HALF of (2): that `reply.text` has
 * one destination and not two. A new sink for model output added without a
 * scan is the regression this catches, and it is the kind that arrives as a
 * helpful-looking one-line addition to a ledger write.
 */
import { readFileSync } from 'fs';
import path from 'path';

import {
    callExpressionOf,
    codeOf,
    declarationOf,
    functionBodyOf,
    interfaceBodyOf,
} from '../helpers/source-blocks';

/**
 * `ROOT` computed LOCALLY — `tests/helpers/assertion-reach.ts` constant-folds a
 * `path.resolve(__dirname, …)` and declines an imported identifier, which would
 * put every assertion here in the Class D un-analysable set.
 */
const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(readFileSync(path.join(ROOT, rel), 'utf8'));

const EXECUTE = 'src/lib/agentic/flue/execute.ts';
/**
 * `recordModelDecision` moved out of `execute.ts` so a CJS suite could load and
 * RUN it. The reply object now crosses that one module boundary, so the count
 * below is taken over BOTH halves — counting only one file would let a second
 * sink added in the other pass, which is precisely the regression this file
 * exists to catch.
 */
const RECORDER = 'src/lib/agentic/flue/model-decision.ts';

describe('output that becomes an action was already scanned', () => {
    it('the egress slice runs before the funnel, on the propose path too', () => {
        const adapter = read('src/lib/agentic/flue/tools-adapter.ts');
        const egress = adapter.indexOf('await guardEgress(ctx, args,');
        const funnel = adapter.indexOf('isProposeTool(name)');
        expect(egress).toBeGreaterThan(-1);
        expect(funnel).toBeGreaterThan(egress);
    });

    it('and the proposal queue guards each item again on its own', () => {
        // The second scan, which is what makes the missing one here a choice
        // rather than a gap.
        //
        // The CALL, not the bare name: `createAgentProposal` occurs twice in
        // that file (its import and its one call site), and a needle satisfied
        // by the import would still pass with the call deleted — the assertion
        // would then be claiming a second scan that no longer runs, which is
        // the exact shape of the wrong comment this whole file exists to
        // replace.
        expect(read('src/lib/mcp/tools/propose-tools.ts')).toContain('await createAgentProposal(');
    });
});

describe('output that becomes nothing reaches ONE column', () => {
    const engine = read(EXECUTE);
    const recorder = read(RECORDER);

    it('the Art 12 summary, and that is the only read of the reply text', () => {
        // THE ASSERTION WITH TEETH. Counted, not merely present: a second sink
        // for model output is exactly the regression this file exists for, and
        // it arrives looking like a helpful addition to a ledger write.
        //
        // Summed across the dispatch half and the recording half, because the
        // reply travels from one to the other — so the total is still ONE.
        const uses =
            engine.split('reply.text').length - 1 + (recorder.split('reply.text').length - 1);
        expect({ readsOfReplyText: uses }).toEqual({ readsOfReplyText: 1 });
        expect(engine).toContain('await settleTurns(reply.text ?? null)');
        // …and it reaches the row as a PARAMETER. The recorder lives in
        // `./model-decision` since #2791 and cannot reach the reply itself, so
        // the single read above is the whole supply.
        expect(
            functionBodyOf(read(RECORDER), 'recordModelDecision'),
        ).toContain('outputSummary,');
    });

    it('and the RENAME does not open a second sink the count cannot see', () => {
        // THE HOLE THIS FILE HAD. The count above watches the literal
        // `reply.text`, and the value stops being spelled that way one line
        // later: `settleTurns(reply.text ?? null)` renames it to `finalText`
        // at the parameter boundary, so every sink added INSIDE that function
        // is invisible to the assertion that claims to cover them.
        //
        // Measured, not supposed. Adding `summary: finalText` to the ledger
        // write inside `settleTurns` — a second, unscanned, unbounded copy of
        // model output, rendered on the runs list — left this file GREEN at
        // 7/7 while a sink spelled `reply.text` in the same commit turned it
        // red. That is the file's own stated regression arriving through the
        // one spelling it does not watch.
        //
        // So the settled text is counted on the OTHER side of the rename too.
        // TWO uses: the parameter itself, and the ternary that gives the text
        // to the LAST turn and no other. A third is a new destination.
        const settle = declarationOf(engine, 'settleTurns');
        const uses = settle.split('finalText').length - 1;
        expect({ usesOfSettledText: uses }).toEqual({ usesOfSettledText: 2 });
        // And the run's own progress write must not be one of them — that is
        // the column the runs list renders, and `logAiDecision`'s sanitise +
        // 500-char bound do not apply to it.
        expect(callExpressionOf(settle, 'updateRun')).not.toContain('finalText');
        expect(callExpressionOf(settle, 'updateRun')).not.toContain('summary');
    });

    it('the per-call path reads TOKENS off the event stream, never model output', () => {
        // The sink this change could have added. A `turn` event carries
        // `response.output` — the assistant message that call produced —
        // beside the usage the accounting needs, and taking the call's own text
        // for its decision row is the obvious-looking per-call improvement.
        //
        // It is a second, unscanned copy of model output arriving through a
        // channel nobody reviews, which is the exact shape this file exists to
        // refuse. `TurnRecord` carries four numbers and no text, and the
        // subscriber reads only `response.usage`.
        expect(interfaceBodyOf(engine, 'TurnRecord')).not.toContain('string');
        expect(engine).not.toContain('response.output');
        expect(declarationOf(engine, 'onTurn')).toContain('event.response.usage');
    });

    it('which `logAiDecision` sanitises and bounds', () => {
        const log = read('src/app-layer/ai/decision-log/index.ts');
        // SANITISE-THEN-BOUND is the claim, and it survives the bound becoming
        // per-feature. The needle used to pin the literal `SUMMARY_MAX`, which
        // would have failed this change for the wrong reason: the safety
        // property is that the text is sanitised and truncated before it is
        // stored, not which number truncates it.
        expect(log).toContain('sanitizePlainText(input.outputSummary).slice(0, summaryCapFor(input.feature))');
    });

    it('and the agentic bound is larger than the one-shot bound, not unbounded', () => {
        // The cap moved because 500 discarded ~93% of a real production
        // conclusion — measured, not guessed. What must NOT follow is an
        // unbounded store: this log's whole premise is a bounded summary, and
        // "raise it until nothing truncates" is how a log becomes a copy of
        // the model's output.
        const log = read('src/app-layer/ai/decision-log/index.ts');
        const oneShot = Number(/const SUMMARY_MAX = (\d+)/.exec(log)?.[1]);
        const agentic = Number(/const AGENTIC_SUMMARY_MAX = (\d+)/.exec(log)?.[1]);
        expect(Number.isFinite(oneShot) && Number.isFinite(agentic)).toBe(true);
        expect(agentic).toBeGreaterThan(oneShot);
        expect(agentic).toBeLessThanOrEqual(8000);
    });

    it('the step ledger does NOT record it', () => {
        // A copy in the step ledger would be un-guarded model output in a
        // second, unreviewed place — and the ledger is rendered on the run
        // timeline, which the decision log's own surface is not a substitute
        // for.
        //
        // BOUND to the call, not sliced between two anchors. The old slice ran
        // from the ledger write to the `recordModelDecision` call, and the
        // second anchor moved above the first when the recorder gained a
        // caller — a backwards slice is silently empty, so every `not.toContain`
        // in it would have passed while checking nothing.
        const modelStep = callExpressionOf(engine, 'recordStep');
        expect(modelStep).toContain("'MODEL_CALL'");
        expect(modelStep).not.toContain('reply.text');
        expect(modelStep).not.toContain('output:');
    });

    it('and the run returns a status, never the text', () => {
        // The third way output could escape: handed back to the caller, which
        // for a queued run is the job executor and then the API.
        expect(engine).toContain("return { status: 'COMPLETED', stepFailures };");
        expect(engine).not.toContain('text: reply');
        expect(engine).not.toContain('summary: reply.text');
    });
});
