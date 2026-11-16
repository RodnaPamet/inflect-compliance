/**
 * The Ragas nightly's checker and summary (Ragas Phase 1, `docs/ai-architecture/ragas.md` 1.3).
 *
 *   --record <file>  validates a record with `checkRagEvaluationRecord` (the
 *                    same function the mount gate reads records through),
 *                    under the cost meter's facts: the pinned price table's
 *                    hash, the models it prices and the ragas share. A refusal
 *                    exits 1 and names its reason. Every figure in the summary
 *                    is RECOMPUTED from the record's raw per-case values.
 *   --probe <file>   the retrieval stage's output alone (a night with no answer
 *                    target): the two retrieval figures recomputed from its
 *                    probes, read against the D-L4-9 floors.
 *
 * Prints a JSON verdict on stdout ({ ok, refused?, retrieval, revisionId }) for the
 * workflow's issue step, and writes the markdown summary to --md.
 *
 * Pure apart from reading its inputs: no database, no network.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
    checkRagEvaluationRecord,
    probeCorpusFigures,
    RAG_CASE_KINDS,
    RAG_METRICS,
    ragRetrieverRevisionId,
    retrievalFloorFigures,
    type RagAggregates,
    type RagEvaluationRecord,
    type RetrievalFloorFigures,
} from '@/lib/ai/evals/rag-record';
import { readRetrievalFloors, type RetrievalFloorReading } from '@/lib/ai/evals/rag-retrieval-floors';

import type { ProbeOutput } from './probe';
import { parseArgs } from './shared';

const ROOT = path.resolve(__dirname, '../..');
export const RAG_JOB = 'ragas';

/** The cost meter's facts for this job: the table's hash over its exact bytes, its models, the share. */
export function meterFacts(root = ROOT): { priceTable: { hash: string; models: string[] }; shareUsd: number } {
    const bytes = readFileSync(path.join(root, 'evals/cost-meter/prices.json'));
    const prices = JSON.parse(bytes.toString('utf-8')) as { models: Record<string, unknown> };
    const shares = JSON.parse(readFileSync(path.join(root, 'evals/cost-meter/shares.json'), 'utf-8')) as {
        shares: Record<string, { usd: number }>;
    };
    const share = shares.shares[RAG_JOB];
    if (!share) throw new Error(`rag-eval check: the cost meter holds no ${RAG_JOB} share`);
    return {
        priceTable: { hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, models: Object.keys(prices.models) },
        shareUsd: share.usd,
    };
}

const fmt = (v: number | null, digits = 3) => (v === null ? 'not assessed' : v.toFixed(digits));
const verdict = (meets: boolean | null) => (meets === null ? 'not assessed' : meets ? 'meets' : 'MISSES');

export function retrievalMarkdown(
    figures: RetrievalFloorFigures,
    reading: RetrievalFloorReading,
    corpus: ProbeOutput['probeCorpus'] | undefined,
    revision: RagEvaluationRecord['retrieverRevision'],
): string {
    const scale = corpus ? probeCorpusFigures(corpus) : null;
    return [
        `### Retrieval floors (D-L4-9; they gate search_knowledge, and two consecutive misses after tuning trigger Weaviate)`,
        ``,
        `Revision \`${ragRetrieverRevisionId(revision)}\`: ${revision.embeddingModel}, ${revision.dimensions} dimensions, ${revision.chunker}, k ${revision.k}, index ${revision.indexParams.method}.`,
        scale
            ? `Corpus: the evaluated tenant holds ${scale.tenantChunks} chunks of ${scale.tableChunks} in the shared index (${scale.tenants} tenants, ${fmt(scale.tableToTenantMultiple, 1)} times), measured on ${scale.host}.`
            : 'Corpus: not stated.',
        ``,
        `| Figure | Value | Floor (D-L4-9) | Reading |`,
        `| --- | --- | --- | --- |`,
        `| recall@10 vs exact (${figures.recallScored} questions) | ${fmt(figures.recallAt10VsExact)} | at least ${reading.recallAt10VsExact.floor} | ${verdict(reading.recallAt10VsExact.meets)} |`,
        `| p95 search latency, ms (${figures.latencySamples} samples) | ${fmt(figures.p95LatencyMs, 1)} | at most ${reading.p95LatencyMs.floor} | ${verdict(reading.p95LatencyMs.meets)} |`,
        ``,
        `A CI runner's latency is not the VM's; D-L4-9's latency floor is stated for the VM.`,
    ].join('\n');
}

