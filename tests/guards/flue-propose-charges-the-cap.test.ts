/**
 * A Flue agent's proposals are charged against the run's PROPOSALS cap, per
 * ITEM.
 *
 * ── THE HOLE THIS CLOSES ────────────────────────────────────────────────────
 *
 * `executeFlueRun` has always SEEDED the budget with
 * `proposedItemsSoFar(ctx, runId)`, and `wrapForLedger` has always charged
 * `STEPS` and `TOOL_CALLS` before invoking a tool. `PROPOSALS` was seeded and
 * never charged — harmless exactly as long as nothing on this engine could
 * propose. Offering the propose surface is what turns that seed from a number
 * into a cap, and what makes an uncharged propose call an escape: the run
 * reports its proposal count as whatever the STATIC driver last left there.
 *
 * ── AND WHY PER ITEM ────────────────────────────────────────────────────────
 *
 * `proposeArgs` accepts `items` of 1..20 and `runProposeTool` queues one
 * PENDING `AgentProposal` per item. Charging the CALL would let a run reach
 * twenty times its cap with the counter reading correct — the precise shape of
 * the escape point 5 of the integration plan names, "a loop cannot escape the
 * cap by spending in a kind the counter ignores", one level down: a kind the
 * counter charges at the wrong unit.
 *
 * ── WHAT IS ASSERTED STRUCTURALLY AND WHY ───────────────────────────────────
 *
 * `wrapForLedger` is module-private and its charge happens inside a closure the
 * Flue runtime invokes — and `execute.ts` cannot even be IMPORTED under the
 * `node` project, because it reaches `@flue/runtime`, which is ESM-only. So the
 * charge is read off the source, bound to the function that owns it.
 *
 * The COUNTING RULE is not read off source: `proposedItemCount` is a pure
 * function living beside the `proposeArgs` envelope whose 1–20 rule it mirrors,
 * and it is exercised directly — "how many is this" is the part a reader would
 * get wrong and the part a structural needle cannot judge.
 */
import { readFileSync } from 'fs';
import path from 'path';

import { proposedItemCount } from '@/lib/mcp/tools/propose-tools';

import { codeOf, functionBodyOf } from '../helpers/source-blocks';

/**
 * `ROOT` computed LOCALLY — `tests/helpers/assertion-reach.ts` constant-folds a
 * `path.resolve(__dirname, …)` and declines an imported `REPO_ROOT`, which
 * would put every assertion below in the Class D un-analysable set.
 */
const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(readFileSync(path.join(ROOT, rel), 'utf8'));

const EXECUTE = 'src/lib/agentic/flue/execute.ts';
const ledgerWrapper = functionBodyOf(read(EXECUTE), 'wrapForLedger');

describe('how many proposals a call is worth', () => {
    it('is the number of items it carries, not one', () => {
        expect(proposedItemCount({ items: [{ a: 1 }, { b: 2 }, { c: 3 }] })).toBe(3);
        expect(proposedItemCount({ items: [{ a: 1 }] })).toBe(1);
        // The envelope's own ceiling. A call at the maximum must charge twenty,
        // which is the case the per-call charge got wrong by a factor of 20.
        expect(proposedItemCount({ items: Array.from({ length: 20 }, () => ({})) })).toBe(20);
    });

    it('an uncountable shape charges ONE, never zero', () => {
        // Fail closed. Zero would make a malformed propose call free, and free
        // is the only answer a cap can never recover from.
        expect(proposedItemCount({})).toBe(1);
        expect(proposedItemCount({ items: 'not an array' })).toBe(1);
        expect(proposedItemCount(undefined)).toBe(1);
        expect(proposedItemCount(null)).toBe(1);
    });
});

describe('the charge is wired where the other two are', () => {
    it('wrapForLedger charges PROPOSALS', () => {
        expect(ledgerWrapper).toContain("budget.charge('PROPOSALS'");
    });

    it('by the item count, not by one', () => {
        // The needle names the VARIABLE the count is bound to. `charge(kind, 1)`
        // beside it is the STEPS/TOOL_CALLS loop and would satisfy a needle
        // that only asked whether PROPOSALS appeared near a charge.
        expect(ledgerWrapper).toContain("budget.charge('PROPOSALS', items)");
        expect(ledgerWrapper).toContain('proposedItemCount(context.data)');
    });

    it('and only for a propose tool, decided by the registry the adapter dispatches on', () => {
        // Not `annotations.readOnlyHint`, and not a name prefix. A second way
        // of answering "is this a propose tool" is a way for the charge and the
        // funnel to disagree, and the disagreement that matters is a propose
        // call the funnel runs and the counter never sees.
        expect(ledgerWrapper).toContain('isProposeTool(tool.name)');
        expect(read(EXECUTE)).toContain(
            "import { isProposeTool, proposedItemCount } from '@/lib/mcp/tools/propose-tools'",
        );
        expect(read('src/lib/agentic/flue/tools-adapter.ts')).toContain('isProposeTool(name)');
    });

    it('BEFORE the tool runs, like the other two counters', () => {
        // The pre-execution property: a refusal means the tool function was
        // never invoked. Asserted by position rather than by prose — the charge
        // must precede the `await tool.run(context)` in the same body.
        const charge = ledgerWrapper.indexOf("budget.charge('PROPOSALS'");
        const call = ledgerWrapper.indexOf('await tool.run(context)');
        expect(charge).toBeGreaterThan(-1);
        expect(call).toBeGreaterThan(-1);
        expect(charge).toBeLessThan(call);
    });

    it('and a halt latches the run, as every other cap does', () => {
        // The halt must not merely throw: `latch.halt` is what stops the NEXT
        // tool call, and a throw alone would let the run keep spending until
        // the runtime happened to stop.
        const after = ledgerWrapper.slice(ledgerWrapper.indexOf("budget.charge('PROPOSALS'"));
        expect(after.slice(0, 300)).toContain('latch.halt = halt');
    });
});

describe('the seed the charge makes meaningful', () => {
    it('is still read from the store, so prior steps count against the same cap', () => {
        // Without this the charge would cap a Flue run in isolation while a run
        // that had already proposed through the static driver started fresh.
        expect(read(EXECUTE)).toContain('proposedItemsSoFar(ctx, runId)');
    });
});
