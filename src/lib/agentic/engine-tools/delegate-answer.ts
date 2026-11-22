/**
 * SCAN A DELEGATE'S ANSWER, exactly as a tool RESULT is scanned (#3473), for
 * every engine that delegates.
 *
 * Moved out of `flue/tools-adapter.ts` in Step 2e (#4594) so the Tool Runner,
 * which may not load a valibot module, scans its sub-agents' answers with the
 * same function Flue scans its delegates' with. The engine names its own
 * guard source prefix, with no default: `'flue'` keeps Flue's source
 * (`flue-delegate-answer:<taskId>`) byte for byte, and the Tool Runner's rows
 * read `tool-runner-delegate-answer:<toolUseId>`.
 *
 * ## Why a delegate's answer is a tool result in every respect that matters
 *
 * It crosses into the parent's context as the delegation tool's return value.
 * On Flue that tool is the runtime's own `task`, so its ledger wrapper never
 * sees it; on the Tool Runner it is Inflect's `delegate`, whose child already
 * egress-scanned the answer in its own loop. Either way the injection scan on
 * re-entry is this one.
 *
 * ## It reports through the run's OWN latch, so a flag settles the run
 *
 * `review.check` observes, records the flag and asserts, so a flagged answer
 * refuses every later guarded call, as a flagged tool result does (#5290).
 * Reported BEFORE the assertions, for the reason `check` gives.
 */
import { guardUntrustedInput } from '@/app-layer/ai/guard';
import type { RequestContext } from '@/app-layer/types';

import type { ReviewLatch } from './review-latch';

export async function guardDelegateAnswer(
    ctx: RequestContext,
    text: string,
    taskId: string | undefined,
    review: ReviewLatch,
    /** The engine's guard source prefix. Required, so a new engine names its own rows. */
    sourcePrefix: string,
    /** The delegation tool's name as the model called it: `task` on Flue, `delegate` on the Tool Runner. */
    toolName = 'task',
): Promise<void> {
    const outcome = await guardUntrustedInput(ctx, text, {
        source: `${sourcePrefix}-delegate-answer:${taskId ?? 'unknown'}`,
    });
    review.check(outcome, toolName, 'result', taskId ?? 'standalone');
}
