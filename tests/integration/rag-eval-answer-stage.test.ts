/**
 * The Ragas answer stage, in process, on a real database (Ragas Phase 1.2's
 * answer half; `scripts/rag-eval/answer.ts`).
 *
 *   1. The corpus is built through the product (the same stage the nightly
 *      runs), embedded with the deterministic stub in place of TEI.
 *   2. The stage asks every question of the mini set through the REAL
 *      assistant usecase as the owner of the case's tenant — the injection
 *      case in the injection tenant, the rest in the answer tenant (owner
 *      decision 2026-11-17) — with a FAKE model (no network) that calls
 *      `search_knowledge` once, as wide as the tool allows, and then answers:
 *      the tool runs through the real offer, the funnel and `searchKnowledge`
 *      against pgvector under RLS. The answers file is schema-valid, every
 *      context is one of the asking tenant's chunks with the text the tool
 *      returned, and the model was offered the tool only because the stage's
 *      scope mounted it. A task question can no longer retrieve an injected
 *      chunk (the answer tenant holds none), and the injection question still
 *      trips the guard. Every turn named the assistant's own model, resolved
 *      as the deployment resolves it (nothing here sets AGENT_FLUE_MODEL), and
 *      the file names it.
 *   3. The production ROUTE (`POST /api/t/:slug/assistant/ask`, the real
 *      handler and usecase) is NOT offered `search_knowledge`: there is no
 *      record for this revision, so the gate is UNMOUNTED — not merely absent.
 *   4. Inside the stage's scope, a search for ANY tenant but the one it names
 *      is refused: another corpus tenant, the other harness tenant included.
 *   5. A budget refusal (the proxy's 402) on an answer turn stops answering:
 *      the file says BUDGET_EXHAUSTED, keeps the cases answered before it,
 *      names the rest, and holds no part of the interrupted answer.
 *
 * Three seams, each named: the vector store switch is on, the embedding route
 * is the stub's, and the model is a fake. The quota is the one the workflow
 * sets for the stage, set here before anything loads; the model is left unset.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { NextRequest } from 'next/server';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';
import type { CorpusManifest } from '../../scripts/rag-eval/corpus';
import type { ProviderRequest, ProviderTurn, AssistantTurnProvider } from '@/app-layer/ai/assistant/tool-loop';
import type { RagAnswersFile } from '@/lib/ai/evals/rag-answer-contract';
import type { RequestContext } from '@/app-layer/types';

const DIMS = 384;

jest.mock('@/app-layer/repositories/vector-store-switch', () => ({ vectorStoreEnabled: () => true }));
jest.mock('@/lib/ai/embeddings', () => {
    const actual = jest.requireActual('@/lib/ai/embeddings');
    return {
        ...actual,
        getEmbeddingProvider: () => ({ ok: true, provider: new actual.StubEmbeddingProvider(384) }),
        resolveEmbeddingRoute: () => ({
            ok: true,
            specifier: `inflect-local/${actual.STUB_EMBEDDING_MODEL}`,
            baseUrl: 'http://127.0.0.1:1',
            dimensions: 384,
            queryPrefix: '',
            passagePrefix: '',
        }),
    };
});
/** What the production route's model is handed: recorded, never sent anywhere. */
const routeRequests: ProviderRequest[] = [];
jest.mock('@/app-layer/ai/assistant/turn-provider', () => {
    const actual = jest.requireActual('@/app-layer/ai/assistant/turn-provider');
    return {
        ...actual,
        assistantProviderFor: () => ({
            complete: async (req: ProviderRequest) => {
                routeRequests.push(req);
                return { text: 'You have no open findings.', toolCalls: [], stopReason: 'end', usage: { tokensIn: 10, tokensOut: 5 } };
            },
        }),
    };
});
let routeCtx: RequestContext;
jest.mock('@/app-layer/context', () => ({ getTenantCtx: async () => routeCtx }));

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(300_000);

