/**
 * The wire shapes of `GET /processes/:id/risk-facts` and `…/asset-facts`.
 *
 * Dependency-free, like `control-facts-types.ts`, so the canvas (a client
 * bundle) and the usecases (which reach the database) share one definition.
 */

/** Which score a risk card leads with: residual when assessed, else inherent. */
export type RiskScoreKind = 'RESIDUAL' | 'INHERENT';

export interface RiskFact {
    id: string;
    key: string | null;
    title: string;
    status: string;
    treatment: string | null;
    /** The leading score: residual when one is set, else inherent. */
    score: number;
    scoreKind: RiskScoreKind;
    inherentScore: number;
    /** The tenant matrix's band for `score`, or null when no band covers it. */
    band: { name: string; color: string } | null;
    /** True when `nextReviewAt` has passed. */
    reviewOverdue: boolean;
    /**
     * How many of the risk's live mitigating controls (`RiskControl`) are
     * placed on this map, on a control node or a connection, as last saved.
     * `total` 0 means the risk has no mitigating control at all.
     */
    mitigation: { onMap: number; total: number };
}

export interface ProcessMapRiskFacts {
    /** True when the caller may read the map but not risks. */
    restricted: boolean;
    risks: Record<string, RiskFact>;
    missing: string[];
}

export interface AssetFact {
    id: string;
    key: string | null;
    name: string;
    type: string;
    criticality: string | null;
    status: string;
}

export interface ProcessMapAssetFacts {
    /** True when the caller may read the map but not assets. */
    restricted: boolean;
    assets: Record<string, AssetFact>;
    missing: string[];
}
