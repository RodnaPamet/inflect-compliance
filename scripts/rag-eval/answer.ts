/**
 * The Ragas nightly's ANSWER stage (Ragas Phase 1.2's answer half,
 * `docs/ai-architecture/ragas.md`; the record it feeds opens the
 * `search_knowledge` mount gate, vector store Phase 3.5-3.6).
 *
 * Asks the PRODUCT each question of the set, in process, the way a person in
 * the tenant the case belongs to asks the assistant — the injection cases in
 * the injection tenant, every other case in the answer tenant (owner decision
 * 2026-11-17) — and writes what it answered and what
 * `search_knowledge` returned to the model into an answers file
 * (`rag-answers@1`, `src/lib/ai/evals/rag-answer-contract.ts`) the judge reads.
 *
 *   askAssistant (the real usecase: feature gate, rate limit, input guard,
 *   │             the tool loop, the egress guard, the decision log)
 *   ├─ the offer and the funnel: `search_knowledge` through `runGuardedTool`
 *   │   → `runReadTool` → `searchKnowledge` → the deployment's embedder and
 *   │   the pgvector store under RLS, its result guarded before the model sees it
 *   └─ the model: the assistant's own production model (`agentFlueModel()`,
 *       resolved by the assistant's own `resolveFlueModel`, never named here;
 *       owner decision 2026-11-17), through the LOOPBACK METERING PROXY
 *       (`evals/cost-meter/anthropic-proxy.mjs`), which holds the key and
 *       charges every answer turn to the ragas share the judge spends from.
 *       The share must list that model, and the answers file names it.
 *
 * Three things are supplied here rather than read from a deployment, and each
 * is a seam production never uses:
 *
 *   • THE MOUNT. With no record yet, the gate would withhold the tool the
 *     record is about. The stage runs each question inside
 *     `withRagEvaluationMount` (`services/rag-evaluation-mount.ts`): mounted,
 *     for the revision the retrieval stage measured, for the ONE tenant the
 *     question is asked in, for that question only. Nothing under `src/` can open that scope, and a production
 *     process refuses it (`tests/guards/rag-evaluation-mount-unreachable.test.ts`).
 *   • THE SOCKET. `askAssistant`'s `turnProvider` seam hands the loop the
 *     product's own Anthropic provider pointed at the proxy. The residency
 *     choice, the transfer gate, the request shape and the parsing are the
 *     product's; only where the call leaves for is not.
 *   • THE QUOTA. The workflow raises the assistant's per-tenant daily quota and
 *     per-user rate for this one command, because the set has 52 questions and
 *     the defaults are 50 a day and 5 a minute.
 *
 * What the contexts are: the `search_knowledge` results as the MODEL saw them,
 * read off the next request the loop sends (so a result the guard latched on,
 * which the model never saw, is not a context), in call order, de-duplicated,
 * each hit's text exactly as the tool returned it. A result the loop cut at
 * its byte bound keeps the hits the model saw whole.
 *
 * What stops the stage, and what it leaves:
 *   • the share refusing an answer turn (402): answering stops, the turn's
 *     partial answer is discarded, and the file says BUDGET_EXHAUSTED and names
 *     the cases it did not reach (exit 5). The judge's record then says
 *     BUDGET_EXHAUSTED, which never passes a floor or opens the gate.
 *   • anything else that means the product did not answer — no model call, a
 *     search that was unavailable or answered for another revision, a provider
 *     failure that does not clear on one retry, a refusal that is not the
 *     content guard's: the stage fails (exit 1) and writes no file.
 *
 * Usage (the workflow, after the proxy is up and the key is unset):
 *   ANTHROPIC_API_KEY=held-by-the-metering-proxy \
 *   npx tsx scripts/rag-eval/answer.ts --set evals/rag/sets/seed-policies.json \
 *       --manifest rag-out/corpus.json --retrieval rag-out/retrieval.json \
 *       --proxy http://127.0.0.1:8787 --out rag-out/answers.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { z } from 'zod';

import prisma from '@/lib/prisma';
import type { RequestContext } from '@/app-layer/types';
import { resolveMemberContextWithReason } from '@/app-layer/context-system';
import { askAssistant, GUARD_REFUSAL_SENTENCE, isGuardRefusal } from '@/app-layer/usecases/assistant';
import { AnthropicAssistantProvider, splitSpecifier } from '@/app-layer/ai/assistant/turn-provider';
import type { AssistantTurnProvider, ProviderRequest, ProviderTurn } from '@/app-layer/ai/assistant/tool-loop';
import { knowledgeRetrieverRevision, type EmbeddingRouteFacts } from '@/app-layer/services/knowledge-search-revision';
import { withRagEvaluationMount, type RagEvaluationMount } from '@/app-layer/services/rag-evaluation-mount';
import { SEARCH_KNOWLEDGE_TOOL } from '@/lib/mcp/knowledge-search-descriptor';
import { modelOf, resolveEmbeddingRoute, retrieverRevisionKey } from '@/lib/ai/embeddings';
import { checkRagEvaluationSet, ragSetHash, type RagEvaluationRecord, type RagEvaluationSet } from '@/lib/ai/evals/rag-record';
import {
    RAG_ANSWERS_FILE_CONTRACT,
    RagAnswerResponseSchema,
    RagAnswersFileSchema,
    type RagAnswerResponse,
    type RagAnswersFile,
} from '@/lib/ai/evals/rag-answer-contract';
import { hashForLookup } from '@/lib/security/encryption';

import { resolveFlueModel } from '@/lib/agentic/flue/model-selection';

import { corpusOwnerEmail, type CorpusManifest, type CorpusTenant } from './corpus';
import { PROBE_OUTPUT_KIND } from './probe';
import { assertLoopbackDatabase, parseArgs } from './shared';

/** The value the stage's ANTHROPIC_API_KEY must hold: the real key is the proxy's alone. */
export const PROXY_HELD_KEY = 'held-by-the-metering-proxy';
export const EXIT_BUDGET_EXHAUSTED = 5;
/** The ragas share in `evals/cost-meter/shares.json`. */
const RAGAS_JOB = 'ragas';
const LOOPBACK_PROXY = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
const MAX_CONTEXTS = 50;

