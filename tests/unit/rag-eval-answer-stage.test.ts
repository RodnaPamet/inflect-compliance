/**
 * The Ragas answer stage's pure parts (Ragas Phase 1.2's answer half,
 * `docs/ai-architecture/ragas.md`; `scripts/rag-eval/answer.ts`).
 *
 *   • The evaluation's mount decision: answered by the gate's reader inside
 *     its scope and nowhere else, and refused at both ends by a production
 *     process.
 *   • A `search_knowledge` result read as the model saw it: whole, cut at the
 *     loop's byte bound (the whole hits kept), an error, unavailable.
 *   • The provider the stage hands the loop: the share's model only, the
 *     proxy's 402 told from any other failure, contexts in call order and
 *     de-duplicated, usage null when a turn reported none.
 *   • The answers file: what the judge reads, held to the contract fixture.
 *
 * The in-process path end to end, on a real database, is
 * `tests/integration/rag-eval-answer-stage.test.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';

import { buildProvenanceEnvelope } from '@/lib/agentic/content-provenance';
import { boundResult, type ProviderRequest, type ProviderTurn } from '@/app-layer/ai/assistant/tool-loop';
import { getKnowledgeSearchMount } from '@/app-layer/services/knowledge-search-mount';
import { knowledgeRetrieverRevision } from '@/app-layer/services/knowledge-search-revision';
import {
    ragEvaluationMountInScope,
    withRagEvaluationMount,
    RagEvaluationMountRefused,
    type RagEvaluationMount,
} from '@/app-layer/services/rag-evaluation-mount';
import { RagAnswersFileSchema, RagAnswerResponseSchema } from '@/lib/ai/evals/rag-answer-contract';
import { AnswerStageError, CapturingTurnProvider, readSearchResult } from '../../scripts/rag-eval/answer';

const ROOT = path.resolve(__dirname, '../..');
const CONTRACT = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/rag/fixtures/answer-contract.json'), 'utf-8'));
const REVISION = knowledgeRetrieverRevision({ model: 'intfloat/multilingual-e5-small', dimensions: 384 });
const MOUNT: RagEvaluationMount = {
    state: 'MOUNTED',
    revision: REVISION,
    evaluation: { tenantId: 'tenant-answer', setHash: `sha256:${'a'.repeat(64)}` },
};

/** A `search_knowledge` result exactly as `runReadTool` + `runGuardedTool` hand it to the loop. */
function toolText(payload: unknown): string {
    return [JSON.stringify(payload, null, 2), JSON.stringify(buildProvenanceEnvelope('search_knowledge'), null, 2)].join('\n');
}

const hit = (i: number, text = `Passage ${i} says "quoted" things, with a brace } and a bracket ].`) => ({
    sourceModel: 'PolicyVersion',
    sourceId: `version-${i}`,
    chunkIndex: i,
    score: 0.9 - i / 100,
    text,
    citation: { kind: 'policy', id: `policy-${i}`, title: `Policy ${i}` },
});

describe('the evaluation mount answers inside its scope and nowhere else', () => {
    const before = process.env.NODE_ENV;
    afterEach(() => {
        (process.env as Record<string, string | undefined>).NODE_ENV = before;
    });

    it('the gate gives the scope’s decision inside the call and its own outside it', async () => {
        const outside = getKnowledgeSearchMount();
        expect('evaluation' in outside).toBe(false);
        const inside = await withRagEvaluationMount(MOUNT, async () => {
            await new Promise((r) => setTimeout(r, 1));
            return getKnowledgeSearchMount();
        });
        expect(inside).toBe(MOUNT);
        expect(ragEvaluationMountInScope()).toBeUndefined();
        expect(getKnowledgeSearchMount()).toBe(outside);
    });

    it('a production process refuses to open the scope, and ignores one already open', async () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
        await expect(withRagEvaluationMount(MOUNT, async () => 1)).rejects.toBeInstanceOf(RagEvaluationMountRefused);
        (process.env as Record<string, string | undefined>).NODE_ENV = before;
        const seen = await withRagEvaluationMount(MOUNT, async () => {
            (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
            const r = { reader: ragEvaluationMountInScope(), gate: getKnowledgeSearchMount().state };
            (process.env as Record<string, string | undefined>).NODE_ENV = before;
            return r;
        });
        expect(seen.reader).toBeUndefined();
        expect(seen.gate).not.toBe('MOUNTED');
    });

    it('refuses a decision that names no tenant', async () => {
        const bad = { ...MOUNT, evaluation: { ...MOUNT.evaluation, tenantId: '' } };
        await expect(withRagEvaluationMount(bad, async () => 1)).rejects.toBeInstanceOf(RagEvaluationMountRefused);
    });
});

