/**
 * THE HARNESS MATRIX — read usecases behind the harness tab on
 * `/agents/reports` (#3687, step 1a of the agentic IAM roadmap).
 *
 * READ-ONLY. This module calls `findMany`, `findFirst` and `count` and nothing
 * else: the scan, its items and the discovered agents are written by
 * `agent-harness-scans.ts` alone, acceptances by `agent-harness-acceptance.ts`
 * alone, review-run owner suggestions by `agent-harness-attribution.ts` alone
 * (`tests/guards/agent-harness-single-write-seam.test.ts`). It logs
 * nothing either — a report's content is the client's data, not a log line.
 *
 * ── WHAT "LATEST" MEANS ─────────────────────────────────────────────────────
 *
 * The scan whose `asOf` is newest (ties: received later, then id) — the order
 * `listHarnessScans` returns. A report backfilled for an earlier moment and
 * received last does not become "latest". The accept affordance still follows
 * `DiscoveredAgent.lastLevel` because that is what `acceptHarnessShortfall`
 * reads; where the two disagree, the row says so (`latestIngestedLevel`).
 *
 * ── DRIFT COMPARES A SCANNER ONLY WITH ITSELF ───────────────────────────────
 *
 * A tenant may run several scanners over different sources. Comparing scanner
 * A's latest scan with scanner B's previous one would report every agent only
 * one of them can see as "newly seen" or dropped, so each section's baseline is
 * the previous scan BY THE SAME `scannerAgentId`, complete or not — the panel
 * states each side's completeness rather than hiding an incomplete baseline.
 *
 * ── FAIL CLOSED ─────────────────────────────────────────────────────────────
 *
 *   • stored sources that do not re-validate make the scan INCOMPLETE, and
 *     every agent in it NOT JUDGED (the shared model's `SOURCES_UNREADABLE`);
 *   • stored verdicts that do not re-validate make every cell UNANSWERED and
 *     the agent NOT JUDGED, with no level (`VERDICTS_UNREADABLE`);
 *   • stored model endpoints that do not re-validate read UNREADABLE, never
 *     as "not reported" and never as "none";
 *   • a register row deleted after a scan linked it is SHADOW again;
 *   • every read has a `take:` one past its cap, so truncation is a fact held
 *     rather than one nobody can observe;
 *   • a section's rows are chosen "worst first" — the shared model's order,
 *     `compareHarnessMatrixRows`: not judged, then below the bar, then at it;
 *     within each the lowest level first; then by id — only from the WHOLE of
 *     its latest scan's stored agents. The latest scans' agents are read on their
 *     own, before and apart from the previous scans' (which only drift needs),
 *     and a latest scan whose agents were not all read shows no rows and says
 *     so (`rowsUnread`) — the worst of a prefix is not the worst of the scan;
 *   • an empty shadow list reads as "none" only when EVERY trusted scanner's
 *     latest scan is complete: one scanner's complete scan says nothing about
 *     the sources another reads, and a scanner holding a key with no scan in
 *     the window has read nothing anybody can see. The unregistered-identity
 *     list is the same read split in two, and holds the same rule.
 *
 * ── SHADOW AGENT, OR UNREGISTERED IDENTITY ──────────────────────────────────
 *
 * A principal with no live register row is one or the other (owner decisions,
 * 2026-11-13), and WHICH is read off the finding on record, by the planner's
 * own reader (`unregisteredIdentitiesOnRecord`): an identity when its
 * UNREGISTERED_IDENTITY finding is the one open, a shadow agent otherwise.
 * Never from the stored scan rows — an incomplete scan overwrites those, and
 * the ingest deliberately does not let one move the class. An identity keeps
 * its matrix row, level and cells; it is held to no bar (the shared model's
 * `heldToBar` and `countsAsShortfall` are false), and is offered no shortfall
 * action or note.
 *
 * ── THE ROWS ARE THE SHARED TABLE MODEL'S ───────────────────────────────────
 *
 * Owner decision, 2026-11-13: one table model for every surface. Each row is
 * `buildHarnessMatrix`'s, from `@rodnapamet/scanent-contract` — the module
 * scanent's local results are built from — so a cell, a judgement, a level, a
 * bar and the row order are decided once for both products. This module hands
 * it the stored verdicts (`null` when they do not re-read), the stored sources
 * (`null` likewise), the register link, the class on record, and NO readers:
 * which readers a scanner ran is not stored, so no cell is NOT_READABLE and no
 * coverage is stated. Inflect's own columns (register name, acceptance, the
 * later-received level, drift, model endpoints) are joined by `discoveredId`.
 *
 * The matrix is gated on the INVENTORY READ (#3710): `admin.agent_registry_view`,
 * or the register key whose holders always could (`mayReadAgentInventory`). The
 * scanner-key view below stays on `admin.agent_registry`: it is the register of
 * whose reports the tenant believes, which that key decides, and the tab shows
 * it only to a holder.
 *
 * A reader WITHOUT the register key is offered no shortfall action: every
 * `acceptAffordance` reads `NONE` for them, because `acceptHarnessShortfall`
 * refuses a caller without that key before it asks whose agent it is — a
 * button computed for them would be shown and then refused.
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { forbidden } from '@/lib/errors/types';
import { mayReadAgentInventory } from '@/lib/permissions';
import { listHarnessScans } from './agent-harness-scans';
import {
    buildHarnessMatrix,
    compareHarnessMatrixRows,
    type HarnessMatrixAgentInput,
} from '@rodnapamet/scanent-contract/harness-matrix-model';
import {
    MAX_AGENTS,
    parseStoredHarnessModels,
    parseStoredHarnessSources,
    parseStoredHarnessTools,
    parseStoredHarnessVerdicts,
} from '@/lib/agentic/harness-contract';
import {
    HARNESS_FINDING_SOURCE_KIND,
    isIntakeClaimLinkable,
    modelSignsOf,
    shadowRefOf,
    unregisteredIdentitiesOnRecord,
    unregisteredIdentityRefOf,
} from '@/lib/agentic/harness-findings';
import type { CriterionVerdict, HarnessLevel } from '@/lib/agentic/harness-ladder';
import { acceptAffordanceFor } from '@/lib/agentic/harness-acceptance-rules';
import { storedSuggestionView } from '@/lib/agentic/review-attribution';
import {
    computeHarnessDrift,
    harnessScanCompleteness,
    type AcceptAffordance,
    type AcceptanceRow,
    type HarnessMatrixView,
    type HarnessScanRow,
    type HarnessScannerKeysView,
    type HarnessScannerSection,
    type MatrixRow,
    type ShadowRow,
} from '@/lib/agentic/harness-read-model';

/** How many of the newest scans the tab reads. */
export const SCAN_WINDOW = 50;
/** One section per scanner, for at most this many scanners. */
export const MAX_SCANNER_SECTIONS = 3;
/**
 * Items read for the shown sections' LATEST scans, to choose rows — and,
 * separately, for their PREVIOUS scans, for drift. One scan holds at most
 * `MAX_AGENTS` (the ingest refuses more), so the latest read always fits
 * whole; the previous read cannot crowd it out because it is a read of its own.
 */
