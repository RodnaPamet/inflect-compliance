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

import { callExpressionOf, codeOf, functionBodyOf } from '../helpers/source-blocks';

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

/**
 * ── THE ORIGIN A FLUE PROPOSAL CARRIES ──────────────────────────────────────
 *
 * The same seam, one field over. `wrapForLedger` allocates a step seq per tool
 * call; `AgentProposal.(runId, stepSeq)` is what lets a reviewer walk from a
 * queued write back to the reasoning that drafted it, and `/agents/proposals`
 * renders that pair as a link into the run's ledger.
 *
 * ── WHY THIS IS STRUCTURAL WHEN THE REST OF THE CHAIN IS NOT ────────────────
 *
 * Every other link in it is behavioural and stays that way. The database CHECK
 * is exercised in `tests/integration/agent-proposal-run-provenance.test.ts`;
 * the static driver's write is exercised end to end in
 * `tests/integration/agentic-engine.test.ts`; the adapter's forwarding — that
 * `runGuardedTool` hands `runProposeTool` the origin the resolver returned, per
 * call id, and `undefined` when nobody resolved one — is exercised against real
 * calls in `tests/unit/flue-tools-adapter.test.ts`.
 *
 * What CANNOT be exercised is the one piece in between: `execute.ts` statically
 * imports `@flue/runtime`, which publishes no `require` condition, so the `node`
 * project cannot load this module at all (the file header above says the same
 * about the charge). That leaves the resolver's CONSTRUCTION — the half that
 * decides whether a resolver exists — reachable only by reading it.
 *
 * ── AND IT IS EXACTLY THE HALF NOTHING ELSE WOULD NOTICE ────────────────────
 *
 * The adapter's parameter is optional, because the direct MCP route legitimately
 * resolves no origin. So dropping the third argument to `flueToolsFor` here
 * compiles, passes every adapter test (they inject their own resolver), passes
 * the integration tests (they exercise the STATIC driver), and silently lands
 * every Flue-queued proposal with `runId: null` — which reads, correctly and
 * indistinguishably, as "proposed outside a run".
 *
 * The needles below are bound to the CALL and to the FUNCTION BODY, never to
 * the file, so a survivor elsewhere in `execute.ts` cannot satisfy one.
 */
describe('a Flue run tells its proposals which step made them', () => {
    const toolSetCall = callExpressionOf(read(EXECUTE), 'flueToolsFor');

    it('builds the tool set WITH an origin resolver', () => {
        // The load-bearing one. `flueToolsFor(inv, observe?, originFor?)` — the
        // third argument is what reaches the propose surface, and its absence
        // is a silent downgrade rather than an error.
        expect(toolSetCall).toContain('stepOfCall.get(toolCallId)');
        expect(toolSetCall).toContain('{ runId, stepSeq }');
    });

    it('and answers undefined rather than inventing a run', () => {
        // A read tool's call id is never registered, so the map misses. The
        // funnel's own signature makes that absence an answer; a fallback of
        // `{ runId, stepSeq: 0 }` would attribute every unregistered call to
        // the run's first step.
        expect(toolSetCall).toContain('stepSeq === undefined ? undefined :');
    });

    it('registers the seq it ALLOCATED, under THIS call id, before the tool runs', () => {
        // Three claims in one needle, and each is a different bug:
        //   · `seq` — not `seq + 1`, not the step COUNT. It is the same
        //     variable `recordStep` is given below, so the proposal's ordinal
        //     and the ledger row's ordinal cannot disagree.
        //   · `context.toolCallId` — not a module field. The runtime may have
        //     several calls in flight, and a shared field would attribute one
        //     call's proposals to another's step.
        //   · BEFORE the call, because the call is what reads it.
        expect(ledgerWrapper).toContain('ledger.noteOrigin(context.toolCallId, seq)');

        const note = ledgerWrapper.indexOf('ledger.noteOrigin(context.toolCallId, seq)');
        const call = ledgerWrapper.indexOf('await tool.run(context)');
        const record = ledgerWrapper.indexOf("recordStep(ctx, runId, seq, 'TOOL_CALL'");
        expect({ noteFound: note > -1, callFound: call > -1, recordFound: record > -1 })
            .toEqual({ noteFound: true, callFound: true, recordFound: true });
        expect(note).toBeLessThan(call);
    });

    it('and forgets it afterwards, so a recycled id inherits nothing', () => {
        // Symmetrical with `takeVerdict`'s delete and for the same two reasons:
        // the entry is this call's, and leaving it would both leak for the life
        // of the run and let a later call with a recycled id resolve to a step
        // that was not its own.
        expect(ledgerWrapper).toContain('ledger.forgetOrigin(context.toolCallId)');
    });
});