export type AnswerStageRefusal =
    | 'SET_MISMATCH'
    | 'REVISION_MISMATCH'
    | 'METER_NOT_RAGAS'
    | 'MODEL_NOT_THE_ASSISTANTS'
    | 'ANSWER_MODEL_NOT_IN_SHARE'
    | 'NO_ASKER'
    | 'NO_MODEL_CALL'
    | 'PROVIDER_FAILED'
    | 'TOOL_ERROR'
    | 'TOOL_RESULT_UNREADABLE'
    | 'SEARCH_UNAVAILABLE'
    | 'SEARCH_OTHER_REVISION'
    | 'TOO_MANY_CONTEXTS'
    | 'ASSISTANT_REFUSED'
    | 'RESPONSE_OUTSIDE_CONTRACT';

export class AnswerStageError extends Error {
    constructor(
        readonly reason: AnswerStageRefusal,
        detail: string,
    ) {
        super(`rag-eval answer: ${reason}: ${detail}`);
        this.name = 'AnswerStageError';
    }
}

// ─── Reading a search_knowledge result as the model saw it ──────────────────

/** One passage as the tool returned it: the chunk's key and its text, nothing else. */
export interface RetrievedContext {
    readonly sourceModel: string;
    readonly sourceId: string;
    readonly chunkIndex: number;
    readonly text: string;
}

const HitSchema = z
    .object({ sourceModel: z.string().min(1), sourceId: z.string().min(1), chunkIndex: z.number().int().min(0), text: z.string() })
    .passthrough();

const PayloadSchema = z
    .object({
        available: z.boolean(),
        embeddingModel: z.string().optional(),
        hits: z.array(z.unknown()).optional(),
        reason: z.string().optional(),
    })
    .passthrough();

