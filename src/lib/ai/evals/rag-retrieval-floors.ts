/**
 * The two retrieval floors, D-L4-9, and a reading of a record's figures
 * against them (vector store Phase 3.6, `docs/ai-architecture/weaviate.md`;
 * read by the Ragas nightly, `docs/ai-architecture/ragas.md` Phase 1).
 *
 * ‾‾‾ DECIDED ‾‾‾
 *
 * D-L4-9 (owner, adopted 2026-11-12): recall@10 at least 0.95 of an exact scan
 * of the same tenant, and p95 `search` latency at most 300 ms on the VM, at
 * k = 10. A miss on two consecutive nightly records after tuning is the
 * trigger for the vector store's Phase 4 (Weaviate); one miss is a tuning task.
 * The owner decided on 2026-11-16 that the same values also gate whether
 * `search_knowledge` is offered (the mount gate); Ragas Phase 2's
 * answer-quality floors join the gate when Phase 2 defines them.
 *
 * ‾‾‾ A NULL FIGURE IS NEVER A PASS ‾‾‾
 *
 * A figure the probes could not compute (no exact list to compare against, no
 * latency sample) reads `meets: null`, "not assessed": neither a pass nor a
 * miss, and never folded into either. `allMet` is true only when both figures
 * were assessed and met.
 *
 * Pure: no filesystem, no network.
 */
import type { RetrievalFloorFigures } from './rag-record';

/** D-L4-9: recall@10 of the indexed search at least this fraction of an exact scan of the same tenant. */
export const RECALL_AT_10_VS_EXACT_FLOOR = 0.95;
/** D-L4-9: p95 `search` latency at k = 10 at most this, on the VM (a CI runner's figure is not the VM's). */
export const P95_SEARCH_LATENCY_MS_CEILING = 300;

export interface FloorReading {
    /** The recomputed figure, or null when there was nothing to compute it over. */
    readonly value: number | null;
    /** The D-L4-9 bound it is read against. */
    readonly floor: number;
    /** true / false against the bound; null when not assessed. */
    readonly meets: boolean | null;
}

export interface RetrievalFloorReading {
    readonly decision: 'D-L4-9';
    readonly recallAt10VsExact: FloorReading;
    readonly p95LatencyMs: FloorReading;
    /** True only when BOTH figures were assessed and met: a null is never a pass. */
    readonly allMet: boolean;
    /** True when at least one assessed figure missed. */
    readonly anyMissed: boolean;
}

export function readRetrievalFloors(figures: RetrievalFloorFigures): RetrievalFloorReading {
    const recall: FloorReading = {
        value: figures.recallAt10VsExact,
        floor: RECALL_AT_10_VS_EXACT_FLOOR,
        meets: figures.recallAt10VsExact === null ? null : figures.recallAt10VsExact >= RECALL_AT_10_VS_EXACT_FLOOR,
    };
    const latency: FloorReading = {
        value: figures.p95LatencyMs,
        floor: P95_SEARCH_LATENCY_MS_CEILING,
        meets: figures.p95LatencyMs === null ? null : figures.p95LatencyMs <= P95_SEARCH_LATENCY_MS_CEILING,
    };
    return {
        decision: 'D-L4-9',
        recallAt10VsExact: recall,
        p95LatencyMs: latency,
        allMet: recall.meets === true && latency.meets === true,
        anyMissed: recall.meets === false || latency.meets === false,
    };
}