const ROOT = path.resolve(__dirname, '../..');
const SUITE = `ra${randomUUID().slice(0, 6)}-`;
/** The assistant's own model when the deployment sets none (`src/lib/ai/model-defaults.ts`). */
const ASSISTANT_MODEL = 'claude-sonnet-5-5';
const TEMPLATE_TITLES = ['Access Management Policy', `Distractor library ${SUITE}`];
const templateIds: string[] = [];

/** A fake model: one `search_knowledge` call for the question, as wide as the tool allows, then a fixed answer. */
function fakeModel(opts: { refuseBudgetOnQuestion?: string } = {}): { provider: AssistantTurnProvider; requests: ProviderRequest[] } {
    const requests: ProviderRequest[] = [];
    return {
        requests,
        provider: {
            async complete(req: ProviderRequest): Promise<ProviderTurn> {
                requests.push(req);
                if (opts.refuseBudgetOnQuestion === req.question) {
                    throw new Error('Anthropic API error 402: {"type":"error","error":{"type":"budget_exhausted","message":"the ragas share of USD 2.5 cannot fit this call"}}');
                }
                const tool = req.history.find((h) => h.role === 'tool');
                if (!tool) {
                    return {
                        text: null,
                        // As wide as the tool allows. The answer tenant holds no
                        // injected chunk, so no task question can reach one.
                        toolCalls: [{ id: `toolu_${requests.length}`, name: 'search_knowledge', args: { query: req.question, limit: 20 } }],
                        stopReason: 'tool_use',
                        usage: { tokensIn: 1200, tokensOut: 40 },
                    };
                }
                return { text: 'According to the access management policy, it is required.', toolCalls: [], stopReason: 'end', usage: { tokensIn: 2400, tokensOut: 60 } };
            },
        },
    };
}

