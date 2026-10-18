/**
 * Canned workflow — "Agent recertification pack" (step 3a, #3674).
 *
 * Prepares the reviewer packs of one page of an AGENT access review. One READ
 * step and one SYNTHESIS step, and nothing else: no PROPOSE step, no
 * checkpoint. The read is `get_agent_recertification_evidence`, which reads
 * stored rows only; the synthesis is `planAgentReviewPacks`, a pure function
 * that plans each pack and the narrowings its evidence supports. It hashes
 * nothing: the workflow registry is reachable from a client component, so
 * nothing here may need `node:crypto`, and the usecase hashes each pack's
 * sections as it stores them. The run writes no record of the campaign — `prepareAgentReviewPacks` reads this run's
 * recorded steps, re-derives the plan from the READ step's output, and only
 * then writes the packs and narrowings.
 *
 * Input: { accessReviewId, page, subject } — `page` as a decimal string,
 * because run input admission validates strings (see `requiredInput`); `subject`
 * is `*` for every subject but the running agent's own, or one agent's id for
 * the preparer's own pack, read by the cross-preparer or by a person. One run
 * covers `PACK_PAGE_SIZE` agents, so
 * its context stays inside `MAX_CONTEXT_BYTES` whatever the campaign's size.
 *
 * It runs AS A REGISTERED AGENT — the campaign's preparer or cross-preparer —
 * so its one read goes through the funnel with that agent's grants, card and
 * autonomy terms; the admin who asked only started it. The one exception is
 * the preparer's own pack in a campaign that names no cross-preparer: the
 * person who asked runs it with no agent bound, for that subject only.
 */
import type { WorkflowContext, WorkflowDefinition } from '../workflow-types';
import {
    AGENT_RECERTIFICATION_EVIDENCE_TOOL,
    PACK_SUBJECT_ALL_BUT_SELF,
    planAgentReviewPacks,
} from '../agent-recertification';
import { requiredString } from './required-input';

/** The page, as the integer the read tool takes. */
function pageOf(ctx: WorkflowContext): number {
    const raw = requiredString(ctx, 'page');
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n)) {
        throw new Error(`Workflow input "page" must be a non-negative integer, got "${raw}"`);
    }
    return n;
}

export const agentRecertificationPackWorkflow: WorkflowDefinition = {
    /** Refused at admission without them — see `requiredInput` on the type. */
    requiredInput: ['accessReviewId', 'page', 'subject'],
    // A literal, as every definition names itself (the canned-workflow guard
    // pairs a definition with its source by it); the constant the campaign
    // usecase starts the run by must equal it, which the write-seam guard
    // proves by looking the definition up through the constant.
    key: 'agent-recertification-pack',
    name: 'Agent recertification pack',
    description:
        'Assemble the reviewer pack for each registered agent in one page of an agent ' +
        'access review — grants, observed use, proposals, card history, time-bounded ' +
        'grants, guard flags, breaker trips, kills and harness level — and plan the ' +
        'narrowing the evidence supports. Reads only.',
    steps: [
        {
            kind: 'READ',
            label: 'evidence',
            tool: AGENT_RECERTIFICATION_EVIDENCE_TOOL,
            args: (ctx) => {
                const subject = requiredString(ctx, 'subject');
                return {
                    accessReviewId: requiredString(ctx, 'accessReviewId'),
                    page: pageOf(ctx),
                    ...(subject === PACK_SUBJECT_ALL_BUT_SELF ? {} : { onlyAgentId: subject }),
                };
            },
        },
        {
            kind: 'SYNTHESIS',
            label: 'packs',
            synthesize: (ctx) => {
                const plan = planAgentReviewPacks(ctx.outputs['evidence']);
                const narrowings = plan.packs.reduce((n, p) => n + p.narrowings.length, 0);
                return {
                    text:
                        `Prepared ${plan.packs.length} reviewer pack(s) for page ${plan.page}; ` +
                        `${narrowings} narrowing(s) proposed.`,
                    data: plan,
                };
            },
        },
    ],
};
