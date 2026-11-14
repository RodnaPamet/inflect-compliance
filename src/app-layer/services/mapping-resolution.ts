/**
 * Requirement Mapping Resolution Engine
 *
 * Resolves direct and transitive cross-framework requirement mappings using
 * breadth-first graph traversal with configurable depth limiting and cycle
 * detection.
 *
 * Architecture:
 * ─────────────
 * Given a source requirement, the engine discovers all reachable requirements
 * across framework boundaries via persisted RequirementMapping edges. Results
 * include the full traversal path (edge chain) so consumers can explain *why*
 * two requirements are related and *how strong* the transitive connection is.
 *
 *   Source (ISO A.5.1)  ──EQUAL──▶  Target (NIST GV.OC-01)
 *                                         │
 *                                    ──SUBSET──▶  Target (SOC2 CC1)
 *
 * Traversal strategy:
 * - BFS for shortest-path-first ordering (deterministic, level-by-level)
 * - Visited set prevents cycles and redundant expansion
 * - Configurable max_depth (default 3, max 10)
 * - Each result carries the full edge path for explainability
 *
 * Strength propagation:
 * - Each edge has its own strength (EQUAL, SUPERSET, SUBSET, INTERSECT, RELATED)
 * - The "effective strength" of a path is the minimum strength across all edges
 *   (weakest-link principle: a chain is only as strong as its weakest edge)
 * - This is conservative and semantically correct: transitive coverage
 *   can never be stronger than the weakest hop in the chain
 *
 * This service does NOT interact with the database directly — it accepts
 * a MappingEdgeLoader function that abstracts the data source. This makes
 * it testable without mocks and portable across DB/in-memory backends.
 */

import {
    MAPPING_STRENGTH_RANK,
    type MappingStrengthValue,
    type ResolvedMappingEdge,
} from '../domain/requirement-mapping.types';

// ─── Configuration ───────────────────────────────────────────────────

export const DEFAULT_MAX_DEPTH = 3;
export const ABSOLUTE_MAX_DEPTH = 10;

// ─── Types ───────────────────────────────────────────────────────────

/** A single edge in a mapping path, enriched with traversal metadata. */
export interface MappingPathEdge {
    /** The mapping edge ID */
    readonly id: string;
    /** Depth at which this edge was discovered (1 = direct) */
    readonly depth: number;
    /** Edge strength */
    readonly strength: MappingStrengthValue;
    /** Edge rationale */
    readonly rationale: string | null;
    /** Source requirement info */
    readonly source: {
        readonly requirementId: string;
        readonly requirementCode: string;
        readonly requirementTitle: string;
        readonly frameworkKey: string;
        readonly frameworkName: string;
    };
    /** Target requirement info */
    readonly target: {
        readonly requirementId: string;
        readonly requirementCode: string;
        readonly requirementTitle: string;
        readonly frameworkKey: string;
        readonly frameworkName: string;
    };
}

/**
 * A complete mapping path from the original source to a discovered target.
 * For direct mappings, `edges` has length 1.
 * For transitive mappings, `edges` has length > 1.
 */
export interface MappingPath {
    /** The final target requirement reached by this path */
    readonly target: {
        readonly requirementId: string;
        readonly requirementCode: string;
        readonly requirementTitle: string;
        readonly frameworkKey: string;
        readonly frameworkName: string;
    };
    /** Ordered list of edges from source to target */
    readonly edges: readonly MappingPathEdge[];
    /** Path depth (number of edges) */
    readonly depth: number;
    /** Whether this is a direct (depth=1) or transitive (depth>1) mapping */
    readonly isDirect: boolean;
    /**
     * Effective strength of the full path.
     * Computed as the minimum strength across all edges (weakest-link).
     */
    readonly effectiveStrength: MappingStrengthValue;
    /** Numeric rank of the effective strength (for sorting/filtering) */
    readonly effectiveStrengthRank: number;
}

/**
 * Complete result of a mapping resolution query.
 */