describe('a search_knowledge result as the model saw it', () => {
    const payload = { available: true, embeddingModel: REVISION.embeddingModel, hits: [hit(0), hit(1), hit(2)], droppedStale: 0 };

    it('reads a whole result: every hit, its key and its text as returned', () => {
        const r = readSearchResult(toolText(payload));
        expect(r).toMatchObject({ available: true, embeddingModel: REVISION.embeddingModel, truncated: false });
        expect(r.hits).toEqual(payload.hits.map((h) => ({ sourceModel: h.sourceModel, sourceId: h.sourceId, chunkIndex: h.chunkIndex, text: h.text })));
    });

    it('a result the loop cut keeps the hits the model saw whole, and drops the one the cut went through', () => {
        const full = toolText(payload);
        const third = full.indexOf('"sourceId": "version-2"');
        const cut = boundResult(full, Buffer.byteLength(full.slice(0, third + 10)));
        expect(cut.truncated).toBe(true);
        const r = readSearchResult(cut.content);
        expect(r.truncated).toBe(true);
        expect(r.hits.map((h) => h.sourceId)).toEqual(['version-0', 'version-1']);
    });

    it('an error, an unreadable result and an unavailable search are each said as such', () => {
        expect(() => readSearchResult('ERROR: this data could not be read: boom')).toThrow(AnswerStageError);
        expect(() => readSearchResult('not json')).toThrow(/TOOL_RESULT_UNREADABLE/);
        expect(() => readSearchResult('{ "available": tr')).toThrow(/no truncation note/);
        expect(readSearchResult(toolText({ available: false, reason: 'NOT_EVALUATED' }))).toMatchObject({ available: false, reason: 'NOT_EVALUATED', hits: [] });
    });
});