export const ITEM_CAP = MAX_SCANNER_SECTIONS * MAX_AGENTS;
/** Matrix rows per section. */
export const MATRIX_ROW_CAP = 200;
export const SHADOW_CAP = 200;
export const ACCEPTANCE_CAP = 200;
/** Scanner keys listed on the tab — a tenant trusts a handful. */
export const KEY_CAP = 200;
/** Register rows offered when registering a key. */
export const CANDIDATE_CAP = 200;

function assertMayRead(ctx: RequestContext): void {
    if (!mayReadAgentInventory(ctx.appPermissions.admin)) {
        throw forbidden('Reading the harness matrix requires admin.agent_registry_view');
    }
}

function assertMayReadScannerKeys(ctx: RequestContext): void {
    if (!ctx.appPermissions.admin.agent_registry) {
        throw forbidden('Reading harness scanner keys requires admin.agent_registry');
    }
}

/**
 * The accept affordance for THIS reader: the shared rule, or `NONE` for a
 * reader who cannot accept at all (no `admin.agent_registry` — the check
 * `acceptHarnessShortfall` makes first).
 */
function affordanceFor(
    ctx: RequestContext,
    agent: Parameters<typeof acceptAffordanceFor>[0],
    acceptanceInForce: boolean,
): AcceptAffordance {
    if (!ctx.appPermissions.admin.agent_registry) return 'NONE';
    return acceptAffordanceFor(agent, ctx.userId, acceptanceInForce);
}

const pairKey = (scanId: string, discoveredAgentId: string) => `${scanId}\u0000${discoveredAgentId}`;

/** A caller-supplied bound, clamped to [1, the module's own]: it may only narrow a read. */
const narrowed = (value: number | undefined, cap: number): number =>
    Math.min(Math.max(Math.trunc(value ?? cap), 1), cap);

type LightItem = { discoveredAgentId: string; discoveredId: string; level: HarnessLevel };

