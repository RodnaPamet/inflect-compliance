/**
 * The Ragas nightly's corpus (Ragas Phase 1, `docs/ai-architecture/ragas.md`;
 * the scaled corpus is vector store Phase 3.6, `docs/ai-architecture/weaviate.md`).
 *
 * Builds, on a CI or local test database, the tenants the two stages read,
 * through the PRODUCT's own paths and nothing else: tenants by
 * `createTenantWithOwner`, people by invite, policies from the template library
 * (`createPolicyFromTemplate`) or written (`createPolicy`), approval by a
 * second person (`requestPolicyApproval` → `decidePolicyApproval`), and
 * vectors by the index job (`runKnowledgeIndexJob`), which embeds through the
 * deployment's embedding route and writes through `VectorRepository`. No row of
 * the knowledge tables is written here.
 *
 *   ANSWER TENANT (`rag-eval-seed`) — what the Ragas metrics are about: the
 *     three templates the seed publishes, each chosen as the library entry
 *     whose text holds every ground-truth passage the set names for it (a
 *     template change that would move the answers is a refusal here), plus one
 *     policy per injected chunk. Nothing else, so a refusal case's "the corpus
 *     does not say" stays true.
 *   PROBE TENANT (`rag-eval-probe`) — what the two retrieval figures are about:
 *     the same three templates plus DISTRACTOR paragraphs until it holds the
 *     stated chunk count (`--probe-tenant-chunks`). A tenant the size of the
 *     seed corpus (~50 chunks) is planned as a B-tree read and a sort — an
 *     exact search — so its recall is 1 by construction and says nothing about
 *     the HNSW index; the stated size is what makes the index the plan.
 *   FILLER TENANTS (`rag-eval-filler-NNN`) — distractors only, as many as make
 *     the shared index hold the stated multiple of the probe tenant's chunks
 *     (`--scale-multiple`), so the filtered search runs over other tenants' rows.
 *
 * Distractors are real language, not random vectors: paragraphs recombined
 * from the template library's sentences (the seed templates' excluded) by a
 * keyed, deterministic draw, each 700–1,150 characters so the paragraph
 * chunker cuts exactly one chunk from each. The record carries the counts that
 * resulted; the multiple is recomputed from them, never taken from an option.
 *
 * The manifest holds ids, slugs, source keys and counts — never text. It
 * refuses to run against anything but a loopback database, and on a database
 * that already holds any of its tenants.
 *
 * Usage:
 *   npx tsx scripts/rag-eval/corpus.ts --set evals/rag/sets/seed-policies.json \
 *       --probe-tenant-chunks 5000 --scale-multiple 4 --manifest rag-out/corpus.json [--embedder stub]
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import prisma from '@/lib/prisma';
import type { RequestContext } from '@/app-layer/types';
import { hashForLookup } from '@/lib/security/encryption';
import { resolveMemberContextWithReason } from '@/app-layer/context-system';
import { createTenantWithOwner } from '@/app-layer/usecases/tenant-lifecycle';
import { createInviteToken, redeemInvite } from '@/app-layer/usecases/tenant-invites';
import { createPolicy, createPolicyFromTemplate, decidePolicyApproval, requestPolicyApproval } from '@/app-layer/usecases/policy';
import { runKnowledgeIndexJob } from '@/app-layer/jobs/knowledge-index';
import { MAX_CHUNKS_PER_SOURCE, type KnowledgeIndexDeps } from '@/app-layer/services/knowledge-index';
import { MAX_CHUNK_CHARS } from '@/lib/knowledge/paragraph-chunker';
import { checkRagEvaluationSet, type RagEvaluationSet } from '@/lib/ai/evals/rag-record';

import { assertLoopbackDatabase, embedderDeps, parseArgs, type EmbedderMode } from './shared';

export const ANSWER_TENANT_SLUG = 'rag-eval-seed';
export const PROBE_TENANT_SLUG = 'rag-eval-probe';
export const FILLER_SLUG_PREFIX = 'rag-eval-filler-';
/** No run creates more filler tenants than this, nor a probe tenant larger than this. */
export const MAX_FILLER_TENANTS = 50;
export const MAX_PROBE_TENANT_CHUNKS = 50_000;
/** Distractor paragraphs per policy: well inside the index's per-source cap. */
export const DISTRACTORS_PER_POLICY = Math.min(1000, MAX_CHUNKS_PER_SOURCE);
/** A distractor paragraph's length bounds: never merged with a neighbour, never split. */
export const DISTRACTOR_MIN_CHARS = 700;
export const DISTRACTOR_MAX_CHARS = Math.min(1150, MAX_CHUNK_CHARS - 50);
const SOURCE_MODEL = 'PolicyVersion';

