/**
 * ASK THE WORKSPACE A QUESTION (#3869).
 *
 * The whole of M2's write path, and it is four lines of logic because every
 * part it needs already exists and is tested on its own:
 *
 *   `readAdHocQuestion`    decides whether the text is a question, and bounds it
 *   `startInteractiveRun`  resolves the tenant's designated agent, asks the kill
 *                          switch and the breaker, and starts the run with the
 *                          requester's own context and the agent bound
 *
 * Deliberately thin. The temptation in a function like this is to re-check
 * something — the agent, the budget, the person — and every such check would be
 * a second control over a fact one of those two already decides, which is how
 * two controls come to disagree and the weaker one wins.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A BAD QUESTION IS 400, A BAD CALLER IS 403
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The two refusal families are told apart by the status they carry, and the
 * distinction is not cosmetic. `readAdHocQuestion`'s refusals are about the
 * SHAPE of the input — too long, not text, nothing readable — and the caller
 * fixes them by sending something different, so they are `badRequest`.
 * `startInteractiveRun`'s are about AUTHORITY and configuration — not a person,
 * flag off, no agent designated, agent killed — and the caller cannot fix them
 * by retrying, so they are `forbidden` and reach the client as 403s carrying
 * their code.
 *
 * Collapsing them would make a client unable to tell "ask a shorter question"
 * from "an administrator must designate an agent", which are the two ends of
 * the range of things that can go wrong here.
 */
import { badRequest } from '@/lib/errors/types';
import { readAdHocQuestion } from '@/lib/agentic/ad-hoc-question-input';
import { startInteractiveRun } from './interactive-agent-runs';
import { AD_HOC_QUESTION_WORKFLOW_KEY } from './ad-hoc-question-result';
import type { RequestContext } from '../types';

/**
 * Start a run that answers `rawQuestion`, or throw the named refusal.
 *
 * The question is read BEFORE the agent is resolved, on purpose: a malformed
 * question is the caller's to fix and costs nothing to refuse, while resolving
 * the agent is four database reads. Refusing the cheap, caller-fixable case
 * first also means a flood of bad input cannot drive load onto the register.
 */
export async function askAdHocQuestion(
    ctx: RequestContext,
    rawQuestion: unknown,
): Promise<{ readonly runId: string }> {
    const reading = readAdHocQuestion(rawQuestion);
    if (!reading.ok) {
        throw badRequest(`${reading.refusal}: ${reading.detail}`);
    }

    // The SANITISED text is what reaches the run input — never `rawQuestion`.
    // Two readers of one untrusted value eventually disagree about what it
    // says, and the one that matters is whichever reached the model.
    return startInteractiveRun(ctx, AD_HOC_QUESTION_WORKFLOW_KEY, { question: reading.question });
}