/** The index of the bracket closing the one at `start`, reading strings as strings; -1 when the text ends first. */
function closeOf(text: string, start: number): number {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') inString = true;
        else if (c === '{' || c === '[') depth += 1;
        else if (c === '}' || c === ']') {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function hitOf(raw: unknown): RetrievedContext {
    const h = HitSchema.safeParse(raw);
    if (!h.success) throw new AnswerStageError('TOOL_RESULT_UNREADABLE', 'a hit is not {sourceModel, sourceId, chunkIndex, text}');
    return { sourceModel: h.data.sourceModel, sourceId: h.data.sourceId, chunkIndex: h.data.chunkIndex, text: h.data.text };
}

/**
 * One `search_knowledge` result as the tool loop handed it to the model: the
 * funnel's payload (`content[0]`, pretty-printed JSON), the provenance block
 * after it, and possibly the loop's truncation note in place of the end.
 * Whole, the payload is parsed; cut, the hits the model saw whole are kept and
 * the one the cut went through is dropped.
 */
export function readSearchResult(content: string): {
    readonly available: boolean;
    readonly embeddingModel: string | null;
    readonly reason: string | null;
    readonly hits: readonly RetrievedContext[];
    readonly truncated: boolean;
} {
    if (content.startsWith('ERROR:')) throw new AnswerStageError('TOOL_ERROR', content.slice(0, 300));
    const start = content.indexOf('{');
    if (start !== 0) throw new AnswerStageError('TOOL_RESULT_UNREADABLE', 'the result does not start with its payload');
    const end = closeOf(content, start);
    if (end !== -1) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(content.slice(start, end + 1));
        } catch {
            throw new AnswerStageError('TOOL_RESULT_UNREADABLE', 'the payload is not JSON');
        }
        const p = PayloadSchema.safeParse(parsed);
        if (!p.success) throw new AnswerStageError('TOOL_RESULT_UNREADABLE', 'the payload is not a search result');
        return {
            available: p.data.available,
            embeddingModel: p.data.embeddingModel ?? null,
            reason: p.data.reason ?? null,
            hits: (p.data.hits ?? []).map(hitOf),
            truncated: false,
        };
    }
    // Cut by the loop's byte bound: keep the hits that are whole.
    if (!content.includes('[TRUNCATED:')) throw new AnswerStageError('TOOL_RESULT_UNREADABLE', 'the payload ends early with no truncation note');
    const head = /^\{\s*"available":\s*(true|false),\s*"embeddingModel":\s*("(?:[^"\\]|\\.)*")/.exec(content);
    if (!head) throw new AnswerStageError('TOOL_RESULT_UNREADABLE', 'a cut payload does not begin as a search result');
    const hits: RetrievedContext[] = [];
    const at = content.indexOf('"hits": [');
    if (at !== -1) {
        let i = at + '"hits": ['.length;
        for (;;) {
            while (i < content.length && /[\s,]/.test(content[i])) i += 1;
            if (content[i] !== '{') break;
            const close = closeOf(content, i);
            if (close === -1) break;
            hits.push(hitOf(JSON.parse(content.slice(i, close + 1))));
            i = close + 1;
        }
    }
    return { available: head[1] === 'true', embeddingModel: JSON.parse(head[2]) as string, reason: null, hits, truncated: true };
}

// ─── The provider the stage hands the loop ──────────────────────────────────

/**
 * Wraps the product's provider for one question: refuses a turn for any model
 * but the share's (it would be unpriced), reads every `search_knowledge`
 * result the model is about to see, sums the usage, and tells a budget refusal
 * (the proxy's 402) from any other failure. It never changes what is sent or
 * what comes back.
 */
export class CapturingTurnProvider implements AssistantTurnProvider {
    calls = 0;
    budgetExhausted = false;
    /** A failure that makes the answer not the product's; `retryable` when it was the upstream's. */
    failure: { reason: AnswerStageRefusal; detail: string; retryable: boolean } | null = null;
    private usage: { inputTokens: number; outputTokens: number } | null = { inputTokens: 0, outputTokens: 0 };
    private readonly read = new Set<string>();
    private readonly keys = new Set<string>();
    private readonly found: RetrievedContext[] = [];

    constructor(
        private readonly inner: AssistantTurnProvider,
        private readonly answerModel: string,
        private readonly embeddingModel: string,
    ) {}

    get contexts(): readonly RetrievedContext[] {
        return this.found;
    }

    get usageReported(): RagAnswerResponse['usage'] {
        return this.usage;
    }

    private fail(reason: AnswerStageRefusal, detail: string, retryable = false): never {
        this.failure ??= { reason, detail, retryable };
        throw new AnswerStageError(reason, detail);
    }