export interface CorpusSource {
    /** The store's key: the source model and row id the index job filed the chunks under. */
    readonly sourceModel: typeof SOURCE_MODEL;
    readonly sourceId: string;
    /** The set's key for it: a policy slug, an injected chunk's key, or `distractor-NNN`. */
    readonly sourceKey: string;
    readonly kind: 'seed-policy' | 'injected' | 'distractor';
    /** Chunks the index job cut the source into. */
    readonly chunks: number;
}

export interface CorpusTenant {
    readonly id: string;
    readonly slug: string;
    readonly sources: readonly CorpusSource[];
}

export interface CorpusManifest {
    /** The Ragas metrics' corpus: the seed policies and the injected chunks. */
    readonly answerTenant: CorpusTenant;
    /** The retrieval figures' corpus: the seed policies and distractors, at the stated size. */
    readonly probeTenant: CorpusTenant;
    readonly fillerTenants: ReadonlyArray<{ readonly id: string; readonly slug: string; readonly chunks: number }>;
    readonly embeddingModel: string;
    /** The options as stated; the counts that resulted are in the sources. */
    readonly stated: { readonly probeTenantChunks: number; readonly scaleMultiple: number };
}

type Log = (line: string) => void;
type People = { tenantId: string; owner: RequestContext; approver: RequestContext };

/** The policy slug the product derives from a title (policy.ts `slugify`), to choose a template by its key. */
export function slugOf(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/** The ground-truth passages the set rests on, per source key. */
export function passagesBySourceKey(set: RagEvaluationSet): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const c of set.cases) {
        for (const r of c.groundTruth.refs) out.set(r.sourceKey, [...(out.get(r.sourceKey) ?? []), r.passage]);
    }
    return out;
}

/** Each injected chunk once, by its key; one key carrying two texts is refused. */
export function injectedChunks(set: RagEvaluationSet): Map<string, string> {
    const out = new Map<string, string>();
    for (const c of set.cases) {
        if (!c.injected) continue;
        const prior = out.get(c.injected.sourceKey);
        if (prior !== undefined && prior !== c.injected.text) {
            throw new Error(`rag-eval corpus: injected key ${c.injected.sourceKey} carries two different texts`);
        }
        out.set(c.injected.sourceKey, c.injected.text);
    }
    return out;
}

/**
 * The library template a source key names: the first (by id) whose title slugs
 * to the key AND whose text holds every passage the set names for it. None is
 * a refusal, never a guess: the set's ground truth is about one text.
 */
export function chooseTemplate(
    key: string,
    passages: readonly string[],
    templates: ReadonlyArray<{ id: string; title: string; contentText: string }>,
): { id: string; title: string } {
    const named = templates.filter((t) => slugOf(t.title) === key).sort((a, b) => (a.id < b.id ? -1 : 1));
    const hit = named.find((t) => passages.every((p) => t.contentText.includes(p)));
    if (!hit) {
        throw new Error(
            `rag-eval corpus: no library template for "${key}" holds every ground-truth passage (${named.length} template(s) carry that title)`,
        );
    }
    return { id: hit.id, title: hit.title };
}