export interface MappingTraceResult {
    /** The source requirement that was queried */
    readonly source: {
        readonly requirementId: string;
        readonly requirementCode: string;
        readonly requirementTitle: string;
        readonly frameworkKey: string;
        readonly frameworkName: string;
    };
    /** All discovered mapping paths, ordered by depth then strength rank */
    readonly paths: readonly MappingPath[];
    /** Configuration used for this resolution */
    readonly config: {
        readonly maxDepth: number;
        readonly targetFrameworkKeys: readonly string[] | null;
        readonly minStrength: MappingStrengthValue | null;
    };
    /** Summary statistics */
    readonly stats: {
        readonly totalPaths: number;
        readonly directPaths: number;
        readonly transitivePaths: number;
        readonly maxDepthReached: number;
        readonly uniqueTargetRequirements: number;
        readonly uniqueTargetFrameworks: number;
    };
}

/**
 * Query input for mapping resolution.
 */
export interface TraceabilityQuery {
    /** The source requirement ID to start traversal from */
    readonly sourceRequirementId: string;
    /** Optional: only return paths reaching these target framework keys */
    readonly targetFrameworkKeys?: readonly string[];
    /** Maximum traversal depth (default: 3, max: 10) */
    readonly maxDepth?: number;
    /** Optional: minimum effective strength to include in results */
    readonly minStrength?: MappingStrengthValue;
}

// ─── Edge Loader Abstraction ─────────────────────────────────────────

/**
 * Function that loads outgoing mapping edges for a given requirement ID.
 * This abstraction decouples the resolution engine from the data source.
 *
 * For production: wraps RequirementMappingRepository.findBySourceRequirement
 * For testing: can return canned data directly
 */
export type MappingEdgeLoader = (
    sourceRequirementId: string,
) => Promise<ResolvedMappingEdge[]>;

// ─── Resolution Engine ──────────────────────────────────────────────

/**
 * Compute the effective strength of a path using the weakest-link principle.
 * The overall strength is the minimum strength across all edges.
 */
export function computeEffectiveStrength(edges: readonly MappingPathEdge[]): MappingStrengthValue {
    if (edges.length === 0) return 'RELATED';

    let minRank = Infinity;
    let minStrength: MappingStrengthValue = 'EQUAL';

    for (const edge of edges) {
        const rank = MAPPING_STRENGTH_RANK[edge.strength];
        if (rank < minRank) {
            minRank = rank;
            minStrength = edge.strength;
        }
    }

    return minStrength;
}

/**
 * Convert a ResolvedMappingEdge to a MappingPathEdge with depth annotation.
 */
function toPathEdge(edge: ResolvedMappingEdge, depth: number): MappingPathEdge {
    return {
        id: edge.id,
        depth,
        strength: edge.strength,
        rationale: edge.rationale,
        source: {
            requirementId: edge.source.requirementId,
            requirementCode: edge.source.requirementCode,
            requirementTitle: edge.source.requirementTitle,
            frameworkKey: edge.source.frameworkKey,
            frameworkName: edge.source.frameworkName,
        },
        target: {
            requirementId: edge.target.requirementId,
            requirementCode: edge.target.requirementCode,
            requirementTitle: edge.target.requirementTitle,
            frameworkKey: edge.target.frameworkKey,
            frameworkName: edge.target.frameworkName,
        },
    };
}

/**
 * Resolve all mapping paths from a source requirement using BFS.
 *
 * Algorithm:
 * 1. Initialize BFS queue with the source requirement
 * 2. For each requirement in the queue, load its outgoing edges
 * 3. For each edge target not already visited, create a path and enqueue
 * 4. Continue until queue is empty or max depth is reached
 * 5. Sort results by depth (ascending), then effective strength (descending)
 *
 * Cycle detection: A visited set tracks all requirement IDs already expanded.
 * Once a requirement is expanded, it is never expanded again (even if reached
 * via a different path). This ensures termination and avoids exponential blowup.
 *
 * Strongest shortest path: a requirement reached a second time AT THE SAME
 * DEPTH by a stronger path replaces the path recorded for it (#5305). BFS
 * finds every path of length d+1 while it expands depth d, before any node of
 * depth d+1 is expanded, so the replacement also reaches everything below it.
 * Keeping the first path instead made the result depend on edge order: S
 * RELATED→ X EQUAL→ T beat S EQUAL→ Y EQUAL→ T whenever the loader returned
 * S→X first, and the gap report showed T as REVIEW_NEEDED, not COVERED. A
 * LONGER path is never preferred, whatever its strength: depth ranks first.
 *
 * @param query - The traceability query
 * @param loadEdges - Function to load outgoing edges for a requirement
 * @returns Complete trace result with all discovered paths
 */
