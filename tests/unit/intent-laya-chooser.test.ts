/**
 * The Laya-backed chooser's wire mapping (#3351).
 *
 * The thing most likely to be wrong here is WHICH LABEL STANDS FOR WHICH
 * OPTION, and the consequence of getting it wrong is a grant composed for the
 * wrong subject — so that mapping is tested in both directions, and an answer
 * naming a label we never offered is required to THROW rather than resolve to
 * whatever sits at that position.
 *
 * What is NOT tested here, and cannot be without a deployment: whether a real
 * Laya accepts this state shape and question id. #3311 is the standard for
 * that kind of claim and the module says so in its own header.
 */
import {
    buildIntentChoiceRequest,
    readIntentChoiceAnswer,
    createLayaIntentChooser,
    INTENT_OPTION_LABELS,
    INTENT_QUESTION_ID,
    MAX_INTENT_OPTIONS,
} from '@/app-layer/ai/intent/laya-chooser';
import type { IntentChoice } from '@/app-layer/ai/intent/grant-intent';

const CHOICE: IntentChoice = {
    question: 'Which approved template does this instruction mean?',
    phrase: 'give Ada access to the finance package until Friday',
    options: [
        { id: 'set-fin', label: 'Finance package, 30 days' },
        { id: 'set-eng', label: 'Engineering package' },
    ],
};

/**
 * The answer shape a REAL Laya returns, captured from one on 2026-10-10
 * (#3394). Every key was observed, not assumed:
 *
 *   answers.intent_choice = { type, choice, probabilities, confidence,
 *                             answer_confidence, action, x_jev_confidence }
 *   usage                 = { input_tokens, output_tokens, state_tokens, … }
 *
 * The answer field is `choice`, and `usage` is snake_case. This fixture said
 * `option` and `inputTokens` — which is how the module shipped against an
 * invented contract: an injected transport echoes back whatever shape the test
 * imagines, so the suite was green and the first real request would have
 * thrown.
 */
const answerBody = (choice: string) => ({
    model: 'laya-rl-agent',
    answers: {
        [INTENT_QUESTION_ID]: {
            type: 'choice',
            choice,
            probabilities: { [choice]: 0.5587, NONE: 0.4312 },
            confidence: 0.4659,
            answer_confidence: 0.5587,
            action: { act_probability: 1.0 },
            x_jev_confidence: 0.4116,
        },
    },
    usage: { input_tokens: 92, output_tokens: 0, state_tokens: 12 },
    routing: {},
});

describe('the request carries our options, labelled', () => {
    it('labels options positionally in criteria, and offers NONE', () => {
        // `criteria` as a dict of label -> description, which is what the
        // server's own validator documents. An `options` ARRAY — what this
        // module sent before #3394 — is rejected 422.
        const { body } = buildIntentChoiceRequest('laya-1', CHOICE);
        const q = (body as {
            questions: Record<string, { criteria: Record<string, string>; instructions: string }>;
        }).questions[INTENT_QUESTION_ID];
        expect(Object.keys(q.criteria)).toEqual(['A', 'B', 'NONE']);
        expect(q.criteria.A).toBe('Finance package, 30 days');
        expect(q.criteria.NONE).toMatch(/None of the listed options/);
    });

    it('carries `instructions`, without which the server answers 422', () => {
        // Observed verbatim: "question 'intent_choice': no 'instructions';
        // add the text the model should answer".
        const { body } = buildIntentChoiceRequest('laya-1', CHOICE);
        const q = (body as { questions: Record<string, { instructions?: string }> })
            .questions[INTENT_QUESTION_ID];
        expect(typeof q.instructions).toBe('string');
        expect(q.instructions).toBe(CHOICE.question);
    });

    it('sends the instruction and nothing else about the tenant', () => {
        // The model chooses between descriptions we wrote. It is not given a
        // directory to reason about.
        const { body } = buildIntentChoiceRequest('laya-1', CHOICE);
        const state = (body as { state: Record<string, unknown> }).state;
        expect(state.instruction).toBe(CHOICE.phrase);
        // ONLY the instruction. The question moved to `instructions` on the
        // question itself, which is where the server reads it, and the offered
        // set lives in `criteria` — so state carries nothing but the phrase.
        expect(Object.keys(state).sort()).toEqual(['instruction']);
    });

    it('REFUSES above the label cap rather than truncating', () => {
        // Truncating would make the right answer absent, so the model would
        // either say NONE — a refusal the operator cannot act on, because the
        // template they meant exists — or pick the nearest of the wrong ones.
        const many: IntentChoice = {
            ...CHOICE,
            options: Array.from({ length: MAX_INTENT_OPTIONS + 1 }, (_, i) => ({
                id: `set-${i}`,
                label: `Template ${i}`,
            })),
        };
        expect(() => buildIntentChoiceRequest('laya-1', many)).toThrow(/Refusing rather than truncating/);
    });

    it('fills the cap exactly without complaint', () => {
        const exact: IntentChoice = {
            ...CHOICE,
            options: Array.from({ length: MAX_INTENT_OPTIONS }, (_, i) => ({
                id: `set-${i}`,
                label: `Template ${i}`,
            })),
        };
        const { labelOf } = buildIntentChoiceRequest('laya-1', exact);
        expect(labelOf.size).toBe(MAX_INTENT_OPTIONS);
        expect(labelOf.get(INTENT_OPTION_LABELS[MAX_INTENT_OPTIONS - 1])).toBe(
            `set-${MAX_INTENT_OPTIONS - 1}`,
        );
    });

    it('refuses an empty option set, which is not a question', () => {
        expect(() => buildIntentChoiceRequest('laya-1', { ...CHOICE, options: [] })).toThrow(
            /nothing to ask/,
        );
    });
});