export function aggregatesMarkdown(aggregates: RagAggregates, record: RagEvaluationRecord, unanswered: readonly string[]): string {
    const lines = [
        `### Ragas record (${record.status}, USD ${record.spendUsd.toFixed(4)})`,
        ``,
        `Judge: ${record.judgeRevision.provider} ${record.judgeRevision.model}, embeddings ${record.judgeRevision.embeddingModel}, ragas ${record.judgeRevision.ragasVersion}. Every figure below is recomputed from the record's raw per-case values.`,
        ``,
        `| Kind | Cases | ${RAG_METRICS.join(' | ')} | Declined correctly | Abstained / answered / unjudged |`,
        `| --- | --- | ${RAG_METRICS.map(() => '---').join(' | ')} | --- | --- |`,
    ];
    for (const kind of RAG_CASE_KINDS) {
        const a = aggregates[kind];
        const decline = a.declinedCorrectly ? `${a.declinedCorrectly.correct}/${a.declinedCorrectly.judged}` : '—';
        lines.push(
            `| ${kind} | ${a.cases}${a.unanswered ? ` (+${a.unanswered} unanswered)` : ''} | ${RAG_METRICS.map((m) => fmt(a.metrics[m].mean)).join(' | ')} | ${decline} | ${a.abstention.abstained} / ${a.abstention.answered} / ${a.abstention.unjudged} |`,
        );
    }
    const inj = aggregates.injection.injectionResisted;
    if (inj) lines.push('', `Injection resisted: ${inj.resisted} of ${inj.total}.`);
    if (unanswered.length > 0) lines.push('', `Unanswered (the budget stopped the run): ${unanswered.join(', ')}.`);
    return lines.join('\n');
}

export interface CheckVerdict {
    readonly ok: boolean;
    readonly refused?: { reason: string; detail: string };
    readonly retrieval?: RetrievalFloorReading;
    /** The retriever revision's id: a record is committed as `evals/rag/records/<id>.json`. */
    readonly revisionId?: string;
    readonly markdown: string;
}

export function checkRecordFile(recordRaw: unknown, setRaw: unknown, root = ROOT): CheckVerdict {
    const facts = meterFacts(root);
    const r = checkRagEvaluationRecord(recordRaw, setRaw, { shareUsd: facts.shareUsd, priceTable: facts.priceTable });
    if (!r.ok) {
        return { ok: false, refused: { reason: r.reason, detail: r.detail }, markdown: `### Ragas record REFUSED\n\n${r.reason}: ${r.detail}` };
    }
    const reading = readRetrievalFloors(r.retrievalFloors);
    return {
        ok: true,
        retrieval: reading,
        revisionId: ragRetrieverRevisionId(r.record.retrieverRevision),
        markdown: [
            aggregatesMarkdown(r.aggregates, r.record, r.unanswered),
            '',
            retrievalMarkdown(r.retrievalFloors, reading, r.record.probeCorpus, r.record.retrieverRevision),
        ].join('\n'),
    };
}

export function checkProbeFile(probe: ProbeOutput): CheckVerdict {
    const figures = retrievalFloorFigures(probe.cases);
    const reading = readRetrievalFloors(figures);
    return { ok: true, retrieval: reading, revisionId: ragRetrieverRevisionId(probe.retrieverRevision), markdown: retrievalMarkdown(figures, reading, probe.probeCorpus, probe.retrieverRevision) };
}

export function main(argv: readonly string[]): number {
    const args = parseArgs(argv, ['record', 'probe', 'set', 'md']);
    let v: CheckVerdict;
    if (args.record) {
        const set = JSON.parse(readFileSync(args.set ?? path.join(ROOT, 'evals/rag/sets/seed-policies.json'), 'utf-8'));
        v = checkRecordFile(JSON.parse(readFileSync(args.record, 'utf-8')), set);
    } else if (args.probe) {
        v = checkProbeFile(JSON.parse(readFileSync(args.probe, 'utf-8')) as ProbeOutput);
    } else {
        throw new Error('rag-eval check: --record <file> or --probe <file>');
    }
    if (args.md) writeFileSync(args.md, `${v.markdown}\n`);
    process.stdout.write(`${JSON.stringify({ ok: v.ok, refused: v.refused, retrieval: v.retrieval, revisionId: v.revisionId })}\n`);
    return v.ok ? 0 : 1;
}

if (require.main === module) {
    try {
        process.exit(main(process.argv.slice(2)));
    } catch (err) {
        console.error('[rag-eval check] FAILED', err instanceof Error ? err.message : err);
        process.exit(1);
    }
}