export async function resolveMapping(
    query: TraceabilityQuery,
    loadEdges: MappingEdgeLoader,
): Promise<MappingTraceResult> {
    const maxDepth = Math.min(
        Math.max(query.maxDepth ?? DEFAULT_MAX_DEPTH, 1),
        ABSOLUTE_MAX_DEPTH,
    );
    const targetFrameworkKeys = query.targetFrameworkKeys?.length
        ? query.targetFrameworkKeys
        : null;
    const minStrengthRank = query.minStrength
        ? MAPPING_STRENGTH_RANK[query.minStrength]
        : 0;

    // ─── BFS State ───────────────────────────────────────────────
    // visited: set of requirement IDs already expanded (cycle prevention)
    // queue: BFS frontier — each entry is (requirementId, pathSoFar, currentDepth)
    const visited = new Set<string>();
    visited.add(query.sourceRequirementId);

    interface QueueEntry {
        requirementId: string;
        pathEdges: MappingPathEdge[];
        depth: number;
    }

    const queue: QueueEntry[] = [{
        requirementId: query.sourceRequirementId,
        pathEdges: [],
        depth: 0,
    }];

    const allPaths: MappingPath[] = [];

    /**
     * The path recorded for each requirement reached, so a stronger path of the
     * SAME depth found later can replace it: the queue entry (not yet expanded,
     * by BFS order) and the reported path (when it matched the framework filter).
     */
    const reached = new Map<string, { depth: number; rank: number; entry: QueueEntry; pathIndex: number | null }>();

    // Source info — will be populated from the first edge that references the source
    let sourceInfo: MappingTraceResult['source'] | null = null;

    // ─── BFS Loop ────────────────────────────────────────────────
    while (queue.length > 0) {
        const current = queue.shift()!;

        // Don't expand beyond max depth
        if (current.depth >= maxDepth) continue;

        // Load outgoing edges for the current requirement
        const edges = await loadEdges(current.requirementId);

        for (const edge of edges) {
            const targetReqId = edge.target.requirementId;

            // Capture source info from the very first edge loaded
            if (!sourceInfo && current.depth === 0) {
                sourceInfo = {
                    requirementId: edge.source.requirementId,
                    requirementCode: edge.source.requirementCode,
                    requirementTitle: edge.source.requirementTitle,
                    frameworkKey: edge.source.frameworkKey,
                    frameworkName: edge.source.frameworkName,
                };
            }

            const pathEdge = toPathEdge(edge, current.depth + 1);
            const newPath = [...current.pathEdges, pathEdge];

            // Compute effective strength for the full path
            const effectiveStrength = computeEffectiveStrength(newPath);
            const effectiveRank = MAPPING_STRENGTH_RANK[effectiveStrength];

            // Already reached (cycle detection) — unless by a weaker path of
            // the same depth, which this stronger one replaces (#5305).
            if (visited.has(targetReqId)) {
                const prior = reached.get(targetReqId);
                if (prior && prior.depth === current.depth + 1 && effectiveRank > prior.rank) {
                    prior.rank = effectiveRank;
                    prior.entry.pathEdges = newPath;
                    if (prior.pathIndex !== null) {
                        allPaths[prior.pathIndex] = {
                            ...allPaths[prior.pathIndex],
                            edges: newPath,
                            effectiveStrength,
                            effectiveStrengthRank: effectiveRank,
                        };
                    }
                }
                continue;
            }

            // Apply minimum strength filter
            if (effectiveRank < minStrengthRank) continue;

            // Build the mapping path
            const mappingPath: MappingPath = {
                target: {
                    requirementId: targetReqId,
                    requirementCode: edge.target.requirementCode,
                    requirementTitle: edge.target.requirementTitle,
                    frameworkKey: edge.target.frameworkKey,
                    frameworkName: edge.target.frameworkName,
                },
                edges: newPath,
                depth: newPath.length,
                isDirect: newPath.length === 1,
                effectiveStrength,
                effectiveStrengthRank: effectiveRank,
            };

            // Apply target framework filter
            const matchesFramework = !targetFrameworkKeys ||
                targetFrameworkKeys.includes(edge.target.frameworkKey);

            const pathIndex = matchesFramework ? allPaths.push(mappingPath) - 1 : null;

            // Mark as visited and enqueue for further expansion
            // (even if filtered out by framework — it might lead to valid targets)
            visited.add(targetReqId);
            const entry: QueueEntry = {
                requirementId: targetReqId,
                pathEdges: newPath,
                depth: current.depth + 1,
            };
            reached.set(targetReqId, {
                depth: entry.depth,
                rank: effectiveRank,
                entry,
                pathIndex,
            });
            queue.push(entry);
        }
    }

    // ─── Sort Results ────────────────────────────────────────────
    // Primary: depth ascending (direct before transitive)
    // Secondary: effective strength rank descending (strongest first)
    // Tertiary: target requirement code alphabetically (determinism)
    allPaths.sort((a, b) => {
        if (a.depth !== b.depth) return a.depth - b.depth;
        if (a.effectiveStrengthRank !== b.effectiveStrengthRank) {
            return b.effectiveStrengthRank - a.effectiveStrengthRank;
        }
        return a.target.requirementCode.localeCompare(b.target.requirementCode);
    });

    // ─── Compute Statistics ──────────────────────────────────────
    const uniqueTargets = new Set(allPaths.map(p => p.target.requirementId));
    const uniqueFrameworks = new Set(allPaths.map(p => p.target.frameworkKey));
    const directPaths = allPaths.filter(p => p.isDirect).length;
    const maxDepthReached = allPaths.length > 0
        ? Math.max(...allPaths.map(p => p.depth))
        : 0;

    // Fallback source info if no edges were found
    if (!sourceInfo) {
        sourceInfo = {
            requirementId: query.sourceRequirementId,
            requirementCode: '<unknown>',
            requirementTitle: '<unknown>',
            frameworkKey: '<unknown>',
            frameworkName: '<unknown>',
        };
    }

    return {
        source: sourceInfo,
        paths: allPaths,
        config: {
            maxDepth,
            targetFrameworkKeys: targetFrameworkKeys ? [...targetFrameworkKeys] : null,
            minStrength: query.minStrength ?? null,
        },
        stats: {
            totalPaths: allPaths.length,
            directPaths,
            transitivePaths: allPaths.length - directPaths,
            maxDepthReached,
            uniqueTargetRequirements: uniqueTargets.size,
            uniqueTargetFrameworks: uniqueFrameworks.size,
        },
    };
}

/**
 * Resolve mappings for multiple source requirements in batch.
 * Useful for gap analysis across an entire framework.
 *
 * Uses bounded parallelism (chunks of BATCH_CONCURRENCY) to reduce
 * latency while avoiding overwhelming the database connection pool.
 */
const BATCH_CONCURRENCY = 10;

export async function resolveMappingBatch(
    queries: TraceabilityQuery[],
    loadEdges: MappingEdgeLoader,
): Promise<MappingTraceResult[]> {
    const results: MappingTraceResult[] = [];

    for (let i = 0; i < queries.length; i += BATCH_CONCURRENCY) {
        const chunk = queries.slice(i, i + BATCH_CONCURRENCY);
        const chunkResults = await Promise.all(
            chunk.map(query => resolveMapping(query, loadEdges)),
        );
        results.push(...chunkResults);
    }

    return results;
}
