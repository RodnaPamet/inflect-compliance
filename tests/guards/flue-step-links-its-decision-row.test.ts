/**
 * A MODEL_CALL step reaches the EU AI Act Art 12 row it produced.
 *
 * ── WHY THERE IS NO FOREIGN KEY ─────────────────────────────────────────────
 *
 * `AiDecisionLog` carries no `runId`, deliberately: it is the regulator's
 * record of a DECISION, not the engine's bookkeeping, and giving it a run
 * column would make it a second ledger. The two are joined on
 * `(tenantId, inputDigest)` — the same key `AgentProposal.guardInputDigest`
 * already uses — so the step records the digest and the surface links on it.
 *
 * ── THE CLAIM THAT MATTERS ──────────────────────────────────────────────────
 *
 * Not "a link is rendered" — that a link lands on the RIGHT ROW. The step and
 * the decision row derive their digest independently, one line apart, and if
 * those two ever compute over different values the link still renders and
 * still opens a page, showing a decision that belongs to some other call. A
 * confidently wrong governance surface is the failure this repo keeps finding
 * (#2774, #2783), so the agreement is asserted by COMPUTING BOTH, not by
 * reading that both call the same function.
 *
 * ── AND WHY ONLY THE MODEL-CALL HALF ────────────────────────────────────────
 *
 * The plan asks for a per-step guard chip linked to its decision row. A TOOL
 * call has a guard verdict and NO decision row — the Art 12 row is written per
 * MODEL call. Linking every guarded step would land half of them on an empty
 * table, which is precisely what the decisions page's own note refused to do
 * before there was a key. That half stays unwired and says so.
 */
import { readFileSync } from 'fs';
import path from 'path';

import { computeInputDigest } from '@/app-layer/ai/decision-log';

import { codeOf, functionBodyOf } from '../helpers/source-blocks';

/**
 * `ROOT` computed LOCALLY — `tests/helpers/assertion-reach.ts` constant-folds a
 * `path.resolve(__dirname, …)` and declines an imported identifier, which would
 * put every assertion here in the Class D un-analysable set.
 */
const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(readFileSync(path.join(ROOT, rel), 'utf8'));

const EXECUTE = 'src/lib/agentic/flue/execute.ts';
const PAGE = 'src/app/t/[tenantSlug]/(app)/agents/runs/[runId]/page.tsx';

describe('the two sides compute the same key', () => {
    it('a digest is a sha256 of the sanitised input, and is stable', () => {
        // The property the link stands on. Behavioural, over the real
        // function both sides call.
        const message = 'Run the nightly posture review for acme.';
        expect(computeInputDigest(message)).toBe(computeInputDigest(message));
        expect(computeInputDigest(message)).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('and a DIFFERENT input gives a different key — the link can miss', () => {
        // The half that makes the agreement matter. If every input hashed the
        // same, a link would always "work" and always be meaningless.
        expect(computeInputDigest('one')).not.toBe(computeInputDigest('two'));
    });

    it('the step and the decision row are computed over the SAME value', () => {
        // Both must be `runMessage(def, fromSeq)`. This is the assertion that
        // catches a link pointing at the wrong row: if one side ever switches
        // to the workflow key, the reply, or a slice, the digests diverge,
        // every link still renders, and every one of them opens somebody
        // else's decision.
        const body = functionBodyOf(read(EXECUTE), 'executeFlueRun');
        expect(body).toContain('decisionDigest: computeInputDigest(runMessage(def, fromSeq))');
        // DELIBERATELY BRITTLE to the signature, and it earned that on the
        // merge that added `runId` for the Art 14 `sessionRef` join: this
        // assertion went red, which forced someone to go and re-confirm that
        // both sides still digest `runMessage(def, fromSeq)` before updating
        // the needle. A looser needle would have stayed green through a
        // signature change that could just as easily have swapped the message
        // for the workflow key — and every link would then have opened the
        // wrong row, silently.
        expect(body).toContain('await recordModelDecision(ctx, runId, def, runMessage(def, fromSeq),');
    });

    it('through ONE function, not two implementations of the rule', () => {
        // `logAiDecision` computes the stored digest with `computeInputDigest`.
        // Sharing the function is what makes the assertion above sufficient;
        // a second copy of "sha256 of the JSON" would let them drift while
        // both looked right.
        expect(read('src/app-layer/ai/decision-log/index.ts')).toContain(
            'inputDigest: computeInputDigest(input.sanitizedInput)',
        );
    });
});

describe('the surface offers the link only where there is a row', () => {
    const page = read(PAGE);

    it('derives the digest server-side, from the step it belongs to', () => {
        expect(page).toContain('decisionDigest: decisionDigestOf(s.inputJson)');
    });

    it('with a GUARDED parse — a malformed blob costs the link, not the page', () => {
        // The run page deliberately passes `inputJson` through as a raw string
        // so a bad blob breaks one collapsed panel rather than the route. A
        // naked `JSON.parse` here would undo that decision for the sake of one
        // anchor.
        const helper = functionBodyOf(page, 'decisionDigestOf');
        expect(helper).toContain('try {');
        expect(helper).toContain('catch');
        expect(helper).toContain('return null');
    });

    it('and shape-checks the value before it reaches a query string', () => {
        // It is interpolated into a URL. `sha256:<64 hex>` is the only thing
        // the decisions page can act on, and anything else should produce no
        // link rather than a link to nothing.
        expect(functionBodyOf(page, 'decisionDigestOf')).toContain('/^sha256:[0-9a-f]{64}$/');
    });

    it('a TOOL call records no digest, so it offers no link', () => {
        // The tool-call half stays unwired because there is nothing to point
        // at — the Art 12 row is written per MODEL call. Asserted as CODE
        // rather than by checking the decisions page still says so in prose:
        // a guard over a comment verifies that somebody wrote a sentence, and
        // this repo's own rule is never to gate CI on prose.
        //
        // `wrapForLedger` owns every TOOL_CALL write. If a digest ever
        // appeared there it would have to be a real one, and this goes red
        // asking for it.
        expect(functionBodyOf(read(EXECUTE), 'wrapForLedger')).not.toContain('decisionDigest');
    });

    it('and exactly ONE step kind records one', () => {
        // The population, so the assertion above cannot pass by the field
        // having vanished entirely.
        const body = read(EXECUTE);
        expect(body.split('decisionDigest').length - 1).toBe(1);
    });
});
