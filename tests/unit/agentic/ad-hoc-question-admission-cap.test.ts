/**
 * The ad-hoc question's length cap holds at ADMISSION, for every door (#5304).
 *
 * `readAdHocQuestion` enforced it only on the Ask page's usecase. The generic
 * start route (`POST /agent-runs`) admitted the same key, and a question posted
 * there reached the model uncapped — the context and cost lever the cap was
 * declared to close. `startWorkflowRun` asks the definition's `validateInput`
 * for every caller, before the run row exists, so the cap lives there too.
 */
import { assertRequiredInputPresent } from '@/app-layer/usecases/workflow-runs';
import { resolveRunDefinition } from '@/app-layer/usecases/agent-profile-runs';
import { readAdHocQuestion } from '@/lib/agentic/ad-hoc-question-input';
import { getWorkflowDefinition } from '@/lib/agentic/workflow-registry';
import {
    AD_HOC_QUESTION_MAX_CHARS,
    adHocQuestionWorkflow,
} from '@/lib/agentic/workflows/ad-hoc-question';
import { makeRequestContext } from '../../helpers/make-context';

describe('admission holds the ad-hoc question to its cap', () => {
    it('is the registered definition admission resolves', () => {
        expect(getWorkflowDefinition('ad-hoc-question')).toBe(adHocQuestionWorkflow);
    });

    it('refuses a question one character over the cap, before any run exists', () => {
        const question = 'x'.repeat(AD_HOC_QUESTION_MAX_CHARS + 1);
        expect(() => assertRequiredInputPresent(adHocQuestionWorkflow, { question })).toThrow(
            /cannot read its input: question is 2001 characters; the limit is 2000/,
        );
    });

    it('refuses a pasted document', () => {
        const question = 'lorem ipsum '.repeat(5_000);
        expect(() => assertRequiredInputPresent(adHocQuestionWorkflow, { question })).toThrow(/the limit is 2000/);
    });

    it('admits a question at the cap', () => {
        const question = 'x'.repeat(AD_HOC_QUESTION_MAX_CHARS);
        expect(() => assertRequiredInputPresent(adHocQuestionWorkflow, { question })).not.toThrow();
    });

    it('admits whatever the Ask page sends: its sanitised question is never over the cap', () => {
        const reading = readAdHocQuestion(`<b>${'q'.repeat(AD_HOC_QUESTION_MAX_CHARS - 7)}</b>`);
        expect(reading.ok).toBe(true);
        if (!reading.ok) return;
        expect(() => assertRequiredInputPresent(adHocQuestionWorkflow, { question: reading.question })).not.toThrow();
    });
});

/**
 * …and the generic start route refuses it outright (#5304, owner decision
 * 2026-11-14). The cap above holds for every door, but the questions route is
 * also where the question is sanitised and the asker rate-limited, and the
 * generic route does neither. Decided by the start path, the pattern a
 * profile's Test-run key uses (`PROFILE_TEST_RUN_KEY`), rather than a check on
 * the URL: the generic route names no trigger and is no A2A delivery. The
 * paths that already started it keep starting it — ASK (`startInteractiveRun`),
 * AUTOMATION, and an A2A delivery — and any other is refused.
 */
describe('the ad-hoc question starts from the questions route only', () => {
    const ctx = makeRequestContext('OWNER');

    const reasonOf = async (p: Promise<unknown>) => {
        try {
            await p;
            return 'RESOLVED';
        } catch (err) {
            return (err as { details?: { reason?: string } }).details?.reason ?? String(err);
        }
    };

    it('the generic start (no trigger) is refused AD_HOC_QUESTION_USE_QUESTIONS_ROUTE', async () => {
        expect(await reasonOf(resolveRunDefinition(ctx, 'ad-hoc-question'))).toBe(
            'AD_HOC_QUESTION_USE_QUESTIONS_ROUTE',
        );
    });

    it('a path outside the allowlist (the TEST_RUN trigger) is refused the same way', async () => {
        expect(await reasonOf(resolveRunDefinition(ctx, 'ad-hoc-question', { trigger: 'TEST_RUN' }))).toBe(
            'AD_HOC_QUESTION_USE_QUESTIONS_ROUTE',
        );
    });

    it('the ASK trigger — the questions route, through startInteractiveRun — resolves it', async () => {
        const { def } = await resolveRunDefinition(ctx, 'ad-hoc-question', { trigger: 'ASK' });
        expect(def).toBe(adHocQuestionWorkflow);
    });

    it('an automation rule (the AUTOMATION trigger) still resolves it, as before', async () => {
        const { def } = await resolveRunDefinition(ctx, 'ad-hoc-question', { trigger: 'AUTOMATION' });
        expect(def).toBe(adHocQuestionWorkflow);
    });

    it('an A2A delivery (no trigger, ctx.a2aInbound set) still resolves it, as before', async () => {
        const a2aCtx = {
            ...ctx,
            a2aInbound: { kind: 'HOST_CONSUMER' as const, hostConsumerId: 'hc-1', messageId: 'm-1' },
        };
        const { def } = await resolveRunDefinition(a2aCtx, 'ad-hoc-question');
        expect(def).toBe(adHocQuestionWorkflow);
    });

    it('another registered workflow still resolves with no trigger, as before', async () => {
        expect(await reasonOf(resolveRunDefinition(ctx, 'posture-review'))).toBe('RESOLVED');
    });
});