/**
 * One item of a LATEST scan, read whole: everything the shared table model
 * needs to judge and rank it, and the stored level drift compares. Verdicts
 * are re-read here (`null` when they do not re-validate), because whether an
 * agent is judged at all depends on it, and the rows are chosen from the
 * whole scan by that.
 */
type LatestItem = LightItem & {
    discoveredVia: string[];
    reach: HarnessMatrixAgentInput['reach'];
    verdicts: CriterionVerdict[] | null;
};

/**
 * The model's input for one stored item. `classification` is supplied, never
 * derived: the register link as it stands now, and the class on record.
 * `linkBasis` is null because Inflect does not record which basis linked the
 * row, and payment capabilities are NOT REPORTED because Inflect stores none.
 */
function matrixInputOf(
    item: LatestItem,
    known: {
        registeredAgentId: string | null;
        unregisteredIdentity: boolean;
        modelSigns: HarnessMatrixAgentInput['modelSigns'];
    },
): HarnessMatrixAgentInput {
    return {
        discoveredId: item.discoveredId,
        discoveredVia: item.discoveredVia,
        verdicts: item.verdicts,
        reach: item.reach,
        registeredAgentId: known.registeredAgentId,
        linkBasis: null,
        unregisteredIdentity: known.unregisteredIdentity,
        modelSigns: known.modelSigns,
        paymentCapabilities: null,
    };
}

/**
 * The harness tab, as of now.
 *
 * `limits` can only LOWER the module's bounds — what the tests use to drive
 * the bounded paths without seeding thousands of rows.
 */