describe('the provider the stage hands the loop', () => {
    const turn = (over: Partial<ProviderTurn> = {}): ProviderTurn => ({ text: 'ok', toolCalls: [], stopReason: 'end', usage: { tokensIn: 100, tokensOut: 10 }, ...over });
    const req = (history: ProviderRequest['history'] = [], model = 'claude-haiku-4-5'): ProviderRequest => ({
        specifier: `inflect-external/${model}`,
        system: 's',
        question: 'q',
        history,
        tools: [],
    });
    const searched = (id: string, hits: unknown[]): ProviderRequest['history'] => [
        { role: 'assistant', text: null, toolCalls: [{ id, name: 'search_knowledge', args: { query: 'q' } }] },
        { role: 'tool', id, name: 'search_knowledge', content: toolText({ available: true, embeddingModel: REVISION.embeddingModel, hits, droppedStale: 0 }) },
    ];

    it('collects the contexts in call order, once each, and sums the usage', async () => {
        const inner = { complete: jest.fn(async () => turn()) };
        const p = new CapturingTurnProvider(inner, 'claude-haiku-4-5', REVISION.embeddingModel);
        await p.complete(req());
        const first = searched('t1', [hit(1), hit(0)]);
        await p.complete(req(first));
        await p.complete(req([...first, ...searched('t2', [hit(0), hit(2)])]));
        expect(p.contexts.map((c) => c.sourceId)).toEqual(['version-1', 'version-0', 'version-2']);
        expect(p.calls).toBe(3);
        expect(p.usageReported).toEqual({ inputTokens: 300, outputTokens: 30 });
    });

    it('a turn with no usage makes the answer’s usage unknown, never a smaller number', async () => {
        const inner = { complete: jest.fn().mockResolvedValueOnce(turn()).mockResolvedValueOnce(turn({ usage: undefined })) };
        const p = new CapturingTurnProvider(inner, 'claude-haiku-4-5', REVISION.embeddingModel);
        await p.complete(req());
        await p.complete(req());
        expect(p.usageReported).toBeNull();
    });

    it('tells the proxy’s budget refusal from any other failure', async () => {
        const budget = new CapturingTurnProvider(
            { complete: async () => Promise.reject(new Error('Anthropic API error 402: {"type":"error","error":{"type":"budget_exhausted"}}')) },
            'claude-haiku-4-5',
            REVISION.embeddingModel,
        );
        await expect(budget.complete(req())).rejects.toThrow(/402/);
        expect(budget.budgetExhausted).toBe(true);
        expect(budget.failure).toBeNull();
        const down = new CapturingTurnProvider({ complete: async () => Promise.reject(new Error('Anthropic API error 529: overloaded')) }, 'claude-haiku-4-5', REVISION.embeddingModel);
        await expect(down.complete(req())).rejects.toThrow(/529/);
        expect(down.budgetExhausted).toBe(false);
        expect(down.failure).toMatchObject({ reason: 'PROVIDER_FAILED', retryable: true });
    });

    it('refuses a turn for a model the share does not price, before it is sent', async () => {
        const inner = { complete: jest.fn(async () => turn()) };
        const p = new CapturingTurnProvider(inner, 'claude-haiku-4-5', REVISION.embeddingModel);
        await expect(p.complete(req([], 'claude-sonnet-5-5'))).rejects.toThrow(/MODEL_NOT_THE_SHARES/);
        expect(inner.complete).not.toHaveBeenCalled();
    });

    it('refuses an unavailable search, and one answered under another embedding model', async () => {
        const unavailable = new CapturingTurnProvider({ complete: async () => turn() }, 'claude-haiku-4-5', REVISION.embeddingModel);
        const h: ProviderRequest['history'] = [
            { role: 'assistant', text: null, toolCalls: [{ id: 'x', name: 'search_knowledge', args: {} }] },
            { role: 'tool', id: 'x', name: 'search_knowledge', content: toolText({ available: false, reason: 'NOT_EVALUATED' }) },
        ];
        await expect(unavailable.complete(req(h))).rejects.toThrow(/SEARCH_UNAVAILABLE/);
        expect(unavailable.failure?.retryable).toBe(false);
        const other = new CapturingTurnProvider({ complete: async () => turn() }, 'claude-haiku-4-5', 'another-model');
        await expect(other.complete(req(searched('y', [hit(0)])))).rejects.toThrow(/SEARCH_OTHER_REVISION/);
    });
});

describe('the answers file the judge reads', () => {
    const response = CONTRACT.accepted[0];
    const file = {
        contract: 'rag-answers@1',
        setHash: `sha256:${'b'.repeat(64)}`,
        retrieverRevision: REVISION,
        status: 'COMPLETE',
        answers: [{ caseId: 'am-01', question: 'q?', response }],
        unanswered: [],
    };

    it('accepts the contract fixture’s examples and refuses its counter-examples', () => {
        for (const ok of CONTRACT.answersFile.accepted) expect(RagAnswersFileSchema.safeParse(ok).success).toBe(true);
        for (const bad of CONTRACT.answersFile.refused) expect([bad.why, RagAnswersFileSchema.safeParse(bad.body).success]).toEqual([bad.why, false]);
        for (const ok of CONTRACT.accepted) expect(RagAnswerResponseSchema.safeParse(ok).success).toBe(true);
    });

    it('a COMPLETE file leaves nothing unanswered; a BUDGET_EXHAUSTED one names what it did not answer', () => {
        expect(RagAnswersFileSchema.safeParse(file).success).toBe(true);
        expect(RagAnswersFileSchema.safeParse({ ...file, unanswered: ['am-02'] }).success).toBe(false);
        expect(RagAnswersFileSchema.safeParse({ ...file, status: 'BUDGET_EXHAUSTED' }).success).toBe(false);
        expect(RagAnswersFileSchema.safeParse({ ...file, status: 'BUDGET_EXHAUSTED', unanswered: ['am-02'] }).success).toBe(true);
        expect(RagAnswersFileSchema.safeParse({ ...file, status: 'BUDGET_EXHAUSTED', unanswered: ['am-01'] }).success).toBe(false);
        expect(RagAnswersFileSchema.safeParse({ ...file, passRate: 1 }).success).toBe(false);
    });
});
