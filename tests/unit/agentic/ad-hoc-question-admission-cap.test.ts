/**
 * The ad-hoc question's length cap holds at ADMISSION, for every door (#5304).
 *
 * `readAdHocQuestion` enforced it only on the Ask page's usecase. The generic
 * start route (`POST /agent-runs`) admits the same key, and a question posted
 * there reached the model uncapped — the context and cost lever the cap was
 * declared to close. `startWorkflowRun` asks the definition's `validateInput`
 * for every caller, before the run row exists, so the cap lives there too.
 */
import { assertRequiredInputPresent } from '@/app-layer/usecases/workflow-runs';
import { readAdHocQuestion } from '@/lib/agentic/ad-hoc-question-input';
import { getWorkflowDefinition } from '@/lib/agentic/workflow-registry';
import {
    AD_HOC_QUESTION_MAX_CHARS,
    adHocQuestionWorkflow,
} from '@/lib/agentic/workflows/ad-hoc-question';

describe('admission holds the ad-hoc question to its cap', () => {
    it('is the registered definition the generic route resolves', () => {
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
