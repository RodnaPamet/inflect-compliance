/**
 * ASKING THE QUESTION (#3869) — the write path's two properties.
 *
 * The usecase is four lines, so what is worth testing is not its arithmetic but
 * the two decisions it encodes:
 *
 *   1. The SANITISED text reaches the run, never the raw value. Two readers of
 *      one untrusted input eventually disagree, and the one that matters is
 *      whichever reached the model.
 *   2. A malformed question is refused BEFORE the agent is resolved — so the
 *      caller-fixable case costs nothing, and a flood of bad input cannot drive
 *      load onto the register.
 *
 * The second is an ORDERING property and is asserted the only way ordering can
 * be: by showing the expensive step was never reached.
 */
import { makeRequestContext } from '../../helpers/make-context';
import { AD_HOC_QUESTION_MAX_CHARS } from '@/lib/agentic/workflows/ad-hoc-question';

const started: Array<{ workflowKey: string; input: Record<string, unknown> }> = [];
let startThrows: Error | null = null;

jest.mock('@/app-layer/usecases/interactive-agent-runs', () => ({
    startInteractiveRun: jest.fn(async (_ctx: unknown, workflowKey: string, input: Record<string, unknown>) => {
        started.push({ workflowKey, input });
        if (startThrows) throw startThrows;
        return { runId: 'run-new' };
    }),
}));

import { askAdHocQuestion } from '@/app-layer/usecases/ad-hoc-question';

const ctx = () => makeRequestContext('READER', { tenantId: 'tenant-ask', userId: 'user-asker' });

beforeEach(() => {
    started.length = 0;
    startThrows = null;
});

describe('the SANITISED question reaches the run, never the raw value', () => {
    it('starts the ad-hoc-question workflow with the stripped text', async () => {
        const out = await askAdHocQuestion(ctx(), '<b>Which</b> controls are overdue?');
        expect(out).toEqual({ runId: 'run-new' });
        expect(started).toHaveLength(1);
        expect(started[0].workflowKey).toBe('ad-hoc-question');

        const question = started[0].input.question as string;
        expect(question).toContain('Which');
        expect(question).toContain('overdue');
        // THE PROPERTY. If the raw value were passed through, the model would
        // meet markup the sanitiser was supposed to have removed — and the
        // sanitising would be decoration rather than a control.
        expect(question).not.toContain('<b>');
        expect(JSON.stringify(started[0].input)).not.toContain('<b>');
    });

    it('passes the declared input key, so admission can refuse a missing one', async () => {
        // `requiredInput: ['question']` is refused at admission when absent or
        // blank. Sending it under any other key would make that refusal fire on
        // every legitimate ask.
        await askAdHocQuestion(ctx(), 'Which risks are untreated?');
        expect(Object.keys(started[0].input)).toEqual(['question']);
    });
});

describe('a malformed question is refused BEFORE the agent is resolved', () => {
    it.each([
        ['too long', 'a'.repeat(AD_HOC_QUESTION_MAX_CHARS + 1), 'QUESTION_TOO_LONG'],
        ['not text', 42, 'QUESTION_NOT_TEXT'],
        ['empty', '   ', 'QUESTION_EMPTY'],
        ['only markup', '<span></span>', 'QUESTION_NOT_READABLE'],
    ])('refuses %s with its named code', async (_label, raw, code) => {
        await expect(askAdHocQuestion(ctx(), raw)).rejects.toThrow(new RegExp(code));
        // THE ORDERING ASSERTION: the expensive step was never reached. Four
        // database reads and a kill-switch check are what resolving the agent
        // costs, and a caller sending rubbish must not be able to spend them.
        expect(started).toEqual([]);
    });
});

describe('the two refusal families are told apart by status', () => {
    it('a bad QUESTION is a 400 — the caller fixes it by sending something else', async () => {
        // `status`, not `statusCode`: AppError carries `code` and `status`, and
        // asserting an absent property would have passed vacuously against
        // `undefined` in a looser matcher.
        await expect(askAdHocQuestion(ctx(), '')).rejects.toMatchObject({ status: 400, code: 'BAD_REQUEST' });
    });

    it('the monthly BUDGET refusal reaches the caller with its named reason', async () => {
        // #3869 asks for this by name. The budget is enforced by
        // `assertWithinMonthlyBudget`, which `startWorkflowRun` pre-flights
        // before any row exists — so the refusal arrives here as a thrown
        // `forbidden` carrying both numbers, and the only thing this usecase
        // can get wrong is swallowing it or flattening it into its own message.
        //
        // Asserted on the TEXT reaching the caller rather than on the mechanism:
        // the mechanism has its own suite (`agent-monthly-budget`), and
        // re-testing it through two extra layers would measure the double.
        const { forbidden } = await import('@/lib/errors/types');
        startThrows = forbidden(
            'agent_monthly_token_budget_exceeded: this workspace has used 1,000,000 of its ' +
                '1,000,000 token budget for October.',
        );
        await expect(askAdHocQuestion(ctx(), 'A real question?')).rejects.toThrow(
            /agent_monthly_token_budget_exceeded/,
        );
        // Both numbers survive. A refusal that says "budget exceeded" without
        // them leaves an operator unable to tell a tenant near its ceiling from
        // one whose budget was set to zero by mistake.
        await expect(askAdHocQuestion(ctx(), 'A real question?')).rejects.toThrow(/1,000,000 of its/);
    });

    it("a bad CALLER keeps the starter's 403, which this usecase does not rewrite", async () => {
        // Authority refusals belong to `startInteractiveRun` and reach the
        // client unchanged, carrying their code. Collapsing the families would
        // leave a client unable to tell "ask a shorter question" from "an
        // administrator must designate an agent".
        const { forbidden } = await import('@/lib/errors/types');
        startThrows = forbidden('NO_AGENT_DESIGNATED: this workspace has designated no interactive agent.');
        await expect(askAdHocQuestion(ctx(), 'A real question?')).rejects.toMatchObject({ status: 403 });
        await expect(askAdHocQuestion(ctx(), 'A real question?')).rejects.toThrow(/NO_AGENT_DESIGNATED/);
    });
});
