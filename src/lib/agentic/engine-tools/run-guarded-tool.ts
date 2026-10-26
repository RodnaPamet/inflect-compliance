/**
 * ONE GUARDED TOOL CALL, for every engine Inflect runs: egress on the model's
 * arguments, the funnel, then untrusted-input and egress on the result.
 *
 * Engine-neutral: no import of `@flue/*`, `valibot` or any ESM-only package
 * (enforced in `eslint.config.mjs`). Moved out of `flue/tools-adapter.ts` in
 * Step 0a of `docs/claude-agent-sdk-design.md`. The engine decides what to try;
 * this function and the funnel it calls decide what is permitted. Nothing here
 * checks a permission, calls a usecase or touches Prisma, and nothing may.
 *
 * The reasoning behind each slice of the sandwich is recorded at the slice
 * itself, below, and in the header of `flue/tools-adapter.ts`, which explains
 * why the sandwich sits at the tool boundary rather than around the model call.
 */
import { guardEgress, guardUntrustedInput } from '@/app-layer/ai/guard';
import type { McpInvocation } from '@/lib/mcp/authorize';
import { runReadTool } from '@/lib/mcp/tools/registry';
import { isProposeTool, runProposeTool } from '@/lib/mcp/tools/propose-tools';

import { ReviewLatch } from './review-latch';

/**
 * One guarded tool call: egress on the arguments, the funnel, untrusted-input
 * on the result.
 *
 * Exported for the tests, which need to exercise the sandwich without building
 * a whole tool set.
 *
 * WHICH funnel is decided from the NAME, by asking the registry that owns the
 * answer, rather than from a parameter the caller supplies. A parameter would
 * need a default, and the default would route a propose name into the read
 * funnel for any caller that forgot it — a refusal, but a misreported one. The
 * name is the whole input either way: both funnels resolve it through this
 * invocation's pinned manifest, so a tool this run was never offered is
 * refused with its own audit row before any object is obtained.
 */
export async function runGuardedTool(
    inv: McpInvocation,
    name: string,
    args: Record<string, unknown>,
    opts: {
        /**
         * The engine's name in every guard source this call writes:
         * `<prefix>-tool-args:<tool>:<id>`, `<prefix>-tool-result:…` and
         * `<prefix>-tool-result-egress:…`. REQUIRED, with no default, so a new
         * engine names its own rows rather than writing under another's. Flue
         * passes `'flue'`, which is the string these sources carried before
         * the move — no audit row changes shape.
         */
        readonly sourcePrefix: string;
        readonly toolCallId?: string;
        /** The run's one latch. A fresh one for a standalone call. */
        readonly review?: ReviewLatch;
        /**
         * Forwarded verbatim to `runProposeTool` and ignored on a read. Absent for
         * the direct MCP route and for a standalone call, which is what the
         * funnel's optional parameter is for.
         */
        readonly origin?: { runId: string; stepSeq: number };
    },
): Promise<string> {
    const ctx = inv.ctx;
    const toolCallId = opts.toolCallId ?? 'standalone';
    const review = opts.review ?? new ReviewLatch();
    const origin = opts.origin;
    const prefix = opts.sourcePrefix;

    // ── 0. ALREADY AWAITING A HUMAN ─────────────────────────────────────────
    //
    // Before the guards, not after: a run that is waiting on a person must not
    // spend another funnel call, another audit row or another scan to be told
    // the same thing again.
    review.assertNotTripped(name);

    // ── 1. The model's proposed ARGUMENTS, on their way to an action ────────
    //
    // Before the funnel, not after: the funnel runs the usecase (a read) or
    // queues the proposal (a write), and a guard that fired after that would be
    // reporting on something that had already happened. On the propose surface
    // this is the slice that decides whether the model's drafted content ever
    // reaches the review queue at all.
    const egress = await guardEgress(ctx, args, { source: `${prefix}-tool-args:${name}:${toolCallId}` });
    review.check(egress, name, 'args', toolCallId);

    // A propose call goes through the propose funnel and NOTHING else — no
    // usecase, no Prisma, no second door. That funnel enforces the credential
    // capability, the domain scope, the propose rung and the principal's own
    // create permission, validates the arguments, and queues a PENDING row a
    // human approves. `origin` is forwarded when a caller resolved one, so a
    // proposal a run produced is traceable back to the step that produced it;
    // the direct MCP route resolves none, and the funnel's own signature makes
    // that absence an answer rather than an omission.
    const result = isProposeTool(name)
        ? await runProposeTool(inv, name, args, origin)
        : await runReadTool(inv, name, args);

    // ── 2. The RESULT, on its way into the model's context ──────────────────
    //
    // `content[0]` is the tool's JSON payload and, on a read, `content[1]` is
    // the provenance banner the funnel appends. Every block is scanned: the
    // banner is ours and will never trip a rule, and reconstructing the joined
    // text is what the model actually receives.
    const text = result.content
        .map((block) => ('text' in block ? block.text : ''))
        .join('\n');

    const injected = await guardUntrustedInput(ctx, text, {
        source: `${prefix}-tool-result:${name}:${toolCallId}`,
    });
    // The funnel has already run, and that is fine on both surfaces: a read is
    // a read, and a propose queued a PENDING row nobody has approved — audited
    // either way, and committed neither way. What must not happen is the text
    // reaching the model, so the flag is enforced between the funnel and the
    // return rather than being allowed through with a warning attached.
    //
    // The slice that protects the QUEUE is the egress one above, which runs on
    // the proposed content before the funnel sees it; `createAgentProposal`
    // then guards each item again and can quarantine it on its own.
    review.check(injected, name, 'result', toolCallId);

    // ── 3. The RESULT, on its way OUT to the model provider ─────────────────
    //
    // A different question from the injection scan above, and the one that was
    // missing. `guardUntrustedInput` asks "is someone steering the model with
    // this text"; `guardEgress` asks "is there a secret in it". A tenant Risk
    // description carrying an API key passes the first and fails the second,
    // and this text is on its way to a third-party model provider.
    //
    // The egress slice earlier in this function scans the ARGS, and the
    // comment above says it protects the QUEUE. Nothing scanned the text
    // travelling in the other direction, so the run's own reads were the one
    // outbound path with no secret scan on it — while `gatherGrounding` in the
    // questionnaire usecase egress-scans exactly this class of content, and
    // ships only evidence TITLES for the same reason.
    //
    // Recorded under the same 'result' slice: both verdicts are about the same
    // text, and the ledger already folds every verdict for one `toolCallId`
    // into the worst seen, so a step whose result was flagged either way reads
    // as flagged.
    const leaking = await guardEgress(ctx, text, {
        source: `${prefix}-tool-result-egress:${name}:${toolCallId}`,
    });
    review.check(leaking, name, 'result', toolCallId);

    return text;
}