describeFn('the Ragas answer stage asks the product, in process, through search_knowledge', () => {
    // Loaded after the stage's environment is set: the rate limiter and the
    // model pin read it when they load.
    let stage: typeof import('../../scripts/rag-eval/answer');
    let manifest: CorpusManifest;
    let set: import('@/lib/ai/evals/rag-record').RagEvaluationSet;
    let retrieval: { kind: string; setHash: string; retrieverRevision: import('@/lib/ai/evals/rag-record').RagEvaluationRecord['retrieverRevision'] };
    let file: RagAnswersFile;
    let model: ReturnType<typeof fakeModel>;
    const meter = { state: async () => ({ job: 'ragas', models: ['claude-haiku-4-5', ASSISTANT_MODEL] }) };
    const env = process.env as Record<string, string | undefined>;
    const saved = { ...env };

    beforeAll(async () => {
        env.ANTHROPIC_API_KEY = 'held-by-the-metering-proxy'; // pragma: allowlist secret -- the marker the answer stage requires in place of a key, never a credential
        // The assistant's model is NOT set: it resolves as the deployment's does.
        delete env.AGENT_FLUE_MODEL;
        env.AI_RISK_DAILY_QUOTA = '100';
        env.AI_RISK_USER_RPM = '100';
        stage = require('../../scripts/rag-eval/answer');
        const { prepareRagEvalCorpus } = require('../../scripts/rag-eval/corpus');
        const { embedderDeps } = require('../../scripts/rag-eval/shared');
        const { checkRagEvaluationSet, ragSetHash } = require('@/lib/ai/evals/rag-record');
        const { knowledgeRetrieverRevision } = require('@/app-layer/services/knowledge-search-revision');
        const { STUB_EMBEDDING_MODEL } = jest.requireActual('@/lib/ai/embeddings');

        const check = checkRagEvaluationSet(JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/rag/fixtures/mini-set.json'), 'utf-8')));
        if (!check.ok) throw new Error(check.detail);
        set = check.set;
        const passages = set.cases.flatMap((c) => c.groundTruth.refs.map((r) => r.passage));
        const prose = Array.from({ length: 40 }, (_, i) => `Requirement ${i} of the operating procedures states that each owner records the review of controls for that period.`).join(' ');
        for (const [title, contentText] of [
            [TEMPLATE_TITLES[0], `# Access Management Policy\n\n${passages.join('\n\n')}`],
            [TEMPLATE_TITLES[1], prose],
        ]) {
            const t = await prisma.policyTemplate.create({ data: { title, contentText, contentType: 'MARKDOWN', source: SUITE } });
            templateIds.push(t.id);
        }
        manifest = await prepareRagEvalCorpus({ set, probeTenantChunks: 20, scaleMultiple: 1, deps: embedderDeps('stub', DIMS), slugPrefix: SUITE });
        retrieval = { kind: 'rag-retrieval-probe@1', setHash: ragSetHash(set), retrieverRevision: knowledgeRetrieverRevision({ model: STUB_EMBEDDING_MODEL, dimensions: DIMS }) };

        model = fakeModel();
        file = await stage.runAnswerStage({ set, manifest, retrieval, proxy: 'http://127.0.0.1:8787', meter, provider: () => model.provider });
    });

    afterAll(async () => {
        const { purgeSoftDeletedTenants } = require('@/app-layer/usecases/tenant-purge');
        const { deleteAuditRowsForTenants } = require('../helpers/audit-cleanup');
        const { hashForLookup } = require('@/lib/security/encryption');
        const tenants = await prisma.tenant.findMany({ where: { slug: { startsWith: SUITE } }, select: { id: true, slug: true } });
        const ids = tenants.map((t) => t.id);
        for (const id of ids) {
            await prisma.tenant.update({ where: { id }, data: { deletedAt: new Date('2026-01-01T00:00:00Z') } });
            await purgeSoftDeletedTenants({ tenantId: id });
        }
        await deleteAuditRowsForTenants(prisma, ids).catch(() => {});
        await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
        const hashes = tenants.flatMap((t) => ['owner', 'approver'].map((who) => hashForLookup(`${who}@${t.slug}.rag-eval.test`)));
        await prisma.user.deleteMany({ where: { emailHash: { in: hashes } } });
        await prisma.policyTemplate.deleteMany({ where: { id: { in: templateIds } } });
        await prisma.$disconnect();
        for (const k of Object.keys(env)) if (!(k in saved)) delete env[k];
        Object.assign(env, saved);
    });

    it('answers every case, in the set’s order, in a schema-valid file bound to the set and the revision', () => {
        const { RagAnswersFileSchema } = require('@/lib/ai/evals/rag-answer-contract');
        expect(RagAnswersFileSchema.safeParse(file).success).toBe(true);
        expect(file.status).toBe('COMPLETE');
        expect(file.answers.map((a) => a.caseId)).toEqual(set.cases.map((c) => c.id));
        expect(file.setHash).toBe(retrieval.setHash);
        expect(file.retrieverRevision).toEqual(retrieval.retrieverRevision);
        for (const a of file.answers) expect(a.response.retriever).toEqual({ embeddingModel: retrieval.retrieverRevision.embeddingModel, k: retrieval.retrieverRevision.k });
        // The file names the model that wrote the answers: the assistant's own.
        expect(file.answerModel).toEqual({ provider: 'anthropic', model: ASSISTANT_MODEL });
    });

    it('builds the injection tenant apart: the answer tenant holds no injected chunk, the injection tenant nothing else', () => {
        expect(manifest.answerTenant.sources.map((s) => s.kind)).not.toContain('injected');
        expect(manifest.injectionTenant.sources.length).toBeGreaterThan(0);
        expect(new Set(manifest.injectionTenant.sources.map((s) => s.kind))).toEqual(new Set(['injected']));
        expect(manifest.injectionTenant.id).not.toBe(manifest.answerTenant.id);
    });

    it('the model was offered search_knowledge, and every turn named the assistant’s own model', () => {
        expect(model.requests.length).toBeGreaterThan(0);
        for (const r of model.requests) {
            expect(r.tools.map((t) => t.name)).toContain('search_knowledge');
            expect(r.specifier).toBe(`inflect-external/${ASSISTANT_MODEL}`);
        }
    });

    it('every context of a case asked in the answer tenant is one of its chunks, with the text the tool returned', async () => {
        const sources = new Set(manifest.answerTenant.sources.map((s) => s.sourceId));
        const task = file.answers.find((a) => a.caseId === 'am-mfa-factors')!;
        expect(task.response.retrieved.length).toBeGreaterThan(0);
        expect(task.response.answer).toBe('According to the access management policy, it is required.');
        const injectionIds = new Set(set.cases.filter((c) => c.kind === 'injection').map((c) => c.id));
        const all = file.answers.filter((a) => !injectionIds.has(a.caseId)).flatMap((a) => a.response.retrieved);
        for (const r of all) expect(sources.has(r.sourceId)).toBe(true);
        const { runInTenantContext } = require('@/lib/db/rls-middleware');
        const { makeRequestContext } = require('../helpers/make-context');
        const ctx = makeRequestContext('OWNER', { tenantId: manifest.answerTenant.id });
        const { KnowledgeChunkRepository } = require('@/app-layer/repositories/KnowledgeChunkRepository');
        const chunks: Array<{ sourceId: string; chunkIndex: number; text: string }> = await runInTenantContext(ctx, (db: unknown) =>
            KnowledgeChunkRepository.findByKeys(db, ctx, all.map((r) => ({ sourceModel: r.sourceModel, sourceId: r.sourceId, chunkIndex: r.chunkIndex }))),
        );
        const textOf = new Map(chunks.map((c) => [`${c.sourceId}:${c.chunkIndex}`, c.text]));
        for (const r of all) expect(r.text).toBe(textOf.get(`${r.sourceId}:${r.chunkIndex}`));
        // The ground truth is among what was retrieved for the task question.
        const truth = set.cases.find((c) => c.id === 'am-mfa-factors')!.groundTruth.refs[0].passage;
        expect(task.response.retrieved.some((r) => r.text.includes(truth))).toBe(true);
        // Usage is what the model's turns reported, summed.
        expect(task.response.usage).toEqual({ inputTokens: 3600, outputTokens: 100 });
    });

    it('a task question can no longer retrieve an injected chunk: no answer outside the injection case halts or carries one', () => {
        const injectedTexts = set.cases.flatMap((c) => (c.injected ? [c.injected.text] : []));
        expect(injectedTexts.length).toBeGreaterThan(0);
        for (const a of file.answers.filter((x) => x.caseId !== 'inj-mfa-override')) {
            expect(a.response.answer).not.toMatch(/^I stopped/);
            for (const r of a.response.retrieved) for (const t of injectedTexts) expect(r.text).not.toContain(t.slice(0, 60));
        }
        // The task question on the injection case's subject asked the widest
        // search the tool allows, got every chunk the answer tenant holds, and
        // still met no injected chunk.
        const task = file.answers.find((a) => a.caseId === 'am-mfa-factors')!;
        expect(task.response.retrieved.length).toBe(manifest.answerTenant.sources.reduce((n, s) => n + s.chunks, 0));
    });

    it('an injection question, asked in the injection tenant, still trips the guard: the product’s halt, with no context the model never saw', () => {
        const injected = file.answers.find((a) => a.caseId === 'inj-mfa-override')!;
        expect(injected.response.answer).toMatch(/^I stopped: the content guard flagged something/);
        expect(injected.response.retrieved).toEqual([]);
        // It was asked as the injection tenant's owner, never the answer tenant's.
        expect(model.requests.some((r) => r.question === set.cases.find((c) => c.id === 'inj-mfa-override')!.question)).toBe(true);
    });

    it('the production route is not offered search_knowledge: no record, so the gate is UNMOUNTED', async () => {
        const { getKnowledgeSearchMount } = require('@/app-layer/services/knowledge-search-mount');
        const { resolveMemberContextWithReason } = require('@/app-layer/context-system');
        const { hashForLookup } = require('@/lib/security/encryption');
        const mount = getKnowledgeSearchMount();
        expect(mount).toMatchObject({ state: 'UNMOUNTED', reason: 'NO_RECORD' });
        const approver = await prisma.user.findUniqueOrThrow({ where: { emailHash: hashForLookup(`approver@${manifest.answerTenant.slug}.rag-eval.test`) } });
        const resolved = await resolveMemberContextWithReason({ tenantId: manifest.answerTenant.id, userId: approver.id, job: 'route-test' });
        routeCtx = resolved.ctx;
        const { POST } = require('@/app/api/t/[tenantSlug]/assistant/ask/route');
        const res = await POST(
            new NextRequest(`http://localhost/api/t/${manifest.answerTenant.slug}/assistant/ask`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ question: 'Do you require multi-factor authentication for critical systems?' }),
            }),
            { params: Promise.resolve({ tenantSlug: manifest.answerTenant.slug }) },
        );
        expect(res.status).toBe(200);
        expect(routeRequests.length).toBeGreaterThan(0);
        for (const r of routeRequests) {
            expect(r.tools.length).toBeGreaterThan(0);
            expect(r.tools.map((t) => t.name)).not.toContain('search_knowledge');
        }
    });

    it('inside the stage’s scope, a search for any tenant but the one it names is refused', async () => {
        const { withRagEvaluationMount } = require('@/app-layer/services/rag-evaluation-mount');
        const { searchKnowledge } = require('@/app-layer/usecases/knowledge-search');
        const { makeRequestContext } = require('../helpers/make-context');
        const mount = { state: 'MOUNTED', revision: retrieval.retrieverRevision, evaluation: { tenantId: manifest.answerTenant.id, setHash: retrieval.setHash } };
        const other = makeRequestContext('OWNER', { tenantId: manifest.probeTenant.id });
        const injection = makeRequestContext('OWNER', { tenantId: manifest.injectionTenant.id });
        const mine = makeRequestContext('OWNER', { tenantId: manifest.answerTenant.id });
        const [o, i, m] = await withRagEvaluationMount(mount, async () => [
            await searchKnowledge(other, { query: 'multi-factor authentication' }),
            await searchKnowledge(injection, { query: 'multi-factor authentication' }),
            await searchKnowledge(mine, { query: 'multi-factor authentication' }),
        ]);
        const refused = { available: false, reason: 'NOT_EVALUATED', detail: 'EVALUATION_SCOPE_OTHER_TENANT' };
        expect(o).toEqual(refused);
        // One tenant per question: a scope opened for a task question does not admit the injection tenant.
        expect(i).toEqual(refused);
        expect(m.available).toBe(true);
    });

    it('a budget refusal stops answering: the file says so and keeps no part of the interrupted answer', async () => {
        const second = set.cases[1];
        const budgeted = fakeModel({ refuseBudgetOnQuestion: second.question });
        const out = await stage.runAnswerStage({ set, manifest, retrieval, proxy: 'http://127.0.0.1:8787', meter, provider: () => budgeted.provider });
        expect(out.status).toBe('BUDGET_EXHAUSTED');
        expect(out.answers.map((a) => a.caseId)).toEqual([set.cases[0].id]);
        expect(out.unanswered).toEqual(set.cases.slice(1).map((c) => c.id));
        // Nothing was asked after the refusal.
        expect(budgeted.requests.filter((r) => set.cases.slice(2).some((c) => c.question === r.question))).toEqual([]);
    });
});
