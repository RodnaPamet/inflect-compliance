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
 *   • stored sources that do not re-validate make the scan INCOMPLETE;
 *   • stored verdicts that do not re-validate make every cell UNANSWERED;
 *   • a register row deleted after a scan linked it is SHADOW again;
 *   • every read has a `take:` one past its cap, so truncation is a fact held
 *     rather than one nobody can observe;
 *   • a section's rows are chosen "worst first" only from the WHOLE of its
 *     latest scan's stored agents. The latest scans' agents are read on their
 *     own, before and apart from the previous scans' (which only drift needs),
 *     and a latest scan whose agents were not all read shows no rows and says
 *     so (`rowsUnread`) — the worst of a prefix is not the worst of the scan;
 *   • an empty shadow list reads as "none" only when EVERY trusted scanner's
 *     latest scan is complete: one scanner's complete scan says nothing about
 *     the sources another reads, and a scanner holding a key with no scan in
 *     the window has read nothing anybody can see.
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
import { MAX_AGENTS, parseStoredHarnessSources, parseStoredHarnessVerdicts } from '@/lib/agentic/harness-contract';
import {
    HARNESS_FINDING_SOURCE_KIND,
    harnessBarFor,
    isHarnessShortfall,
    isIntakeClaimLinkable,
    shadowRefOf,
} from '@/lib/agentic/harness-findings';
import { collapseVerdicts, type HarnessLevel } from '@/lib/agentic/harness-ladder';
import { acceptAffordanceFor } from '@/lib/agentic/harness-acceptance-rules';
import { storedSuggestionView } from '@/lib/agentic/review-attribution';
import {
    compareMatrixRows,
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

type LightItem = { discoveredAgentId: string; discoveredId: string; level: HarnessLevel; reach: MatrixRow['reach'] };

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

        // 3b. Light items, in two reads. The LATEST scans' first — they choose
        // the rows, and must be read whole — then the PREVIOUS scans', which
        // only drift needs. One read for both let the previous scans' items
        // crowd the latest ones out of the bound.
        const readLight = async (scanIds: string[]) => {
            if (scanIds.length === 0) return { byScan: new Map<string, LightItem[]>(), overBound: false };
            const read = await db.agentHarnessScanItem.findMany({
                where: { tenantId: ctx.tenantId, scanId: { in: scanIds } },
                select: {
                    scanId: true,
                    discoveredAgentId: true,
                    level: true,
                    reach: true,
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
                    reach: i.reach,
                });
                byScan.set(i.scanId, list);
            }
            return { byScan, overBound: read.length > itemCap };
        };
        const latestLight = await readLight(shown.map(([, list]) => list[0].id));
        const previousLight = await readLight(
            shown.flatMap(([, list]) => (list[1] ? [list[1].id] : [])),
        );
        // A scan's agents were read whole when the stored items read for it
        // number exactly its own count — the same test the evidence emitter
        // applies before it states a tally.
        const readWhole = (light: { byScan: Map<string, LightItem[]> }, scan: HarnessScanRow) =>
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
            const displayIds = latestItems
                .map((i) => ({ ...i, belowBar: isHarnessShortfall(i.level, i.reach) }))
                .sort(compareMatrixRows)
                .slice(0, rowCap)
                .map((i) => i.discoveredAgentId);
            return {
                scannerAgentId,
                latest,
                previous,
                baseline,
                drift,
                driftUnavailableReason,
                displayIds,
                rowsUnread: !latestWhole,
            };
        });

        // 3d. Heavy items for the displayed rows only. Never the owner reference,
        // the owner kind or the tools: the tab renders none of them.
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
                    level: true,
                    reach: true,
                    blockingNextRung: true,
                    verdictsJson: true,
                    discoveredAgent: {
                        select: {
                            id: true,
                            discoveredId: true,
                            discoveredVia: true,
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
        const acceptanceRows: AcceptanceRow[] = [...latestClock.values()]
            .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
            .map((a) => {
                const register = a.discoveredAgent.registeredAgent;
                const inForce = a.expiresAt.getTime() > now.getTime();
                return {
                    id: a.id,
                    discoveredAgentId: a.discoveredAgentId,
                    agentLabel: register && register.deletedAt === null ? register.name : a.discoveredAgent.discoveredId,
                    acceptedLevel: a.acceptedLevel,
                    expiresAt: a.expiresAt.toISOString(),
                    inForce,
                    acceptAffordance: affordanceFor(ctx, a.discoveredAgent, inForce),
                };
            });

        // 3g. The shadow list: never registered, or whose register row was
        // deleted after the scan linked it (the FK does not null on a soft delete).
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
        // 3h. What the Register action needs (#3712), read-only: each shown
        // agent's SHADOW_AGENT finding, and the intake row already made from
        // it. One read each, never one per row.
        const shadowFindings = shadowShown.length === 0
            ? []
            : await db.finding.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    sourceKind: HARNESS_FINDING_SOURCE_KIND,
                    sourceRef: { in: shadowShown.map((d) => shadowRefOf(d.discoveredId)) },
                    deletedAt: null,
                },
                select: { id: true, sourceRef: true },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                take: shadowShown.length * 2,
            });
        const findingByRef = new Map<string, string>();
        for (const f of shadowFindings) if (f.sourceRef && !findingByRef.has(f.sourceRef)) findingByRef.set(f.sourceRef, f.id);
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
        const shadowRows: ShadowRow[] = shadowShown.map((d) => {
            const intake = intakeBy.get(d.id);
            return {
                discoveredAgentId: d.id,
                discoveredId: d.discoveredId,
                discoveredVia: d.discoveredVia,
                firstSeenAt: d.firstSeenAt.toISOString(),
                lastSeenAt: d.lastSeenAt.toISOString(),
                lastLevel: d.lastLevel,
                reason: d.registeredAgentId === null ? 'UNREGISTERED' : 'REGISTER_ROW_DELETED',
                findingId: findingByRef.get(shadowRefOf(d.discoveredId)) ?? null,
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

        // 4. The sections.
        const sections: HarnessScannerSection[] = planned.map((p) => {
            const rows: MatrixRow[] = [];
            for (const id of p.displayIds) {
                const item = heavyBy.get(pairKey(p.latest.id, id));
                if (!item) continue;
                const da = item.discoveredAgent;
                const verdicts = parseStoredHarnessVerdicts(item.verdictsJson);
                const register = da.registeredAgent && da.registeredAgent.deletedAt === null ? da.registeredAgent : null;
                const accepted = inForceBy.get(id);
                rows.push({
                    discoveredAgentId: id,
                    discoveredId: da.discoveredId,
                    discoveredVia: da.discoveredVia,
                    registered: register ? { agentId: register.id, name: register.name } : null,
                    level: item.level,
                    reach: item.reach,
                    belowBar: isHarnessShortfall(item.level, item.reach),
                    bar: harnessBarFor(item.reach),
                    blockingNextRung: item.blockingNextRung,
                    verdicts: verdicts === null ? [] : [...collapseVerdicts(verdicts).values()],
                    verdictsUnreadable: verdicts === null,
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
                    acceptAffordance: affordanceFor(ctx, da, accepted !== undefined),
                });
            }
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
