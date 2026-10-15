/**
 * VR-6 — live execution overlay ratchet.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('VR-6 — execution overlay', () => {
    it('run-mode context + overlay module exist', () => {
        expect(exists('src/lib/processes/run-mode-context.tsx')).toBe(true);
        expect(exists('src/lib/processes/canvas-execution-overlay.tsx')).toBe(true);
    });

    it('the overlay is distributed via context (no per-node tenant SWR)', () => {
        const src = read('src/lib/processes/canvas-execution-overlay.tsx');
        expect(src).toMatch(/CanvasOverlayProvider/);
        // THE EXPORTS, by name, one unique match each.
        //
        // This was `toMatch(/useNodeOverlayState/)` with a comment saying
        // "either read satisfies this" — which is precisely the ambiguity
        // `assertion-needle-uniqueness-ratchet` objects to, and it went red:
        // the bare name appears twice in the module (the definition, and the
        // call inside the narrow wrapper), so two positions satisfied a needle
        // that was about neither in particular.
        //
        // Naming both exports is also the stronger claim. The module's job is
        // to expose a node-side read over the context, and it exposes TWO —
        // the full state for the node that needs the stuck count, and the
        // narrow status for callers that do not. A substring could not tell
        // "both are exported" from "one is, and the other is mentioned".
        expect(src).toMatch(/export function useNodeOverlayState\(/);
        expect(src).toMatch(/export function useNodeOverlayStatus\(/);

        // EVERY subscription IS POLLED, counted rather than existence-checked.
        //
        // This was `expect(src).toMatch(/refreshInterval/)` over the whole
        // file, which could not tell "the poll has an interval" from
        // "something somewhere in this module has one". #3472 added a SECOND
        // subscription — the agent-run channel — and
        // `assertion-needle-uniqueness-ratchet` went red, correctly: the needle
        // then had two satisfying positions and the assertion was about
        // neither of them in particular.
        //
        // Counting is the stronger claim a `toMatch` cannot make: it cannot
        // tell "both subscriptions are polled" from "one is polled and one
        // is not", which is the regression that matters — an unpolled
        // subscription renders once and then goes stale in Run Mode, looking
        // exactly like a canvas where nothing is happening.
        const subscriptions = (src.match(/useTenantSWR</g) ?? []).length;
        const intervals = (src.match(/refreshInterval/g) ?? []).length;
        expect(subscriptions).toBeGreaterThan(0);
        expect(intervals).toBe(subscriptions);

        // …and each one is GATED on run mode, so a canvas that is not in Run
        // Mode polls nothing. `enabled ? … : null` is SWR's own idiom for a
        // suspended key.
        expect((src.match(/enabled \? /g) ?? []).length).toBeGreaterThanOrEqual(
            subscriptions,
        );
    });

    it('the per-node overlay paint is PORTED (#3115)', () => {
        /*
            ═══ A RETIREMENT, REVERSED BY THE OWNER ═══

            This asserted the ABSENCE of the per-node paint, on the same terms as
            VR-5's retirement: the overlay shows per-node RUN state, which needs
            an AUTOMATION map, and production has 0 of them.

            The owner decided to port all three retired capabilities after VR-5's
            port went in (#3112). Recorded rather than quietly swapped: the
            production count is an argument about PRIORITY, and a guard asserting
            an absence had turned it into an argument about CORRECTNESS.

            ═══ WHAT THE PORT ACTUALLY WAS ═══

            Wiring, not building. Every piece survived the cutover in
            `lib/processes/canvas-execution-overlay.tsx` — the pure reducer, the
            pure status→class map, the provider and the context read — and the
            live-executions route was already serving. Two wires were missing:
            the workspace did not mount the provider, and the node util did not
            read the context.

            ═══ THE CONSTRAINT THAT OUTLIVED THE FEATURE ═══

            The original assertion's most interesting half was that the node must
            NOT subscribe per-node, because one request per node is how a
            500-node map melts. That is kept below, now asserted of a renderer
            that really does paint an overlay — where it is a live constraint
            rather than a trivially-true one.
        */
        const util = read('src/components/processes/tldraw/ProcessNodeShapeUtil.tsx');
        const workspace = read('src/components/processes/TldrawProcessWorkspace.tsx');

        // The node reads the CONTEXT… through `useNodeOverlayState` since
        // #3546, because it needs the stuck COUNT and not only the status.
        // `useNodeOverlayStatus` remains the narrow read for callers that want
        // just a status, and has its own provider test.
        expect(util).toMatch(/useNodeOverlayState\(/);
        expect(util).toMatch(/overlayClassFor\(/);
        // …and the workspace provides it, gated so the poll cannot run on a
        // document map. `enabled={isRunMode}` and not `enabled` bare: an
        // unconditional mount polls every 3s on every map in production.
        expect(workspace).toMatch(/<CanvasOverlayProvider enabled=\{isRunMode\}>/);

        // THE CONSTRAINT THAT SURVIVES: never a per-node subscription.
        expect(util).not.toMatch(/useCanvasExecutionOverlay/);
        expect(util).not.toMatch(/useTenantSWR/);
        expect(util).not.toMatch(/refreshInterval/);

        /*
            And the id is NARROWED, not cast. `dataJson` is the opaque
            passthrough (#2960), so a row whose `ruleId` is a number would be a
            render-time crash on the canvas if this read it as a string.
        */
        expect(util).toMatch(/export function ruleIdFromDataJson/);
        expect(util).toMatch(/typeof id === 'string'/);
    });

    /*
        ═══ NO SECOND APPROVAL PATH (#3472) ═══

        The plan's constraint is one sentence — "approve/reject from the canvas
        goes through the SAME usecase as /agents/proposals" — and it is the
        kind of claim that cannot be checked by looking at the canvas. A panel
        that grew its own approve endpoint, or its own usecase, would render
        identically and pass every rendered test; the only place the claim is
        visible is in what the code REACHES.

        So three reads, each closing a different way for a second path to
        appear:

          · the canvas panel's write fetches name the PROPOSALS routes;
          · the panel imports no write usecase of its own;
          · the checkpoint ROUTE declares no mutating handler, so the read the
            panel needs cannot quietly become the write it does.

        The third is the one worth stating twice. A read route beside a write
        is how a surface acquires a private door: the file already has the
        `requirePermission` wrapper and the run id, and adding a `POST` to it
        would be two lines that no rendered test and no permission census could
        tell from the read.
    */
    it('the canvas decides nothing — approve/reject reach the proposals routes', () => {
        const panel = read('src/components/processes/CheckpointReviewPanel.tsx');

        // THE WRITE TARGET, as the only interpolated path the panel POSTs to.
        expect(panel).toMatch(/\/agent-proposals\/\$\{p\.id\}\/\$\{action\}/);
        // And `action` is exactly the two decisions, so a third cannot be
        // smuggled through the same template.
        expect(panel).toMatch(/action: 'approve' \| 'reject'/);

        // NO WRITE USECASE OF ITS OWN. A client component importing one would
        // not even work — it would yield a client reference — but the import
        // is what a refactor adds first, so it is refused here rather than
        // discovered at runtime.
        expect(panel).not.toMatch(/approveAgentProposal|rejectAgentProposal/);
        expect(panel).not.toMatch(/resumeWorkflowRun|abortWorkflowRun/);

        // THE SAME DIFF COMPONENT the queue renders, which is what keeps the
        // "approve is a child of the diff" invariant from being re-authored
        // per surface.
        expect(panel).toMatch(/<ProposalDiffPanel/);
    });

    it('the checkpoint route is a READ, with no mutating handler', () => {
        const route = read('src/app/api/t/[tenantSlug]/agent-runs/[id]/checkpoint/route.ts');
        expect(route).toMatch(/export const GET =/);
        // Counted over the EXPORTED handlers rather than searched for as
        // words: `POST` appears in prose and in a comment about where the
        // decision does go, and `codeOf` has masked those — but a future
        // rewrite could put the word in a string. An export is unambiguous.
        const handlers = route.match(/export const (GET|POST|PUT|PATCH|DELETE) =/g) ?? [];
        expect(handlers).toEqual(['export const GET =']);
        // The gate is the review surface's own, spelled as the middleware.
        expect(route).toMatch(/requirePermission<\{ tenantSlug: string; id: string \}>\(\s*'admin\.view'/);
    });

    it('the node offers the affordance only to a viewer who may review', () => {
        const node = read('src/components/processes/tldraw/ProcessNodeShapeUtil.tsx');
        // THE CONJUNCTION, not either half. A node that checked only
        // `runAwaitsAHuman` would hand every reader a control that 403s, which
        // is the defect the proposals queue recorded; one that checked only
        // `canReview` would offer a review of a run nobody is waiting on.
        expect(node).toMatch(
            /canOpenCheckpoint =\s*runAwaitsAHuman && checkpoint\.canReview/,
        );
    });

});