export async function getHarnessMatrix(
    ctx: RequestContext,
    opts: {
        now?: Date;
        scanWindow?: number;
        limits?: { sections?: number; rows?: number; items?: number; shadow?: number; acceptances?: number };
    } = {},
): Promise<HarnessMatrixView> {
    assertMayRead(ctx);
    const now = opts.now ?? new Date();
    const window = narrowed(opts.scanWindow, SCAN_WINDOW);
    const sectionCap = narrowed(opts.limits?.sections, MAX_SCANNER_SECTIONS);
    const rowCap = narrowed(opts.limits?.rows, MATRIX_ROW_CAP);
    const itemCap = narrowed(opts.limits?.items, ITEM_CAP);
    const shadowCap = narrowed(opts.limits?.shadow, SHADOW_CAP);
    const acceptanceCap = narrowed(opts.limits?.acceptances, ACCEPTANCE_CAP);

    // 1. The window, through the existing list usecase, one past the cap.
    const listed = await listHarnessScans(ctx, { take: window + 1 });
    const scansTruncated = listed.length > window;
    const scanned = listed.slice(0, window);
    const scannerIds = [...new Set(scanned.map((s) => s.scannerAgentId))];

    return runInTenantContext(ctx, async (db) => {
        const scanners = scannerIds.length === 0
            ? []
            : await db.registeredAgent.findMany({
                where: { tenantId: ctx.tenantId, id: { in: scannerIds } },
                select: { id: true, name: true },
                take: scannerIds.length,
            });
        const scannerName = new Map(scanners.map((s) => [s.id, s.name]));

        const scanRows: HarnessScanRow[] = scanned.map((s) => {
            const sources = parseStoredHarnessSources(s.sourcesJson);
            return {
                id: s.id,
                scanRef: s.scanRef,
                scannerAgentId: s.scannerAgentId,
                scannerName: scannerName.get(s.scannerAgentId) ?? null,
                scannerVersion: s.scannerVersion,
                asOf: s.asOf.toISOString(),
                ingestedAt: s.createdAt.toISOString(),
                completeness: harnessScanCompleteness({
                    complete: s.complete,
                    agentCount: s.agentCount,
                    sourcesReadable: sources !== null,
                }),
                agentCount: s.agentCount,
                sources,
            };
        });

        // 2. One section per scanner, by its newest scan's position.
        const byScanner = new Map<string, HarnessScanRow[]>();
        for (const row of scanRows) {
            const list = byScanner.get(row.scannerAgentId) ?? [];
            list.push(row);
            byScanner.set(row.scannerAgentId, list);
        }
        const shown = [...byScanner.entries()].slice(0, sectionCap);
        const scannersNotShown = byScanner.size - shown.length;

        // 3a. The trusted scanners — an unrevoked key — with no scan in the
        // window: their sources are unread as far as this page can see.
        const keyHolders = await db.agentHarnessScannerKey.findMany({
            where: { tenantId: ctx.tenantId, revokedAt: null },
            select: { agentId: true, agent: { select: { name: true, deletedAt: true } } },
            distinct: ['agentId'],
            orderBy: { agentId: 'asc' },
            take: KEY_CAP + 1,
        });
        const keyHoldersTruncated = keyHolders.length > KEY_CAP;
        const scannersWithoutScan = keyHolders
            .slice(0, KEY_CAP)
            .filter((k) => !byScanner.has(k.agentId))
            .map((k) => ({ agentId: k.agentId, name: k.agent.deletedAt === null ? k.agent.name : null }));

        // 3b. Items, in two reads. The LATEST scans' first — they choose the
        // rows, and must be read whole — then the PREVIOUS scans', which only
        // drift needs. One read for both let the previous scans' items crowd
        // the latest ones out of the bound. The latest read carries what the
        // shared table model judges an agent by (its verdicts and the kinds it
        // was found through), because the rows are the worst of the WHOLE scan
        // by the model's order, and "not judged" sorts first.
        const latestRead = async (scanIds: string[]) => {
            if (scanIds.length === 0) return { byScan: new Map<string, LatestItem[]>(), overBound: false };
            const read = await db.agentHarnessScanItem.findMany({
                where: { tenantId: ctx.tenantId, scanId: { in: scanIds } },
                select: {
                    scanId: true,
                    discoveredAgentId: true,
                    level: true,
                    reach: true,
                    verdictsJson: true,
                    discoveredAgent: { select: { discoveredId: true, discoveredVia: true } },
                },
                orderBy: [{ scanId: 'asc' }, { discoveredAgentId: 'asc' }],
                take: itemCap + 1,
            });
            const byScan = new Map<string, LatestItem[]>();
            for (const i of read.slice(0, itemCap)) {
                const list = byScan.get(i.scanId) ?? [];
                list.push({
                    discoveredAgentId: i.discoveredAgentId,
                    discoveredId: i.discoveredAgent.discoveredId,
                    discoveredVia: i.discoveredAgent.discoveredVia,
                    level: i.level,
                    reach: i.reach,
                    verdicts: parseStoredHarnessVerdicts(i.verdictsJson),
                });
                byScan.set(i.scanId, list);
            }
            return { byScan, overBound: read.length > itemCap };
        };
        const previousRead = async (scanIds: string[]) => {
            if (scanIds.length === 0) return { byScan: new Map<string, LightItem[]>(), overBound: false };
            const read = await db.agentHarnessScanItem.findMany({
                where: { tenantId: ctx.tenantId, scanId: { in: scanIds } },
                select: {
                    scanId: true,
                    discoveredAgentId: true,
                    level: true,
                    discoveredAgent: { select: { discoveredId: true } },
                },
                orderBy: [{ scanId: 'asc' }, { discoveredAgentId: 'asc' }],
                take: itemCap + 1,
            });
            const byScan = new Map<string, LightItem[]>();
            for (const i of read.slice(0, itemCap)) {
                const list = byScan.get(i.scanId) ?? [];
                list.push({
                    discoveredAgentId: i.discoveredAgentId,
                    discoveredId: i.discoveredAgent.discoveredId,
                    level: i.level,
                });
                byScan.set(i.scanId, list);
            }
            return { byScan, overBound: read.length > itemCap };
        };
        const latestLight = await latestRead(shown.map(([, list]) => list[0].id));
        const previousLight = await previousRead(
            shown.flatMap(([, list]) => (list[1] ? [list[1].id] : [])),
        );
        // A scan's agents were read whole when the stored items read for it
        // number exactly its own count — the same test the evidence emitter
        // applies before it states a tally.
        const readWhole = (light: { byScan: Map<string, readonly LightItem[]> }, scan: HarnessScanRow) =>
            (light.byScan.get(scan.id) ?? []).length === scan.agentCount;

        // 3c. Drift and the rows to show, in memory.
        const planned = shown.map(([scannerAgentId, list]) => {
            const latest = list[0];
            const previous = list[1] ?? null;
            const baseline: HarnessScannerSection['baseline'] = previous
                ? 'PREVIOUS_SCAN'
                : scansTruncated ? 'OUTSIDE_WINDOW' : 'FIRST_SCAN';
            const latestWhole = readWhole(latestLight, latest);
            const latestItems = latestWhole ? latestLight.byScan.get(latest.id) ?? [] : [];
            const comparable = previous !== null && latestWhole && readWhole(previousLight, previous);
            const drift = previous !== null && comparable
                ? computeHarnessDrift(
                    { ...latest, items: latestItems },
                    { ...previous, items: previousLight.byScan.get(previous.id) ?? [] },
                )
                : null;
            const driftUnavailableReason: HarnessScannerSection['driftUnavailableReason'] =
                previous === null ? (baseline === 'OUTSIDE_WINDOW' ? 'OUTSIDE_WINDOW' : 'FIRST_SCAN')
                    : !comparable ? 'POPULATION_OVER_BOUND' : null;
            // The rows are chosen by the SHARED model's order over the whole
            // scan. Its order reads the judgement, the level and where the
            // level stands against the bar its reach carries — never the class
            // or the register link — so this ranking pass supplies neither;
            // the rows shown are built again below with both.
            const ranking = buildHarnessMatrix({
                sources: latest.sources,
                agents: latestItems.map((i) =>
                    matrixInputOf(i, { registeredAgentId: null, unregisteredIdentity: false, modelSigns: [] }),
                ),
            });
            const idOf = new Map(latestItems.map((i) => [i.discoveredId, i.discoveredAgentId]));
            const displayIds = [...ranking.rows]
                .sort(compareHarnessMatrixRows)
                .slice(0, rowCap)
                .flatMap((r) => {
                    const id = idOf.get(r.discoveredId);
                    return id === undefined ? [] : [id];
                });
            return {
                scannerAgentId,
                latest,
                previous,
                baseline,
                drift,
                driftUnavailableReason,
                displayIds,
                itemBy: new Map(latestItems.map((i) => [i.discoveredAgentId, i])),
                rowsUnread: !latestWhole,
            };
        });

        // 3d. The rest of the displayed rows only. Never the owner reference or
        // the owner kind: the tab renders neither. The tools are read to state
        // the model's signs and do not leave the server; the model endpoints
        // the tab does render (#3759) go as text.
        const withRows = planned.filter((p) => p.displayIds.length > 0);
        const heavy = withRows.length === 0
            ? []
            : await db.agentHarnessScanItem.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    OR: withRows.map((p) => ({ scanId: p.latest.id, discoveredAgentId: { in: p.displayIds } })),
                },
                select: {
                    scanId: true,
                    discoveredAgentId: true,
                    toolsJson: true,
                    modelsJson: true,
                    discoveredAgent: {
                        select: {
                            id: true,
                            discoveredId: true,
                            lastLevel: true,
                            lastReach: true,
                            lastScanId: true,
                            registeredAgent: { select: { id: true, name: true, ownerUserId: true, deletedAt: true } },
                        },
                    },
                },
                take: withRows.reduce((n, p) => n + p.displayIds.length, 0),
            });
        const heavyBy = new Map(heavy.map((h) => [pairKey(h.scanId, h.discoveredAgentId), h]));

        // 3e. Acceptances in force for the displayed agents. Never the
        // justification or who accepted: the row shows only the expiry.
        const displayedAgents = [...new Set(planned.flatMap((p) => p.displayIds))];
        const inForceRows = displayedAgents.length === 0
            ? []
            : await db.agentHarnessAcceptance.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    discoveredAgentId: { in: displayedAgents },
                    revokedAt: null,
                    expiresAt: { gt: now },
                },
                select: { id: true, discoveredAgentId: true, expiresAt: true, acceptedLevel: true, renewedFromId: true },
                orderBy: { expiresAt: 'desc' },
                take: displayedAgents.length * 4,
            });
        const inForceBy = new Map<string, (typeof inForceRows)[number]>();
        for (const a of inForceRows) if (!inForceBy.has(a.discoveredAgentId)) inForceBy.set(a.discoveredAgentId, a);

        // 3f. Acceptances still on the clock: the calendar's population, so
        // every calendar deep-link lands on a row.
        const clockRead = await db.agentHarnessAcceptance.findMany({
            where: { tenantId: ctx.tenantId, revokedAt: null, expiryProcessedAt: null },
            select: {
                id: true,
                discoveredAgentId: true,
                expiresAt: true,
                acceptedLevel: true,
                discoveredAgent: {
                    select: {
                        discoveredId: true,
                        lastLevel: true,
                        lastReach: true,
                        registeredAgent: { select: { name: true, ownerUserId: true, deletedAt: true } },
                    },
                },
            },
            orderBy: { expiresAt: 'asc' },
            take: acceptanceCap + 1,
        });
        // One row per agent, its latest expiry: a lapsed acceptance a later
        // renewal superseded is not a second clock.
        const latestClock = new Map<string, (typeof clockRead)[number]>();
        for (const a of clockRead.slice(0, acceptanceCap)) {
            const seen = latestClock.get(a.discoveredAgentId);
            if (!seen || a.expiresAt.getTime() > seen.expiresAt.getTime()) latestClock.set(a.discoveredAgentId, a);
        }
        const clockRows = [...latestClock.values()].sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());

        // 3g. Every principal with no live register row: never registered, or
        // whose register row was deleted after the scan linked it (the FK does
        // not null on a soft delete). Split below into the shadow list and the
        // unregistered-identity list by the finding on record.
        const shadowRead = await db.discoveredAgent.findMany({
            where: {
                tenantId: ctx.tenantId,
                OR: [{ registeredAgentId: null }, { registeredAgent: { deletedAt: { not: null } } }],
            },
            select: {
                id: true,
                discoveredId: true,
                discoveredVia: true,
                firstSeenAt: true,
                lastSeenAt: true,
                lastLevel: true,
                registeredAgentId: true,
            },
            orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }],
            take: shadowCap + 1,
        });
        const shadowShown = shadowRead.slice(0, shadowCap);
        // 3h. The findings on record for every principal this page shows with
        // no live register row: the two lists' rows, the matrix rows and the
        // acceptance clock's agents. ONE read, never one per row. It answers
        // two things: which class each is on record as (shadow agent, or
        // unregistered identity — `unregisteredIdentitiesOnRecord`, the rule
        // every reader of the record shares), and which finding the Register
        // action registers from (#3712).
        const isUnlinked = (register: { deletedAt: Date | null } | null) => register === null || register.deletedAt !== null;
        const unlinkedShown = [
            ...new Set([
                ...shadowShown.map((d) => d.discoveredId),
                ...heavy.filter((h) => isUnlinked(h.discoveredAgent.registeredAgent)).map((h) => h.discoveredAgent.discoveredId),
                ...clockRows.filter((a) => isUnlinked(a.discoveredAgent.registeredAgent)).map((a) => a.discoveredAgent.discoveredId),
            ]),
        ];
        const shadowFindings = unlinkedShown.length === 0
            ? []
            : await db.finding.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    sourceKind: HARNESS_FINDING_SOURCE_KIND,
                    sourceRef: { in: unlinkedShown.flatMap((id) => [shadowRefOf(id), unregisteredIdentityRefOf(id)]) },
                    deletedAt: null,
                },
                select: { id: true, sourceRef: true, status: true },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                take: unlinkedShown.length * 4,
            });
        const findingByRef = new Map<string, string>();
        for (const f of shadowFindings) if (f.sourceRef && !findingByRef.has(f.sourceRef)) findingByRef.set(f.sourceRef, f.id);
        const identitiesOnRecord = unregisteredIdentitiesOnRecord(shadowFindings);

        const acceptanceRows: AcceptanceRow[] = clockRows.map((a) => {
            const register = a.discoveredAgent.registeredAgent;
            const inForce = a.expiresAt.getTime() > now.getTime();
            return {
                id: a.id,
                discoveredAgentId: a.discoveredAgentId,
                agentLabel: register && register.deletedAt === null ? register.name : a.discoveredAgent.discoveredId,
                acceptedLevel: a.acceptedLevel,
                expiresAt: a.expiresAt.toISOString(),
                inForce,
                acceptAffordance: affordanceFor(
                    ctx,
                    {
                        ...a.discoveredAgent,
                        unregisteredIdentity: isUnlinked(register) && identitiesOnRecord.has(a.discoveredAgent.discoveredId),
                    },
                    inForce,
                ),
            };
        });
        const intakeRows = shadowShown.length === 0
            ? []
            : await db.registeredAgent.findMany({
                where: { tenantId: ctx.tenantId, intakeDiscoveredAgentId: { in: shadowShown.map((d) => d.id) } },
                select: { id: true, name: true, status: true, deletedAt: true, intakeDiscoveredAgentId: true },
                take: shadowShown.length,
            });
        const intakeBy = new Map(intakeRows.map((r) => [r.intakeDiscoveredAgentId, r]));
        // 3i. The review runs' owner suggestions (#3728), one per agent at
        // most (unique per discovered agent). NEVER `proposedOwnerRef`: this
        // view crosses into a client component, and the person a suggestion
        // named stays on the server — the intake reads it to compare, nothing
        // else does. Only what the dialog shows is selected.
        const suggestionRows = shadowShown.length === 0
            ? []
            : await db.discoveredAgentAttribution.findMany({
                where: { tenantId: ctx.tenantId, discoveredAgentId: { in: shadowShown.map((d) => d.id) } },
                select: {
                    discoveredAgentId: true,
                    runId: true,
                    runCompletedAt: true,
                    status: true,
                    grade: true,
                    unmatchedReason: true,
                    signalsJson: true,
                },
                take: shadowShown.length,
            });
        const suggestionBy = new Map(suggestionRows.map((r) => [r.discoveredAgentId, storedSuggestionView(r)]));
        const unregisteredRows: ShadowRow[] = shadowShown.map((d) => {
            const intake = intakeBy.get(d.id);
            const identity = identitiesOnRecord.has(d.discoveredId);
            const shadowFinding = findingByRef.get(shadowRefOf(d.discoveredId));
            const identityFinding = findingByRef.get(unregisteredIdentityRefOf(d.discoveredId));
            return {
                kind: identity ? 'UNREGISTERED_IDENTITY' : 'SHADOW_AGENT',
                discoveredAgentId: d.id,
                discoveredId: d.discoveredId,
                discoveredVia: d.discoveredVia,
                firstSeenAt: d.firstSeenAt.toISOString(),
                lastSeenAt: d.lastSeenAt.toISOString(),
                lastLevel: d.lastLevel,
                reason: d.registeredAgentId === null ? 'UNREGISTERED' : 'REGISTER_ROW_DELETED',
                // The intake takes either finding. An identity's is its own; a
                // shadow agent that never had a SHADOW_AGENT finding (it was an
                // identity, was registered, and its row was deleted) registers
                // from the identity finding it had.
                findingId: (identity ? identityFinding : (shadowFinding ?? identityFinding)) ?? null,
                intake: intake
                    ? {
                        agentId: intake.id,
                        name: intake.deletedAt === null ? intake.name : null,
                        linkable: isIntakeClaimLinkable({ status: intake.status, deleted: intake.deletedAt !== null }),
                    }
                    : null,
                suggestion: suggestionBy.get(d.id) ?? null,
            };
        });
        // One bounded read, two lists: the class is the finding on record.
        const shadowRows = unregisteredRows.filter((r) => r.kind === 'SHADOW_AGENT');
        const identityRows = unregisteredRows.filter((r) => r.kind === 'UNREGISTERED_IDENTITY');

        // 4. The sections. Each one's rows are the SHARED model's, built over
        // the displayed agents with the register link as it stands and the
        // class on record, in the order the ranking chose — the model keeps
        // the order it is given, and neither input moves a row in its order.
        // Inflect's own columns are joined to each row by `discoveredId`.
        const sections: HarnessScannerSection[] = planned.map((p) => {
            type Shown = { item: LatestItem; heavy: (typeof heavy)[number]; register: { id: string; name: string } | null };
            const shownRows: Shown[] = [];
            for (const id of p.displayIds) {
                const item = p.itemBy.get(id);
                const h = heavyBy.get(pairKey(p.latest.id, id));
                if (!item || !h) continue;
                const live = h.discoveredAgent.registeredAgent;
                shownRows.push({ item, heavy: h, register: live && live.deletedAt === null ? live : null });
            }
            const matrix = buildHarnessMatrix({
                sources: p.latest.sources,
                agents: shownRows.map(({ item, heavy: h, register }) => {
                    const models = parseStoredHarnessModels(h.modelsJson);
                    return matrixInputOf(item, {
                        registeredAgentId: register?.id ?? null,
                        unregisteredIdentity: register === null && identitiesOnRecord.has(item.discoveredId),
                        // The planner's own reader of the signs, over the
                        // columns as stored. A column that does not re-read
                        // contributes no sign: the row does not render signs,
                        // and its class is the finding on record, not these.
                        modelSigns: modelSignsOf({
                            discoveredVia: item.discoveredVia,
                            tools: parseStoredHarnessTools(h.toolsJson) ?? [],
                            models: models.state === 'REPORTED' ? models.endpoints : null,
                        }),
                    });
                }),
            });
            const rows: MatrixRow[] = shownRows.map(({ item, heavy: h, register }, index) => {
                const da = h.discoveredAgent;
                const accepted = inForceBy.get(item.discoveredAgentId);
                const model = matrix.rows[index];
                return {
                    discoveredAgentId: item.discoveredAgentId,
                    matrix: model,
                    registered: register ? { agentId: register.id, name: register.name } : null,
                    models: parseStoredHarnessModels(h.modelsJson),
                    latestIngestedLevel:
                        da.lastScanId !== p.latest.id && da.lastLevel !== item.level ? da.lastLevel : null,
                    acceptance: accepted
                        ? {
                            id: accepted.id,
                            expiresAt: accepted.expiresAt.toISOString(),
                            acceptedLevel: accepted.acceptedLevel,
                            renewal: accepted.renewedFromId !== null,
                        }
                        : null,
                    acceptAffordance: affordanceFor(
                        ctx,
                        { ...da, unregisteredIdentity: model.classification === 'UNREGISTERED_IDENTITY' },
                        accepted !== undefined,
                    ),
                };
            });
            return {
                scannerAgentId: p.scannerAgentId,
                scannerName: p.latest.scannerName,
                latest: p.latest,
                previous: p.previous,
                baseline: p.baseline,
                drift: p.drift,
                driftUnavailableReason: p.driftUnavailableReason,
                rows,
                rowsUnread: p.rowsUnread,
                rowsTruncated: !p.rowsUnread && rows.length < p.latest.agentCount,
            };
        });

        // "No shadow agent" is a claim about the whole estate, so it needs
        // EVERY trusted scanner's latest scan complete — the rule the evidence
        // emitter holds for the month (`harnessIncompleteReasons`). As of the
        // OLDEST of them: the estate is evidenced only as far as every scanner
        // has read it.
        const everyScannerComplete =
            sections.length > 0 &&
            scannersNotShown === 0 &&
            scannersWithoutScan.length === 0 &&
            !keyHoldersTruncated &&
            sections.every((s) => s.latest.completeness === 'COMPLETE');
        const oldestLatest = sections.map((s) => s.latest.asOf).sort()[0] ?? null;
        return {
            generatedAt: now.toISOString(),
            scanWindow: window,
            scans: { rows: scanRows, truncated: scansTruncated },
            sections,
            scannersNotShown,
            scannersWithoutScan: { rows: scannersWithoutScan, truncated: keyHoldersTruncated },
            shadow: {
                rows: shadowRows,
                truncated: shadowRead.length > shadowCap,
                basis: everyScannerComplete ? 'EVIDENCED' : 'NOT_EVIDENCED',
                basisAsOf: everyScannerComplete ? oldestLatest : null,
            },
            unregisteredIdentities: {
                rows: identityRows,
                truncated: shadowRead.length > shadowCap,
                basis: everyScannerComplete ? 'EVIDENCED' : 'NOT_EVIDENCED',
                basisAsOf: everyScannerComplete ? oldestLatest : null,
            },
            acceptances: { rows: acceptanceRows, truncated: clockRead.length > acceptanceCap },
        };
    });
}