describe('the answer maps back to the option that was offered', () => {
    it('maps each label to its own option, not to a position it guessed', () => {
        const { labelOf } = buildIntentChoiceRequest('laya-1', CHOICE);
        expect(readIntentChoiceAnswer(answerBody('A'), labelOf)).toBe('set-fin');
        expect(readIntentChoiceAnswer(answerBody('B'), labelOf)).toBe('set-eng');
    });

    it('maps NONE to null, which the resolver turns into a refusal', () => {
        const { labelOf } = buildIntentChoiceRequest('laya-1', CHOICE);
        expect(readIntentChoiceAnswer(answerBody('NONE'), labelOf)).toBeNull();
    });

    it('THROWS on a label that was never offered', () => {
        // C is a valid label in the alphabet and was NOT sent for a
        // two-option question. Resolving it to a position would be inventing
        // an answer; the resolver reports model_unreadable instead.
        const { labelOf } = buildIntentChoiceRequest('laya-1', CHOICE);
        expect(() => readIntentChoiceAnswer(answerBody('C'), labelOf)).toThrow(/not offered/);
    });

    it('THROWS on a label outside the alphabet entirely', () => {
        const { labelOf } = buildIntentChoiceRequest('laya-1', CHOICE);
        expect(() => readIntentChoiceAnswer(answerBody('ZZ'), labelOf)).toThrow(/did not parse/);
    });

    it.each([
        ['an empty object', {}],
        ['answers without our question id', { answers: { other: { type: 'choice', choice: 'A' } } }],
        ['the wrong answer type', { answers: { [INTENT_QUESTION_ID]: { type: 'noul', probability: 1 } } }],
        ['null', null],
    ])('THROWS on %s rather than returning something', (_label, raw) => {
        const { labelOf } = buildIntentChoiceRequest('laya-1', CHOICE);
        expect(() => readIntentChoiceAnswer(raw, labelOf)).toThrow(/did not parse/);
    });
});

describe('the chooser end to end, against an injected transport', () => {
    const okResponse = (option: string) =>
        new Response(JSON.stringify(answerBody(option)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });

    it('posts to /v1/systemone and returns the chosen option id', async () => {
        const calls: Array<{ url: string; body: unknown; auth?: string }> = [];
        const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
            calls.push({
                url: String(url),
                body: JSON.parse(String(init?.body ?? '{}')),
                auth: new Headers(init?.headers).get('authorization') ?? undefined,
            });
            return okResponse('B');
        }) as unknown as typeof fetch;

        const chooser = createLayaIntentChooser({
            baseUrl: 'http://laya.internal:8080/',
            apiKey: 'k',
            model: 'laya-1',
            deadlineAt: Date.now() + 10_000,
            fetchImpl,
        });
        await expect(chooser.choose(CHOICE)).resolves.toBe('set-eng');
        expect(calls).toHaveLength(1);
        // The trailing slash on baseUrl must not produce a double slash.
        expect(calls[0].url).toBe('http://laya.internal:8080/v1/systemone');
        expect(calls[0].auth).toBe('Bearer k');
    });

    it('omits the Authorization header when no key is configured', async () => {
        // LAYA_API_KEY is optional on purpose: most Laya servers sit behind a
        // network boundary rather than an auth header, and sending `Bearer
        // undefined` would be worse than sending nothing.
        let auth: string | null = 'unset';
        const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
            auth = new Headers(init?.headers).get('authorization');
            return okResponse('A');
        }) as unknown as typeof fetch;

        const chooser = createLayaIntentChooser({
            baseUrl: 'http://laya.internal:8080',
            model: 'laya-1',
            deadlineAt: Date.now() + 10_000,
            fetchImpl,
        });
        await chooser.choose(CHOICE);
        expect(auth).toBeNull();
    });
});