/** The library's sentences: prose only (no headings, tables or list markers), 40–400 characters, each once. */
export function librarySentences(texts: readonly string[]): string[] {
    const out = new Set<string>();
    for (const text of texts) {
        for (const line of text.split('\n')) {
            const prose = line.trim();
            if (!prose || /^(#|\||[-*+]\s|\d+\.\s|>)/.test(prose)) continue;
            for (const s of prose.split(/(?<=[.!?])\s+/)) {
                const sentence = s.replace(/[*_`]/g, '').trim();
                if (sentence.length >= 40 && sentence.length <= 400 && /[.!?]$/.test(sentence)) out.add(sentence);
            }
        }
    }
    return [...out].sort();
}

/**
 * `count` distractor paragraphs drawn from `sentences` by a keyed counter
 * (SHA-256 of `seed` and the draw number): the same inputs give the same
 * paragraphs on every machine, so two nights' corpora differ only when the
 * library does.
 */
export function distractorParagraphs(sentences: readonly string[], count: number, seed: string): string[] {
    if (sentences.length < 10) throw new Error('rag-eval corpus: the template library has too few sentences to draw distractors from');
    let draw = 0;
    const next = () => createHash('sha256').update(`${seed}:${draw++}`).digest().readUInt32BE(0) % sentences.length;
    return Array.from({ length: count }, () => {
        let p = '';
        while (p.length < DISTRACTOR_MIN_CHARS) {
            const s = sentences[next()];
            if (p.length + 1 + s.length > DISTRACTOR_MAX_CHARS) continue;
            p = p ? `${p} ${s}` : s;
        }
        return p;
    });
}

async function memberContext(tenantId: string, userId: string): Promise<RequestContext> {
    const resolved = await resolveMemberContextWithReason({ tenantId, userId, job: 'rag-eval-corpus', discriminator: randomUUID() });
    if (!resolved.ok) throw new Error(`rag-eval corpus: a corpus person is not an ACTIVE member (${resolved.reason})`);
    return { ...resolved.ctx, actorType: 'JOB' };
}

/** The corpus tenant's OWNER: who writes its policies, and who asks the answer stage's questions. */
export function corpusOwnerEmail(slug: string): string {
    return `owner@${slug}.rag-eval.test`;
}

/** A tenant with an OWNER (creates and requests) and an ADMIN (approves): two people, as approval needs. */
async function createCorpusTenant(slug: string): Promise<People> {
    const ownerEmail = corpusOwnerEmail(slug);
    const approverEmail = `approver@${slug}.rag-eval.test`;
    const created = await createTenantWithOwner({ name: slug, slug, ownerEmail, requestId: `rag-eval-${randomUUID()}` });
    const tenantId = created.tenant.id;
    const ownerUser = await prisma.user.findUniqueOrThrow({ where: { emailHash: hashForLookup(ownerEmail) }, select: { id: true } });
    const owner = await memberContext(tenantId, ownerUser.id);
    const approverUser = await prisma.user.upsert({
        where: { emailHash: hashForLookup(approverEmail) },
        update: {},
        create: { email: approverEmail, emailHash: hashForLookup(approverEmail), name: `Approver (${slug})` },
        select: { id: true },
    });
    const invite = await createInviteToken(owner, { email: approverEmail, role: 'ADMIN' });
    await redeemInvite({ token: invite.invite.token, userId: approverUser.id, userEmail: approverEmail });
    return { tenantId, owner, approver: await memberContext(tenantId, approverUser.id) };
}

/** Approve a new policy's first version (two people) and index it. */
async function approveAndIndex(
    people: People,
    policyId: string,
    deps: KnowledgeIndexDeps,
): Promise<{ versionId: string; chunks: number; slug: string; embeddingModel: string }> {
    const policy = await prisma.policy.findUniqueOrThrow({ where: { id: policyId }, select: { currentVersionId: true, slug: true } });
    if (!policy.currentVersionId) throw new Error(`rag-eval corpus: policy ${policy.slug} has no version`);
    const approval = await requestPolicyApproval(people.owner, policyId, policy.currentVersionId);
    await decidePolicyApproval(people.approver, policyId, approval.id, { decision: 'APPROVED' });
    const r = await runKnowledgeIndexJob({ tenantId: people.tenantId, sourceModel: SOURCE_MODEL, sourceId: policy.currentVersionId }, deps);
    if (r.outcome !== 'INDEXED' || !r.embeddingModel) {
        throw new Error(
            `rag-eval corpus: indexing ${policy.slug} ended ${r.outcome}${r.embedFailure ? ` (${r.embedFailure})` : ''}${r.storeRefusal ? ` (${r.storeRefusal})` : ''}`,
        );
    }
    return { versionId: policy.currentVersionId, chunks: r.chunks, slug: policy.slug, embeddingModel: r.embeddingModel };
}

async function adoptSeedTemplates(
    people: People,
    seedTemplates: ReadonlyArray<{ key: string; id: string; title: string }>,
    deps: KnowledgeIndexDeps,
): Promise<{ sources: CorpusSource[]; embeddingModel: string }> {
    const sources: CorpusSource[] = [];
    let embeddingModel = '';
    for (const t of seedTemplates) {
        const policy = await createPolicyFromTemplate(people.owner, t.id);
        const done = await approveAndIndex(people, policy.id, deps);
        if (done.slug !== t.key) throw new Error(`rag-eval corpus: the product slugged "${t.title}" as ${done.slug}, the set keys it ${t.key}`);
        embeddingModel = done.embeddingModel;
        sources.push({ sourceModel: SOURCE_MODEL, sourceId: done.versionId, sourceKey: t.key, kind: 'seed-policy', chunks: done.chunks });
    }
    return { sources, embeddingModel };
}

/** Distractor policies of up to DISTRACTORS_PER_POLICY paragraphs each, until `count` chunks are indexed. */
async function addDistractors(
    people: People,
    sentences: readonly string[],
    count: number,
    seed: string,
    deps: KnowledgeIndexDeps,
): Promise<CorpusSource[]> {
    const paragraphs = distractorParagraphs(sentences, count, seed);
    const sources: CorpusSource[] = [];
    for (let i = 0; i < paragraphs.length; i += DISTRACTORS_PER_POLICY) {
        const n = sources.length + 1;
        const content = paragraphs.slice(i, i + DISTRACTORS_PER_POLICY).join('\n\n');
        const policy = await createPolicy(people.owner, { title: `Operating procedure ${n}`, content, contentType: 'MARKDOWN' });
        const done = await approveAndIndex(people, policy.id, deps);
        sources.push({ sourceModel: SOURCE_MODEL, sourceId: done.versionId, sourceKey: `distractor-${String(n).padStart(3, '0')}`, kind: 'distractor', chunks: done.chunks });
    }
    return sources;
}

const chunksOf = (sources: readonly CorpusSource[]) => sources.reduce((s, x) => s + x.chunks, 0);

export interface PrepareOptions {
    readonly set: RagEvaluationSet;
    /** The probe tenant's stated size, in chunks (the seed policies count towards it). */
    readonly probeTenantChunks: number;
    /** The stated multiple: filler tenants are added until the index holds this times the probe tenant's chunks. */
    readonly scaleMultiple: number;
    readonly deps?: KnowledgeIndexDeps;
    /** Test seam: a prefix kept apart from another suite's tenants. */
    readonly slugPrefix?: string;
    readonly log?: Log;
}

/**
 * Build the corpus. Meant for a FRESH database (the nightly's service
 * container); a tenant that already exists is refused rather than topped up,
 * because a half-built corpus from an earlier run would make the counts
 * describe two runs.
 */
export async function prepareRagEvalCorpus(opts: PrepareOptions): Promise<CorpusManifest> {
    const log = opts.log ?? (() => {});
    const deps = opts.deps ?? {};
    const prefix = opts.slugPrefix ?? '';
    if (!Number.isInteger(opts.probeTenantChunks) || opts.probeTenantChunks < 1 || opts.probeTenantChunks > MAX_PROBE_TENANT_CHUNKS) {
        throw new Error(`rag-eval corpus: --probe-tenant-chunks is an integer in 1..${MAX_PROBE_TENANT_CHUNKS}`);
    }
    if (!Number.isFinite(opts.scaleMultiple) || opts.scaleMultiple < 1 || opts.scaleMultiple > MAX_FILLER_TENANTS + 1) {
        throw new Error(`rag-eval corpus: --scale-multiple is a number in 1..${MAX_FILLER_TENANTS + 1}`);
    }
    const answerSlug = `${prefix}${ANSWER_TENANT_SLUG}`;
    const probeSlug = `${prefix}${PROBE_TENANT_SLUG}`;
    const fillerSlug = (n: number) => `${prefix}${FILLER_SLUG_PREFIX}${String(n + 1).padStart(3, '0')}`;
    const slugs = [answerSlug, probeSlug, ...Array.from({ length: MAX_FILLER_TENANTS }, (_, n) => fillerSlug(n))];
    const existing = await prisma.tenant.findMany({ where: { slug: { in: slugs } }, select: { slug: true } });
    if (existing.length > 0) throw new Error(`rag-eval corpus: tenant(s) already exist (${existing.map((t) => t.slug).join(', ')}); build on a fresh database`);

    const templates = await prisma.policyTemplate.findMany({ select: { id: true, title: true, contentText: true }, orderBy: { id: 'asc' }, take: 5000 });
    const passages = passagesBySourceKey(opts.set);
    const seedTemplates = [...passages.entries()].map(([key, ps]) => ({ key, ...chooseTemplate(key, ps, templates) }));
    if (seedTemplates.length === 0) throw new Error('rag-eval corpus: the set names no source');
    const seedIds = new Set(seedTemplates.map((t) => t.id));
    const sentences = librarySentences(templates.filter((t) => !seedIds.has(t.id)).map((t) => t.contentText));

    // The answer tenant: the seed policies and the injected chunks, nothing else.
    const answerPeople = await createCorpusTenant(answerSlug);
    const answer = await adoptSeedTemplates(answerPeople, seedTemplates, deps);
    for (const [key, text] of injectedChunks(opts.set)) {
        const policy = await createPolicy(answerPeople.owner, { title: `Notice ${key}`, content: text, contentType: 'MARKDOWN' });
        const done = await approveAndIndex(answerPeople, policy.id, deps);
        answer.sources.push({ sourceModel: SOURCE_MODEL, sourceId: done.versionId, sourceKey: key, kind: 'injected', chunks: done.chunks });
    }
    log(`${answerSlug}: ${answer.sources.length} sources, ${chunksOf(answer.sources)} chunks`);

    // The probe tenant: the seed policies, then distractors to the stated size.
    const probePeople = await createCorpusTenant(probeSlug);
    const probe = await adoptSeedTemplates(probePeople, seedTemplates, deps);
    const missing = opts.probeTenantChunks - chunksOf(probe.sources);
    if (missing > 0) probe.sources.push(...(await addDistractors(probePeople, sentences, missing, `${probeSlug}`, deps)));
    const probeChunks = chunksOf(probe.sources);
    log(`${probeSlug}: ${probe.sources.length} sources, ${probeChunks} chunks`);

    // Filler tenants until the shared index holds the stated multiple.
    let tableChunks = chunksOf(answer.sources) + probeChunks;
    const fillers: Array<{ id: string; slug: string; chunks: number }> = [];
    for (let n = 0; tableChunks < opts.scaleMultiple * probeChunks; n++) {
        if (n >= MAX_FILLER_TENANTS) throw new Error(`rag-eval corpus: ${MAX_FILLER_TENANTS} filler tenants could not reach ${opts.scaleMultiple} x ${probeChunks}`);
        const slug = fillerSlug(n);
        const people = await createCorpusTenant(slug);
        const want = Math.min(probeChunks, Math.ceil(opts.scaleMultiple * probeChunks - tableChunks));
        const chunks = chunksOf(await addDistractors(people, sentences, want, slug, deps));
        fillers.push({ id: people.tenantId, slug, chunks });
        tableChunks += chunks;
        log(`${slug}: ${chunks} chunks`);
    }
    return {
        answerTenant: { id: answerPeople.tenantId, slug: answerSlug, sources: answer.sources },
        probeTenant: { id: probePeople.tenantId, slug: probeSlug, sources: probe.sources },
        fillerTenants: fillers,
        embeddingModel: probe.embeddingModel,
        stated: { probeTenantChunks: opts.probeTenantChunks, scaleMultiple: opts.scaleMultiple },
    };
}

export async function main(argv: readonly string[]): Promise<number> {
    const args = parseArgs(argv, ['set', 'probe-tenant-chunks', 'scale-multiple', 'manifest', 'embedder', 'stub-dimensions']);
    assertLoopbackDatabase(process.env);
    if (!args.manifest) throw new Error('rag-eval corpus: --manifest <path> is required');
    const setCheck = checkRagEvaluationSet(JSON.parse(readFileSync(args.set ?? 'evals/rag/sets/seed-policies.json', 'utf-8')));
    if (!setCheck.ok) throw new Error(`rag-eval corpus: the set is refused: ${setCheck.reason} ${setCheck.detail}`);
    const manifest = await prepareRagEvalCorpus({
        set: setCheck.set,
        probeTenantChunks: Number(args['probe-tenant-chunks']),
        scaleMultiple: Number(args['scale-multiple']),
        deps: embedderDeps((args.embedder ?? 'deployment') as EmbedderMode, Number(args['stub-dimensions'] ?? 384)),
        log: (line) => console.info(`[rag-eval corpus] ${line}`),
    });
    writeFileSync(args.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    console.info(`[rag-eval corpus] ${manifest.fillerTenants.length} filler tenant(s); model ${manifest.embeddingModel}`);
    return 0;
}

if (require.main === module) {
    main(process.argv.slice(2))
        .then(async (code) => {
            await prisma.$disconnect();
            process.exit(code);
        })
        .catch(async (err) => {
            console.error('[rag-eval corpus] FAILED', err instanceof Error ? err.message : err);
            await prisma.$disconnect();
            process.exit(1);
        });
}