    private collect(history: ProviderRequest['history']): void {
        for (const entry of history) {
            if (entry.role !== 'tool' || entry.name !== SEARCH_KNOWLEDGE_TOOL || this.read.has(entry.id)) continue;
            this.read.add(entry.id);
            let result: ReturnType<typeof readSearchResult>;
            try {
                result = readSearchResult(entry.content);
            } catch (err) {
                const e = err instanceof AnswerStageError ? err : new AnswerStageError('TOOL_RESULT_UNREADABLE', String(err));
                this.fail(e.reason, e.message);
            }
            if (!result.available) this.fail('SEARCH_UNAVAILABLE', result.reason ?? 'the search was unavailable');
            if (result.embeddingModel !== this.embeddingModel) {
                this.fail('SEARCH_OTHER_REVISION', `searched with ${result.embeddingModel}, measured ${this.embeddingModel}`);
            }
            for (const hit of result.hits) {
                const key = `${hit.sourceModel}\u0000${hit.sourceId}\u0000${hit.chunkIndex}`;
                if (this.keys.has(key)) continue;
                this.keys.add(key);
                this.found.push(hit);
            }
            if (this.found.length > MAX_CONTEXTS) this.fail('TOO_MANY_CONTEXTS', `more than ${MAX_CONTEXTS} distinct passages`);
        }
    }

    async complete(req: ProviderRequest): Promise<ProviderTurn> {
        if (this.failure) throw new AnswerStageError(this.failure.reason, this.failure.detail);
        this.collect(req.history);
        const model = splitSpecifier(req.specifier)?.model;
        if (model !== this.answerModel) this.fail('MODEL_NOT_THE_ASSISTANTS', `the turn asked for ${String(model)}, the stage resolved ${this.answerModel}`);
        this.calls += 1;
        let turn: ProviderTurn;
        try {
            turn = await this.inner.complete(req);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (/\b402\b/.test(message) && message.includes('budget_exhausted')) this.budgetExhausted = true;
            else this.failure ??= { reason: 'PROVIDER_FAILED', detail: message.slice(0, 300), retryable: true };
            throw err;
        }
        if (turn.usage === undefined) this.usage = null;
        else if (this.usage !== null) {
            this.usage = {
                inputTokens: this.usage.inputTokens + turn.usage.tokensIn,
                outputTokens: this.usage.outputTokens + turn.usage.tokensOut,
            };
        }
        return turn;
    }
}

// ─── The stage ──────────────────────────────────────────────────────────────

/** The retrieval stage's output, as far as this stage reads it. */
export interface RetrievalStageOutput {
    readonly kind: string;
    readonly setHash: string;
    readonly retrieverRevision: RagEvaluationRecord['retrieverRevision'];
}

/** What the stage reads off the metering proxy: whose share it meters, and the models that share may spend on. */
export interface MeterReading {
    state(): Promise<{ readonly job: string; readonly models: readonly string[] }>;
}

export function proxyMeter(proxy: string): MeterReading {
    return {
        async state() {
            const res = await fetch(`${proxy}/meter/state`);
            if (!res.ok) throw new Error(`rag-eval answer: the metering proxy answered ${res.status} for its state`);
            const s = (await res.json()) as { job?: unknown; models?: unknown };
            return { job: String(s.job), models: Array.isArray(s.models) ? s.models.map(String) : [] };
        },
    };
}

export interface AnswerStageOptions {
    readonly set: RagEvaluationSet;
    readonly manifest: CorpusManifest;
    readonly retrieval: RetrievalStageOutput;
    /** The loopback metering proxy (`http://127.0.0.1:<port>`). */
    readonly proxy: string;
    readonly meter?: MeterReading;
    /** The embedding route; absent, the deployment's (`AI_EMBED_LOCAL_*`). */
    readonly route?: EmbeddingRouteFacts;
    /** Test seam: the provider for one question; absent, the product's own, aimed at the proxy. */
    readonly provider?: (endpoint: string) => AssistantTurnProvider;
    readonly log?: (line: string) => void;
}

function deploymentRoute(): EmbeddingRouteFacts {
    const route = resolveEmbeddingRoute();
    if (!route.ok) throw new AnswerStageError('REVISION_MISMATCH', `no embedding route is configured (${route.reason})`);
    return { model: modelOf(route.specifier), dimensions: route.dimensions };
}

/**
 * The tenant a case is asked in (owner decision 2026-11-17): the injection
 * cases in the injection tenant, which holds the set's injected chunks and
 * nothing else; every other case in the answer tenant, which holds none.
 */
export function tenantForCase(manifest: CorpusManifest, kind: RagEvaluationSet['cases'][number]['kind']): CorpusTenant {
    return kind === 'injection' ? manifest.injectionTenant : manifest.answerTenant;
}

