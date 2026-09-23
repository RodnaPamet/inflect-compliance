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

import { codeOf } from '../helpers/source-blocks';

/**
 * `ROOT` computed LOCALLY — `tests/helpers/assertion-reach.ts` constant-folds a
 * `path.resolve(__dirname, …)` and declines an imported identifier, which would
 * put every assertion here in the Class D un-analysable set.
 */
const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(readFileSync(path.join(ROOT, rel), 'utf8'));

const EXECUTE = 'src/lib/agentic/flue/execute.ts';

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

    it('the Art 12 summary, and that is the only read of the reply text', () => {
        // THE ASSERTION WITH TEETH. Counted, not merely present: a second sink
        // for model output is exactly the regression this file exists for, and
        // it arrives looking like a helpful addition to a ledger write.
        const uses = engine.split('reply.text').length - 1;
        expect({ readsOfReplyText: uses }).toEqual({ readsOfReplyText: 1 });
        expect(engine).toContain('outputSummary: reply.text ?? null');
    });

    it('which `logAiDecision` sanitises and bounds', () => {
        const log = read('src/app-layer/ai/decision-log/index.ts');
        expect(log).toContain('sanitizePlainText(input.outputSummary).slice(0, SUMMARY_MAX)');
    });

    it('the step ledger does NOT record it', () => {
        // A copy in the step ledger would be un-guarded model output in a
        // second, unreviewed place — and the ledger is rendered on the run
        // timeline, which the decision log's own surface is not a substitute
        // for.
        const modelStep = engine.slice(
            engine.indexOf("recordStep(ctx, runId, seq++, 'MODEL_CALL'"),
            engine.indexOf('await recordModelDecision('),
        );
        expect(modelStep.length).toBeGreaterThan(0);
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
