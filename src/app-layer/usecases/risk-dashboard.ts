/**
 * RQ3-9 — Risk-dashboard orchestrator.
 *
 * Collapses the six independent fetches the dashboard used to fire
 * on mount (risks list, analytics, coherence, staleness, appetite,
 * latest simulation, + matrix config) into a single batched read
 * fan-out via `Promise.all`. The page-side `useEffect` waterfall
 * (every widget owning its own fetch + setState + failure-soft
 * branch) reduces to one `useTenantSWR` call with one cache key
 * and one loading state.
 *
 * Why orchestrate at the usecase layer:
 *   - Each constituent already enforces tenant isolation +
 *     permission gates; the orchestrator inherits them transparently.
 *   - The page can keep its existing per-widget failure-soft
 *     semantics — every slot is independently nullable, so a slow
 *     simulation row never blocks staleness from rendering.
 *   - The matrix config rides along so the heatmap renders the
 *     CANONICAL band colours per tenant, killing the hand-rolled
 *     `getStatusTone(s, 'score-0-25')` ladder the dashboard used.
 *
 * Failure-soft contract: a thrown branch becomes `null` in the
 * payload. The page treats null as "data not available yet" rather
 * than "the whole dashboard is broken" — same shape it already had,
 * just batched.
 */
import { RequestContext } from '../types';
import { assertCanRead } from '../policies/common';
import { listRisks } from './risk';
import {
    getRiskQuantitativeAnalytics,
    getRiskCoherence,
    type RiskQuantitativeAnalytics,
} from './risk-analytics';
import { getRiskStaleness, type StalenessReport } from './risk-staleness';
import { getAppetiteConfig, getAppetiteStatus } from './risk-appetite';
import { getLatestSimulation } from './monte-carlo';
import { getRiskMatrixConfig } from './risk-matrix-config';
import type { RiskMatrixConfigShape } from '@/lib/risk-matrix/types';
import type { CoherenceReport } from '@/lib/risk-coherence';

export interface DashboardRisk {
    id: string;
    title: string;
    category: string | null;
    status: string;
    treatmentOwner: string | null;
    score: number;
    inherentScore: number;
    likelihood: number;
    impact: number;
    nextReviewAt: string | null;
}

/** Inferred from getLatestSimulation — the persisted simulation row. */
type LatestSimulationPayload = Awaited<ReturnType<typeof getLatestSimulation>>;

/** Mirrors the legacy /risk-appetite GET shape so the dashboard's
 *  MonteCarloPanel consumes the same `{ config, status }` envelope
 *  it used pre-RQ3-9. */
export interface DashboardAppetitePayload {
    config: Awaited<ReturnType<typeof getAppetiteConfig>>;
    status: Awaited<ReturnType<typeof getAppetiteStatus>>;
}

export interface DashboardPayload {
    /** Bare list — the page derives KPIs, status mix, heatmap counts. */
    risks: DashboardRisk[];
    /** Quantitative analytics — null when the source threw / nothing quantified. */
    analytics: RiskQuantitativeAnalytics | null;
    coherence: CoherenceReport | null;
    staleness: StalenessReport | null;
    /** Appetite envelope — config + live status, mirrors the legacy
     *  /risk-appetite endpoint shape so the MonteCarloPanel consumes
     *  the same `{ config, status }` it used pre-RQ3-9. */
    appetite: DashboardAppetitePayload | null;
    /** Latest simulation run, null when nothing has been simulated. */
    simulation: LatestSimulationPayload | null;
    /** Canonical matrix config so the heatmap renders the tenant's bands. */
    matrix: RiskMatrixConfigShape;
    /**
     * #4768 — the slots whose branch threw. A thrown branch becomes `null`
     * (or `[]` for risks), which on its own reads exactly like "nothing to
     * show"; this list is how the page tells the two apart.
     */
    failed: DashboardSlot[];
}

export type DashboardSlot = 'risks' | 'analytics' | 'coherence' | 'staleness' | 'appetite' | 'simulation';

/**
 * One read per dashboard mount instead of six. Each constituent
 * runs in parallel via `Promise.allSettled` so a slow one cannot
 * stall the rest, and a thrown one becomes `null` in the response
 * — matching the legacy per-widget failure-soft contract.
 */
export async function getRiskDashboard(ctx: RequestContext): Promise<DashboardPayload> {
    assertCanRead(ctx);

    // The constituents are all read-only; running them in parallel
    // is safe (no write contention) and dominates the latency
    // budget the legacy waterfall paid for serially on the client.
    const [
        risksRes,
        analyticsRes,
        coherenceRes,
        stalenessRes,
        appetiteConfigRes,
        appetiteStatusRes,
        simulationRes,
        matrixRes,
    ] = await Promise.allSettled([
        listRisks(ctx),
        getRiskQuantitativeAnalytics(ctx),
        getRiskCoherence(ctx),
        getRiskStaleness(ctx),
        getAppetiteConfig(ctx),
        getAppetiteStatus(ctx),
        getLatestSimulation(ctx),
        getRiskMatrixConfig(ctx),
    ]);

    // The appetite slot is a `{ config, status }` envelope; if EITHER
    // side rejected we surface null (same shape as the legacy
    // endpoint when it 5xx'd, same null-handling the MonteCarloPanel
    // already has).
    const appetite: DashboardAppetitePayload | null =
        appetiteConfigRes.status === 'fulfilled' && appetiteStatusRes.status === 'fulfilled'
            ? { config: appetiteConfigRes.value, status: appetiteStatusRes.value }
            : null;

    const failed: DashboardSlot[] = [];
    if (risksRes.status === 'rejected') failed.push('risks');
    if (analyticsRes.status === 'rejected') failed.push('analytics');
    if (coherenceRes.status === 'rejected') failed.push('coherence');
    if (stalenessRes.status === 'rejected') failed.push('staleness');
    if (appetite === null) failed.push('appetite');
    if (simulationRes.status === 'rejected') failed.push('simulation');

    return {
        failed,
        risks: risksRes.status === 'fulfilled' ? (risksRes.value as DashboardRisk[]) : [],
        analytics: analyticsRes.status === 'fulfilled' ? analyticsRes.value : null,
        coherence: coherenceRes.status === 'fulfilled' ? coherenceRes.value : null,
        staleness: stalenessRes.status === 'fulfilled' ? stalenessRes.value : null,
        appetite,
        simulation: simulationRes.status === 'fulfilled' ? simulationRes.value : null,
        // Matrix MUST resolve — `getRiskMatrixConfig` itself returns
        // a cloned default on a missing row, so a rejected promise
        // here is genuinely exceptional. We still treat it as fatal
        // because the heatmap can't render without bands.
        matrix:
            matrixRes.status === 'fulfilled'
                ? matrixRes.value
                : (() => {
                      throw matrixRes.reason;
                  })(),
    };
}