async function askerContext(tenant: CorpusTenant, caseId: string): Promise<RequestContext> {
    const user = await prisma.user.findUnique({
        where: { emailHash: hashForLookup(corpusOwnerEmail(tenant.slug)) },
        select: { id: true },
    });
    if (!user) throw new AnswerStageError('NO_ASKER', `the corpus tenant ${tenant.slug} has no corpus owner`);
    const resolved = await resolveMemberContextWithReason({
        tenantId: tenant.id,
        userId: user.id,
        job: 'rag-eval-answer',
        discriminator: caseId,
    });
    if (!resolved.ok) throw new AnswerStageError('NO_ASKER', `the corpus owner is not an ACTIVE member (${resolved.reason})`);
    return resolved.ctx;
}

type CaseOutcome = { readonly kind: 'answered'; readonly response: RagAnswerResponse } | { readonly kind: 'budget' };

async function answerCase(
    opts: AnswerStageOptions,
    ctx: RequestContext,
    question: string,
    mount: RagEvaluationMount,
    answerModel: string,
): Promise<CaseOutcome> {
    const endpoint = `${opts.proxy}/v1/messages`;
    const make = opts.provider ?? ((url: string) => new AnthropicAssistantProvider(PROXY_HELD_KEY, undefined, url));
    for (let attempt = 1; ; attempt++) {
        const capture = new CapturingTurnProvider(make(endpoint), answerModel, mount.revision.embeddingModel);
        let message: string;
        try {
            const answer = await withRagEvaluationMount(mount, () =>
                askAssistant(ctx, { question }, { turnProvider: (choice) => (choice.residency === 'EXTERNAL' ? capture : null) }),
            );
            message = answer.message;
        } catch (err) {
            if (capture.budgetExhausted) return { kind: 'budget' };
            // The content guard withholding the turn is an answer the product
            // gave: the person is shown this sentence, and the judge scores it.
            if (!isGuardRefusal(err) || capture.failure) {
                if (capture.failure) throw new AnswerStageError(capture.failure.reason, capture.failure.detail);
                throw new AnswerStageError('ASSISTANT_REFUSED', err instanceof Error ? err.message.slice(0, 300) : String(err));
            }
            message = GUARD_REFUSAL_SENTENCE;
        }
        if (capture.budgetExhausted) return { kind: 'budget' };
        if (capture.failure) {
            if (capture.failure.retryable && attempt === 1) continue;
            throw new AnswerStageError(capture.failure.reason, capture.failure.detail);
        }
        if (capture.calls === 0) throw new AnswerStageError('NO_MODEL_CALL', 'the assistant answered without asking a model');
        const response = RagAnswerResponseSchema.safeParse({
            answer: message,
            retrieved: capture.contexts,
            retriever: { embeddingModel: mount.revision.embeddingModel, k: mount.revision.k },
            usage: capture.usageReported,
        });
        if (!response.success) {
            throw new AnswerStageError('RESPONSE_OUTSIDE_CONTRACT', response.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        }
        return { kind: 'answered', response: response.data };
    }
}

export async function runAnswerStage(opts: AnswerStageOptions): Promise<RagAnswersFile> {
    const log = opts.log ?? (() => {});
    if (!LOOPBACK_PROXY.test(opts.proxy)) throw new Error(`rag-eval answer: the metering proxy is on loopback only, not ${opts.proxy}`);
    const setHash = ragSetHash(opts.set);
    if (opts.retrieval.kind !== PROBE_OUTPUT_KIND || opts.retrieval.setHash !== setHash) {
        throw new AnswerStageError('SET_MISMATCH', 'the retrieval output is not the retrieval stage’s for this set');
    }
    const meter = await (opts.meter ?? proxyMeter(opts.proxy)).state();
    if (meter.job !== RAGAS_JOB) throw new AnswerStageError('METER_NOT_RAGAS', `the proxy meters ${meter.job}, not ${RAGAS_JOB}`);

    // The answers are the deployment's assistant's (owner decision
    // 2026-11-17): the model is resolved by the function the assistant's own
    // turn resolves it with, never named here, and the ragas share must list
    // it. Every turn is then held to it (`CapturingTurnProvider`).
    const choice = resolveFlueModel();
    const answerModel = choice.ok ? splitSpecifier(choice.specifier)?.model : undefined;
    if (!choice.ok || choice.residency !== 'EXTERNAL' || !answerModel) {
        throw new AnswerStageError('MODEL_NOT_THE_ASSISTANTS', `the assistant resolves no external model here (${choice.ok ? choice.specifier : choice.reason})`);
    }
    if (!meter.models.includes(answerModel)) {
        throw new AnswerStageError('ANSWER_MODEL_NOT_IN_SHARE', `the assistant answers with ${answerModel}; the ragas share spends on ${meter.models.join(', ')}`);
    }

    // The answers must be retrieved under the revision the retrieval stage
    // measured, which is the gate's key for this deployment.
    const revision = knowledgeRetrieverRevision(opts.route ?? deploymentRoute());
    if (retrieverRevisionKey(revision) !== retrieverRevisionKey(opts.retrieval.retrieverRevision)) {
        throw new AnswerStageError('REVISION_MISMATCH', 'this deployment’s retriever revision is not the one the retrieval stage measured');
    }

    const answers: RagAnswersFile['answers'] = [];
    const unanswered: string[] = [];
    let stopped = false;
    for (const c of opts.set.cases) {
        if (stopped) {
            unanswered.push(c.id);
            continue;
        }
        // ONE tenant per question: the scope admits the tenant this case is
        // asked in, and no other, for exactly the duration of its question.
        const tenant = tenantForCase(opts.manifest, c.kind);
        const mount: RagEvaluationMount = { state: 'MOUNTED', revision, evaluation: { tenantId: tenant.id, setHash } };
        const ctx = await askerContext(tenant, c.id);
        const outcome = await answerCase(opts, ctx, c.question, mount, answerModel);
        if (outcome.kind === 'budget') {
            stopped = true;
            unanswered.push(c.id);
            log(`${c.id}: the ragas share refused an answer turn; answering stops`);
            continue;
        }
        answers.push({ caseId: c.id, question: c.question, response: outcome.response });
        log(`${c.id}: answered (${outcome.response.retrieved.length} passages)`);
    }
    return RagAnswersFileSchema.parse({
        contract: RAG_ANSWERS_FILE_CONTRACT,
        setHash,
        retrieverRevision: revision,
        answerModel: { provider: 'anthropic', model: answerModel },
        status: stopped ? 'BUDGET_EXHAUSTED' : 'COMPLETE',
        answers,
        unanswered,
    });
}

export async function main(argv: readonly string[]): Promise<number> {
    const args = parseArgs(argv, ['set', 'manifest', 'retrieval', 'proxy', 'out']);
    assertLoopbackDatabase(process.env);
    // The answer stage never holds the model key: the proxy does, and the
    // workflow unsets it before this runs.
    if (process.env.ANTHROPIC_API_KEY !== PROXY_HELD_KEY) {
        throw new Error(`rag-eval answer: ANTHROPIC_API_KEY must be "${PROXY_HELD_KEY}"; the metering proxy holds the real key`);
    }
    if (!args.manifest || !args.retrieval || !args.proxy || !args.out) {
        throw new Error('rag-eval answer: --manifest, --retrieval, --proxy and --out are required');
    }
    const setCheck = checkRagEvaluationSet(JSON.parse(readFileSync(args.set ?? 'evals/rag/sets/seed-policies.json', 'utf-8')));
    if (!setCheck.ok) throw new Error(`rag-eval answer: the set is refused: ${setCheck.reason} ${setCheck.detail}`);
    const file = await runAnswerStage({
        set: setCheck.set,
        manifest: JSON.parse(readFileSync(args.manifest, 'utf-8')) as CorpusManifest,
        retrieval: JSON.parse(readFileSync(args.retrieval, 'utf-8')) as RetrievalStageOutput,
        proxy: args.proxy,
        log: (line) => console.info(`[rag-eval answer] ${line}`),
    });
    writeFileSync(args.out, `${JSON.stringify(file, null, 2)}\n`);
    console.info(`[rag-eval answer] ${file.answers.length} of ${setCheck.set.cases.length} answered, ${file.status}`);
    return file.status === 'COMPLETE' ? 0 : EXIT_BUDGET_EXHAUSTED;
}

if (require.main === module) {
    main(process.argv.slice(2))
        .then(async (code) => {
            await prisma.$disconnect();
            process.exit(code);
        })
        .catch(async (err) => {
            console.error('[rag-eval answer] FAILED', err instanceof Error ? err.message : err);
            await prisma.$disconnect();
            process.exit(1);
        });
}