/**
 * The scanner-key register on the harness tab, and the agents a new key may be
 * registered for.
 *
 * Read here rather than through `listHarnessScannerKeys`, which returns the
 * `createdByUserId` / `revokedByUserId` columns the API caller is entitled to:
 * this view crosses into a client component, and no user id does. The public
 * key's own bytes stay behind too — the fingerprint is what identifies a key.
 *
 * Candidates are the rows `addHarnessScannerKey` would accept: live and not
 * RETIRED. Offering a retired agent would put a choice on screen the API
 * refuses.
 */
export async function getHarnessScannerKeysView(ctx: RequestContext): Promise<HarnessScannerKeysView> {
    assertMayReadScannerKeys(ctx);
    return runInTenantContext(ctx, async (db) => {
        const keys = await db.agentHarnessScannerKey.findMany({
            where: { tenantId: ctx.tenantId },
            select: {
                id: true,
                agentId: true,
                keyFingerprint: true,
                createdAt: true,
                revokedAt: true,
                agent: { select: { name: true, deletedAt: true } },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: KEY_CAP + 1,
        });
        const candidates = await db.registeredAgent.findMany({
            where: { tenantId: ctx.tenantId, deletedAt: null, status: { not: 'RETIRED' } },
            select: { id: true, name: true },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            take: CANDIDATE_CAP + 1,
        });
        return {
            keys: {
                rows: keys.slice(0, KEY_CAP).map((k) => ({
                    id: k.id,
                    agentId: k.agentId,
                    agentName: k.agent.deletedAt === null ? k.agent.name : null,
                    keyFingerprint: k.keyFingerprint,
                    createdAt: k.createdAt.toISOString(),
                    revokedAt: k.revokedAt ? k.revokedAt.toISOString() : null,
                })),
                truncated: keys.length > KEY_CAP,
            },
            candidates: {
                rows: candidates.slice(0, CANDIDATE_CAP),
                truncated: candidates.length > CANDIDATE_CAP,
            },
        };
    });
}
