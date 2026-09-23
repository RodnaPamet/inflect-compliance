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
 * ── WHY STRUCTURAL ──────────────────────────────────────────────────────────
 *
 * The failing version completes runs correctly. Nothing about the run's own
 * output distinguishes it; the difference is a row in another table that
 * nobody reads during the run. A behavioural test would need the whole ESM
 * runtime plus a model, which is the reason this engine's paths are guarded
 * structurally throughout.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf, functionBodyOf } from '../helpers/source-blocks';

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
        // The CALL, not the bare name: `recordModelDecision(` occurs twice in
        // the file (its declaration and its one call site), and a needle
        // satisfied by the declaration would still pass with the call removed.
        expect(src).toContain('await recordModelDecision(ctx, runId, def,');
        expect(recorder).toContain('logAiDecision(');
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

    it('writes the row AFTER the step ledger, not instead of it', () => {
        // Two records with different owners: the step is the engine's, the
        // decision row is the regulator's. The one that cannot be written must
        // not stop the one that can.
        const body = functionBodyOf(src, 'executeFlueRun');
        expect(body.indexOf("'MODEL_CALL'")).toBeLessThan(body.indexOf('recordModelDecision('));
    });
});
