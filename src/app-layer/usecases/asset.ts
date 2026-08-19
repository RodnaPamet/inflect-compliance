import { RequestContext } from '../types';
import { AssetRepository, AssetListParams, AssetFilters } from '../repositories/AssetRepository';
import { TaskRepository } from '../repositories/TaskRepository';
import type { TaskLinkEntityType, AssetType, AssetStatus, Prisma } from '@prisma/client';
import { assertCanRead, assertCanWrite, assertCanAdmin } from '../policies/common';
import { logEvent } from '../events/audit';
import { notFound, badRequest } from '@/lib/errors/types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import { createAssignmentNotification } from '../notifications/assignment';
import { logger } from '@/lib/observability';
import { criticalityToEnum } from '@/lib/asset-criticality';

/**
 * CVSS-severity / scanner-finding-severity labels ranked so the two OPEN
 * vulnerability sources (CVE `AssetVulnerability` + `ScannerFinding`) fold
 * into one "worst OPEN severity" per asset. Unknown / null labels rank 0.
 */
const SEVERITY_RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

/** Return whichever of two severity labels is worse (higher-ranked); null when both are absent. */
function worseSeverity(a: string | null | undefined, b: string | null | undefined): string | null {
    const ra = a ? SEVERITY_RANK[a] ?? 0 : 0;
    const rb = b ? SEVERITY_RANK[b] ?? 0 : 0;
    return rb > ra ? b ?? null : a ?? null;
}

/**
 * Attach the list-row rollups to a set of asset rows: linked-task counts
 * (TaskLink ASSET) + a per-asset OPEN-vulnerability rollup (count + top
 * severity). The vuln rollup folds BOTH sources the asset detail tab shows —
 * CVE `AssetVulnerability` rows AND scanner `ScannerFinding` rows resolved to
 * the asset — so the list column matches the detail tab. Everything is batched
 * over the ≤N row ids — no per-row reads. Shared by listAssets and
 * listAssetsWithDeleted so the deleted-assets view renders with the same columns.
 */
async function enrichAssetRows<T extends { id: string }>(db: PrismaTx, ctx: RequestContext, rows: T[]) {
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) {
        return rows.map((r) => ({ ...r, taskTotal: 0, taskDone: 0, openVulnCount: 0, maxVulnSeverity: null as string | null }));
    }
    const [counts, cveGroups, cveTop, scanGroups, scanSevs] = await Promise.all([
        TaskRepository.countLinkedToEntities(db, ctx, 'ASSET' as TaskLinkEntityType, ids),
        db.assetVulnerability.groupBy({
            by: ['assetId'],
            where: { tenantId: ctx.tenantId, assetId: { in: ids }, status: 'OPEN' },
            _count: { _all: true },
        }),
        // Top OPEN CVE per asset by score. `nulls: 'last'` keeps a null-scored
        // CVE from sorting AHEAD of a real CRITICAL (the DESC default is NULLS
        // FIRST) and greying the badge.
        db.assetVulnerability.findMany({ // guardrail-allow: unbounded — distinct ['assetId'] yields ≤1 row per listed asset.
            where: { tenantId: ctx.tenantId, assetId: { in: ids }, status: 'OPEN' },
            distinct: ['assetId'],
            orderBy: [{ assetId: 'asc' }, { cve: { cvssScore: { sort: 'desc', nulls: 'last' } } }],
            select: { assetId: true, cve: { select: { cvssSeverity: true } } },
        }),
        db.scannerFinding.groupBy({
            by: ['assetId'],
            where: { tenantId: ctx.tenantId, assetId: { in: ids }, status: 'OPEN' },
            _count: { _all: true },
        }),
        db.scannerFinding.findMany({ // guardrail-allow: unbounded — distinct ['assetId','severity'] yields ≤4 rows per listed asset.
            where: { tenantId: ctx.tenantId, assetId: { in: ids }, status: 'OPEN' },
            distinct: ['assetId', 'severity'],
            select: { assetId: true, severity: true },
        }),
    ]);

    // OPEN-vuln count = CVE vulnerabilities + scanner findings.
    const cveCountByAsset = new Map(cveGroups.map((g) => [g.assetId, g._count._all]));
    const scanCountByAsset = new Map(
        scanGroups.filter((g) => g.assetId).map((g) => [g.assetId as string, g._count._all]),
    );

    // Worst OPEN severity per asset, folded across both sources.
    const sevByAsset = new Map<string, string | null>();
    for (const v of cveTop) sevByAsset.set(v.assetId, v.cve?.cvssSeverity ?? null);
    for (const s of scanSevs) {
        if (!s.assetId) continue;
        sevByAsset.set(s.assetId, worseSeverity(sevByAsset.get(s.assetId) ?? null, s.severity));
    }

    return rows.map((r) => ({
        ...r,
        taskTotal: counts.get(r.id)?.total ?? 0,
        taskDone: counts.get(r.id)?.done ?? 0,
        openVulnCount: (cveCountByAsset.get(r.id) ?? 0) + (scanCountByAsset.get(r.id) ?? 0),
        maxVulnSeverity: sevByAsset.get(r.id) ?? null,
    }));
}

export async function listAssets(
    ctx: RequestContext,
    filters?: AssetFilters,
    options: { take?: number } = {},
) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const rows = await AssetRepository.list(db, ctx, filters, options);
        return enrichAssetRows(db, ctx, rows);
    });
}

/**
 * KPI-card counts by aggregate. Separate from `listAssets` because the two
 * answer different questions: the list is filter-scoped by design, and these
 * deliberately are not — `total` ignores filters entirely, and each card
 * excludes the dimension its click replaces.
 */
export async function listAssetKpiCounts(ctx: RequestContext, filters?: AssetFilters) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) => AssetRepository.kpiCounts(db, ctx, filters));
}

export async function listAssetsPaginated(ctx: RequestContext, params: AssetListParams) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        AssetRepository.listPaginated(db, ctx, params)
    );
}

export interface AssetRollups {
    risks: { count: number };
    controls: { count: number };
    vulnerabilities: { openCount: number; maxSeverity: string | null; maxScore: number | null };
    tasks: { openCount: number; total: number };
}

/**
 * 360° relationship roll-ups for the asset-detail Overview band. Every
 * aggregate is a bounded single query (count / findFirst) fanned out with
 * Promise.all — no reads-in-a-loop, no unbounded findMany. The OPEN-vuln
 * severity is the CVSS severity of the highest-scoring OPEN vulnerability.
 */
async function computeAssetRollups(
    db: PrismaTx,
    ctx: RequestContext,
    assetId: string,
): Promise<AssetRollups> {
    const [riskCount, controlCount, cveOpenCount, topOpenVuln, scanOpenCount, scanSevs, taskCounts] = await Promise.all([
        db.assetRiskLink.count({ where: { tenantId: ctx.tenantId, assetId } }),
        db.controlAsset.count({ where: { tenantId: ctx.tenantId, assetId } }),
        db.assetVulnerability.count({ where: { tenantId: ctx.tenantId, assetId, status: 'OPEN' } }),
        db.assetVulnerability.findFirst({
            where: { tenantId: ctx.tenantId, assetId, status: 'OPEN' },
            // `nulls: 'last'` — a null-scored CVE must not outrank a real CRITICAL.
            orderBy: [{ cve: { cvssScore: { sort: 'desc', nulls: 'last' } } }],
            select: { cve: { select: { cvssSeverity: true, cvssScore: true } } },
        }),
        db.scannerFinding.count({ where: { tenantId: ctx.tenantId, assetId, status: 'OPEN' } }),
        db.scannerFinding.findMany({ // guardrail-allow: unbounded — distinct ['severity'] yields ≤4 rows for one asset.
            where: { tenantId: ctx.tenantId, assetId, status: 'OPEN' },
            distinct: ['severity'],
            select: { severity: true },
        }),
        TaskRepository.countLinkedToEntities(db, ctx, 'ASSET' as TaskLinkEntityType, [assetId]),
    ]);
    const tc = taskCounts.get(assetId) ?? { total: 0, done: 0 };
    // Fold the worst scanner-finding severity into the CVE max so the detail
    // rollup reflects the true worst OPEN vuln from either source.
    const scanWorst = scanSevs.reduce<string | null>((acc, s) => worseSeverity(acc, s.severity), null);
    return {
        risks: { count: riskCount },
        controls: { count: controlCount },
        vulnerabilities: {
            openCount: cveOpenCount + scanOpenCount,
            maxSeverity: worseSeverity(topOpenVuln?.cve?.cvssSeverity ?? null, scanWorst),
            maxScore: topOpenVuln?.cve?.cvssScore ?? null,
        },
        tasks: { openCount: tc.total - tc.done, total: tc.total },
    };
}

export async function getAsset(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const asset = await AssetRepository.getById(db, ctx, id);
        if (!asset) throw notFound('Asset not found');
        const rollups = await computeAssetRollups(db, ctx, id);
        return { ...asset, rollups };
    });
}

/**
 * Asset activity trail — the tenant's audit-log entries for THIS asset,
 * newest first. Mirrors `getControlActivity`: bounded with `take:`, joins
 * the actor's display name, RLS-scoped via `runInTenantContext`. Asset
 * mutations (CREATE / UPDATE / SOFT_DELETE / evidence link-unlink) log with
 * `entity: 'Asset'`, so this feed reflects them without extra wiring.
 */
export async function getAssetActivity(ctx: RequestContext, assetId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const asset = await AssetRepository.getById(db, ctx, assetId);
        if (!asset) throw notFound('Asset not found');
        return db.auditLog.findMany({
            where: { tenantId: ctx.tenantId, entity: 'Asset', entityId: assetId },
            orderBy: { createdAt: 'desc' },
            take: 50,
            include: { user: { select: { id: true, name: true } } },
        });
    });
}

// Asset create/update input — mirrors CreateAssetSchema/UpdateAssetSchema, but
// written by hand because those schemas use `z.coerce` (input type `unknown`) and
// the usecase is also called directly in tests before the write gate. `type` is
// optional so the permission-gate test path (which throws before validation) holds.
interface CreateAssetInput {
    name: string;
    // The Prisma enum, not `string`. This interface is hand-maintained
    // alongside `CreateAssetSchema`, and the two had drifted: the schema
    // said `z.string()`, this said `string`, and the payload cast to
    // `AssetType` — three declarations agreeing only that the type was
    // unchecked, so an unknown member reached the driver and 500'd.
    // (Deriving this from the schema outright belongs with the asset-DTO
    // rehoming; the enum is the part that was actually broken.)
    type?: AssetType;
    status?: 'ACTIVE' | 'RETIRED';
    classification?: string | null;
    owner?: string | null;
    ownerUserId?: string | null;
    location?: string | null;
    confidentiality?: number;
    integrity?: number;
    availability?: number;
    dependencies?: string | null;
    businessProcesses?: string | null;
    dataResidency?: string | null;
    retention?: string | null;
    // Structured retention-expiry date (YYYY-MM-DD or ISO) — coerced to a Date.
    retentionUntil?: string | null;
    // External-system reference (CMDB id, ticket key, …).
    externalRef?: string | null;
    // Product-identity fields — power CVE→asset matching.
    cpe?: string | null;
    vendor?: string | null;
    product?: string | null;
    version?: string | null;
}
type UpdateAssetInput = Partial<CreateAssetInput>;

/**
 * Reject an ownerUserId that is not an ACTIVE member of the tenant. The owner
 * FK is only NULL-checked by the DB, so an arbitrary — or another tenant's —
 * user id would otherwise be written as the asset's owner. Tenant-scoped +
 * status-filtered so a removed or invited-but-inactive member can't be
 * assigned. Throws `badRequest` (400) on a non-member id.
 */
async function assertActiveOwner(db: PrismaTx, tenantId: string, ownerUserId: string) {
    const member = await db.tenantMembership.findFirst({
        where: { tenantId, userId: ownerUserId, status: 'ACTIVE' },
        select: { userId: true },
    });
    if (!member) throw badRequest('Owner must be an active member of this tenant');
}

export async function createAsset(ctx: RequestContext, data: CreateAssetInput) {
    assertCanWrite(ctx);

    // Derive-on-write — the stored `Asset.criticality` enum is the single
    // source of truth read by the KPI, the filter, and the detail chip. Any
    // undefined C/I/A dimension defaults to 3 (the column default), so the
    // persisted level matches the badge the UI derives from the same triad.
    const createC = data.confidentiality ?? 3;
    const createI = data.integrity ?? 3;
    const createA = data.availability ?? 3;

    return runInTenantContext(ctx, async (db) => {
        if (data.ownerUserId) await assertActiveOwner(db, ctx.tenantId, data.ownerUserId);
        const asset = await AssetRepository.create(db, ctx, {
            name: data.name,
            type: data.type as AssetType,
            ...(data.status ? { status: data.status } : {}),
            classification: data.classification,
            owner: data.owner,
            ownerUserId: data.ownerUserId || null,
            location: data.location,
            confidentiality: data.confidentiality,
            integrity: data.integrity,
            availability: data.availability,
            criticality: criticalityToEnum(createC, createI, createA),
            dependencies: data.dependencies,
            businessProcesses: data.businessProcesses,
            dataResidency: data.dataResidency,
            retention: data.retention,
            retentionUntil: data.retentionUntil ? new Date(data.retentionUntil) : null,
            externalRef: data.externalRef,
            cpe: data.cpe,
            vendor: data.vendor,
            product: data.product,
            version: data.version,
        });

        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'Asset',
            entityId: asset.id,
            details: `Created asset: ${asset.name}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Asset',
                operation: 'created',
                after: { name: asset.name, type: data.type, classification: data.classification },
                summary: `Created asset: ${asset.name}`,
            },
        });

        return asset;
    });
}

/**
 * A cleared text field must land as NULL, not `''`.
 *
 * The edit form sends EVERY field on every submit (its defaults are `''`,
 * `useEditAssetForm.ts`), while the create form omits empties. Passed
 * straight through, that difference wrote `''` into eleven nullable
 * columns whenever a user cleared one — so "no location" was stored two
 * different ways depending on which form you used, and `IS NULL` filters
 * silently missed the edited rows.
 *
 * Three states, deliberately: `undefined` leaves the column untouched,
 * `''` clears it, any other string is written as-is.
 */
function emptyToNull(value: string | null | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return value.trim() === '' ? null : value;
}

export async function updateAsset(ctx: RequestContext, id: string, data: UpdateAssetInput) {
    assertCanWrite(ctx);

    const { asset: updated, previousOwnerId } = await runInTenantContext(ctx, async (db) => {
        // Capture the prior assignee so the notification only fires on
        // an actual change, not on every unrelated asset edit.
        const before = await AssetRepository.getById(db, ctx, id);
        const previousOwnerId = before?.ownerUserId ?? null;

        // Validate a newly-supplied owner (non-empty string) is an active
        // member. `undefined` leaves it unchanged; `''`/null clears it — neither
        // needs a membership check.
        if (data.ownerUserId) await assertActiveOwner(db, ctx.tenantId, data.ownerUserId);

        // Re-derive the stored criticality from the effective C/I/A triad
        // (this-edit value ?? prior value ?? default 3). Always recomputing
        // — even on a status-only PATCH — self-heals rows whose stored enum
        // predates derive-on-write, and keeps it agreeing with the badge.
        const updC = data.confidentiality ?? before?.confidentiality ?? 3;
        const updI = data.integrity ?? before?.integrity ?? 3;
        const updA = data.availability ?? before?.availability ?? 3;

        const asset = await AssetRepository.update(db, ctx, id, {
            name: data.name,
            // `UpdateAssetSchema` validates this against the real enum, so
            // no cast is needed and an unknown value 400s at the boundary
            // instead of reaching Prisma.
            type: data.type,
            // The detail-page status control and the edit modal both send
            // this; omitting it here meant both returned 200 OK and changed
            // nothing. `createAsset` and `bulkSetAssetStatus` always wrote it.
            status: data.status,
            classification: emptyToNull(data.classification),
            owner: emptyToNull(data.owner),
            // "Assigned to" — undefined leaves it untouched; '' or null
            // clears (an empty string would be an invalid FK).
            ownerUserId:
                data.ownerUserId === undefined
                    ? undefined
                    : data.ownerUserId || null,
            location: emptyToNull(data.location),
            confidentiality: data.confidentiality,
            integrity: data.integrity,
            availability: data.availability,
            criticality: criticalityToEnum(updC, updI, updA),
            dependencies: emptyToNull(data.dependencies),
            businessProcesses: emptyToNull(data.businessProcesses),
            dataResidency: emptyToNull(data.dataResidency),
            retention: emptyToNull(data.retention),
            // Three-state: undefined → leave unchanged; empty/null → clear;
            // non-empty string → date. (The edit form always sends the field,
            // as '' when cleared, so '' must map to null — not `new Date('')`.)
            retentionUntil:
                data.retentionUntil === undefined
                    ? undefined
                    : data.retentionUntil
                        ? new Date(data.retentionUntil)
                        : null,
            externalRef: emptyToNull(data.externalRef),
            cpe: emptyToNull(data.cpe),
            vendor: emptyToNull(data.vendor),
            product: emptyToNull(data.product),
            version: emptyToNull(data.version),
        });

        if (!asset) throw notFound('Asset not found');

        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'Asset',
            entityId: id,
            details: `Asset updated`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Asset',
                operation: 'updated',
                changedFields: Object.keys(data).filter(k => (data as unknown as Record<string, unknown>)[k] !== undefined),
                after: { name: data.name, type: data.type, classification: data.classification },
                summary: `Asset updated`,
            },
        });

        return { asset, previousOwnerId };
    });

    // In-app ASSET_ASSIGNED bell notification for the new owner — only
    // when the assignee actually changed to a real user. After-commit,
    // own short transaction, fire-and-forget, day-granular dedupe.
    const newOwnerId = updated.ownerUserId ?? null;
    if (newOwnerId && newOwnerId !== previousOwnerId && ctx.tenantSlug) {
        const tenantSlug = ctx.tenantSlug;
        try {
            await runInTenantContext(ctx, (db) =>
                createAssignmentNotification(db, 'ASSET_ASSIGNED', {
                    tenantId: ctx.tenantId,
                    assigneeUserId: newOwnerId,
                    entityId: id,
                    entityLabel: updated.name ?? '(untitled)',
                    entityKey: null,
                    tenantSlug,
                }),
            );
        } catch (err) {
            logger.warn('failed to create asset-assigned notification', {
                component: 'notifications',
                assetId: id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return updated;
}

// ─── Bulk import (CSV → one request) ───

export interface AssetImportResult {
    created: number;
    skipped: number;
    createdIds: string[];
    errors: { row: number; name: string; message: string }[];
    /** Per-row dedupe skips with a reason code: `existing` (name already in the
     *  tenant) or `duplicateInFile` (repeated earlier in the same CSV). */
    skippedRows: { row: number; name: string; reason: 'existing' | 'duplicateInFile' }[];
}

/**
 * Bulk-create assets from a parsed CSV in ONE request (replacing N sequential
 * client POSTs). Two honesty fixes over the old per-row POST loop:
 *
 *   • **Dedupe by name.** Rows whose (case-insensitive) name already exists in
 *     the tenant — or repeats earlier in the same batch — are skipped, not
 *     blindly re-created. Re-importing the same CSV is now idempotent.
 *   • **Owner resolution.** A free-text `owner` cell is resolved to a real
 *     `ownerUserId` against the tenant roster (by member name OR email,
 *     case-insensitive). On a match the assignee is set and the free-text is
 *     dropped; with no match the free-text is kept as a clearly-secondary
 *     fallback. `criticality` is NOT taken from the CSV — createAsset derives
 *     it from the CIA triad (the single source of truth).
 *
 * The writes are BATCHED: after an in-memory validation + normalisation pass
 * (name-required, dedupe, owner resolution, derive-on-write criticality), the
 * surviving rows are inserted in ONE transaction — a single N-wide key
 * allocation, one `createManyAndReturn`, and the per-asset CREATE audit chain.
 * A 500-row CSV is one transaction, not 500 serial ones. Per-row VALIDATION
 * errors are isolated (collected before the insert); a DB-level failure rolls
 * the batch back.
 */
export async function bulkImportAssets(
    ctx: RequestContext,
    rows: CreateAssetInput[],
): Promise<AssetImportResult> {
    assertCanWrite(ctx);

    // One up-front read pass: the existing-name set (dedupe) + the member
    // roster (owner resolution). Everything else is in-memory.
    const { existingNames, ownerByKey, memberIds } = await runInTenantContext(ctx, async (db) => {
        // `deletedAt: null` matches the DB constraint this dedupe stands in
        // for: `Asset_tenantId_name_key` is PARTIAL (WHERE "deletedAt" IS
        // NULL), added precisely so a name can be reused after a soft
        // delete. Without the filter the import skipped such a row as
        // "existing" and reported it to the user as a duplicate — refusing
        // an insert the database would have accepted, and defeating the
        // point of the partial index.
        const existing = await db.asset.findMany({ // guardrail-allow: unbounded — dedupe needs the full tenant name set; selects `name` only (tiny rows).
            where: { tenantId: ctx.tenantId, deletedAt: null },
            select: { name: true },
        });
        const members = await db.tenantMembership.findMany({
            where: { tenantId: ctx.tenantId, status: 'ACTIVE' },
            select: { userId: true, user: { select: { name: true, email: true } } },
        });
        const ownerByKey = new Map<string, string>();
        const memberIds = new Set<string>();
        for (const m of members) {
            memberIds.add(m.userId);
            const name = m.user?.name?.trim().toLowerCase();
            const email = m.user?.email?.trim().toLowerCase();
            if (name) ownerByKey.set(name, m.userId);
            if (email) ownerByKey.set(email, m.userId);
        }
        return { existingNames: existing.map((a: { name: string }) => a.name), ownerByKey, memberIds };
    });

    // Case-INSENSITIVE on purpose, and deliberately stricter than the DB's
    // case-sensitive unique index: an import that creates "Prod DB" beside
    // an existing "prod db" produces two rows for one asset, which the
    // constraint would happily allow. Being stricter can only skip a row
    // (reported back to the user), never corrupt one — the asymmetry is
    // documented on the model in `assets.prisma`.
    //
    // `createAsset` takes the other side of that trade: it does no dedupe
    // and lets the constraint answer, which is why a duplicate create
    // returns 409 rather than being silently folded into the existing row.
    const existingSet = new Set(existingNames.map((n) => n.trim().toLowerCase()));
    const seen = new Set(existingSet);
    const result: AssetImportResult = { created: 0, skipped: 0, createdIds: [], errors: [], skippedRows: [] };

    // ─── In-memory validation + normalisation pass (NO writes) ───
    // Per-row validation errors + dedupe skips are isolated here, BEFORE any
    // write, so one bad row never sinks the batch. Each surviving row is
    // normalised into the exact create payload (owner resolved, criticality
    // derived from the CIA triad — the single source of truth).
    const prepared: { name: string; data: Prisma.AssetUncheckedCreateInput }[] = [];
    let i = 0;
    for (const row of rows) {
        i += 1;
        const nameLc = row.name?.trim().toLowerCase() ?? '';
        if (!nameLc) {
            result.errors.push({ row: i, name: row.name ?? '', message: 'Name is required' });
            continue;
        }
        if (seen.has(nameLc)) {
            result.skipped += 1;
            result.skippedRows.push({
                row: i,
                name: row.name ?? '',
                reason: existingSet.has(nameLc) ? 'existing' : 'duplicateInFile',
            });
            continue;
        }
        seen.add(nameLc);

        // Resolve a free-text owner to a real member; keep free-text only as a
        // fallback when it matches no one.
        let ownerUserId = row.ownerUserId ?? null;
        let owner = row.owner ?? null;
        // Never write an explicit ownerUserId that isn't an active member of
        // this tenant (a forged / cross-tenant id) — drop it and let the
        // free-text `owner` resolution below still apply as a fallback.
        if (ownerUserId && !memberIds.has(ownerUserId)) ownerUserId = null;
        if (!ownerUserId && owner) {
            const match = ownerByKey.get(owner.trim().toLowerCase());
            if (match) {
                ownerUserId = match;
                owner = null;
            }
        }

        const c = row.confidentiality ?? 3;
        const iScore = row.integrity ?? 3;
        const a = row.availability ?? 3;

        prepared.push({
            name: row.name,
            data: {
                name: row.name,
                type: row.type as AssetType,
                ...(row.status ? { status: row.status as AssetStatus } : {}),
                classification: row.classification,
                owner: owner ?? undefined,
                ownerUserId,
                location: row.location,
                confidentiality: row.confidentiality,
                integrity: row.integrity,
                availability: row.availability,
                criticality: criticalityToEnum(c, iScore, a),
                dependencies: row.dependencies,
                businessProcesses: row.businessProcesses,
                dataResidency: row.dataResidency,
                retention: row.retention,
                retentionUntil: row.retentionUntil ? new Date(row.retentionUntil) : null,
                externalRef: row.externalRef,
                cpe: row.cpe,
                vendor: row.vendor,
                product: row.product,
                version: row.version,
                tenantId: ctx.tenantId,
            },
        });
    }

    if (prepared.length === 0) return result;

    // ─── ONE transaction: batched key allocation + batched insert + audit ───
    // (was N per-row transactions, each with its own key upsert + insert +
    // audit). A generous timeout covers the per-row audit hash-chain on large
    // batches. A DB-level failure rolls the whole batch back — the validation
    // pass above catches the common bad-row cases first.
    const created = await runInTenantContext(
        ctx,
        async (db) => {
            // Allocate N keys in ONE counter round-trip (was one upsert/row).
            const seq = await db.assetKeySequence.upsert({
                where: { tenantId: ctx.tenantId },
                create: { tenantId: ctx.tenantId, lastValue: prepared.length },
                update: { lastValue: { increment: prepared.length } },
            });
            const base = seq.lastValue - prepared.length; // AST-(base+1) … AST-(base+N)

            // Single INSERT … RETURNING. Asset carries no encrypted fields, so
            // createManyAndReturn is safe (no per-row encryption middleware to
            // bypass); the pii-middleware already handles createMany.
            const createdRows = await db.asset.createManyAndReturn({
                data: prepared.map((p, idx) => ({ ...p.data, key: `AST-${base + idx + 1}` })),
            });

            // Per-asset CREATE audit — sequential on the SAME tx db so the
            // hash-chain stays ordered (logEvent → appendAuditEntry serialises).
            for (const asset of createdRows) {
                await logEvent(db, ctx, {
                    action: 'CREATE',
                    entityType: 'Asset',
                    entityId: asset.id,
                    details: `Created asset: ${asset.name}`,
                    detailsJson: {
                        category: 'entity_lifecycle',
                        entityName: 'Asset',
                        operation: 'created',
                        after: { name: asset.name, type: asset.type, classification: asset.classification },
                        summary: `Created asset: ${asset.name}`,
                    },
                });
            }
            return createdRows;
        },
        { timeout: 30_000 },
    );

    result.created = created.length;
    result.createdIds = created.map((a) => a.id);
    return result;
}

// ─── Bulk actions (canonical BulkActionBar — asset rollout) ───
//
// Follow the Tasks bulk pattern: assert write, fetch the affected rows once
// (audit source + no per-id reads in a loop), one tenant-scoped `updateMany`,
// a per-row audit entry, then bump the list cache.

/** Bulk-set status (ACTIVE / RETIRED) on the given assets. */
export async function bulkSetAssetStatus(
    ctx: RequestContext,
    assetIds: string[],
    status: 'ACTIVE' | 'RETIRED',
) {
    assertCanWrite(ctx);
    const updated = await runInTenantContext(ctx, async (db) => {
        const rows = await AssetRepository.listByIds(db, ctx, assetIds);
        if (rows.length === 0) return 0;
        await AssetRepository.bulkUpdate(db, ctx, assetIds, { status });
        for (const r of rows) {
            await logEvent(db, ctx, {
                action: 'UPDATE',
                entityType: 'Asset',
                entityId: r.id,
                details: `Asset status set to ${status}`,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'Asset',
                    operation: 'updated',
                    changedFields: ['status'],
                    after: { status },
                    summary: `status set to ${status} (bulk)`,
                },
            });
        }
        return rows.length;
    });
    // Assets use React Query on the client; AssetsClient invalidates its list
    // query after the bulk mutation. No server-side SWR cache to bump.
    return { updated };
}

/** Bulk-assign an owner (ownerUserId; null = unassign) to the given assets. */
export async function bulkAssignAsset(
    ctx: RequestContext,
    assetIds: string[],
    ownerUserId: string | null,
) {
    assertCanWrite(ctx);
    const updated = await runInTenantContext(ctx, async (db) => {
        const rows = await AssetRepository.listByIds(db, ctx, assetIds);
        if (rows.length === 0) return 0;
        await AssetRepository.bulkUpdate(db, ctx, assetIds, {
            ownerUserId: ownerUserId || null,
        });
        for (const r of rows) {
            await logEvent(db, ctx, {
                action: 'UPDATE',
                entityType: 'Asset',
                entityId: r.id,
                details: ownerUserId
                    ? `Asset owner reassigned`
                    : `Asset owner cleared`,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'Asset',
                    operation: 'updated',
                    changedFields: ['ownerUserId'],
                    after: { ownerUserId: ownerUserId || null },
                    summary: ownerUserId
                        ? `owner reassigned (bulk)`
                        : `owner cleared (bulk)`,
                },
            });
        }
        return rows.length;
    });
    // Assets use React Query on the client; AssetsClient invalidates its list
    // query after the bulk mutation. No server-side SWR cache to bump.
    return { updated };
}

/** Bulk soft-delete assets selected in the table action bar. */
export async function bulkDeleteAsset(ctx: RequestContext, assetIds: string[]) {
    assertCanAdmin(ctx);
    return runInTenantContext(ctx, async (db) => {
        const rows = await AssetRepository.listByIds(db, ctx, assetIds);
        if (rows.length === 0) return { deleted: 0 };
        await db.asset.deleteMany({ where: { id: { in: rows.map((r) => r.id) }, tenantId: ctx.tenantId } });
        for (const r of rows) {
            await logEvent(db, ctx, {
                action: 'SOFT_DELETE',
                entityType: 'Asset',
                entityId: r.id,
                details: 'Asset soft-deleted (bulk)',
                detailsJson: { category: 'entity_lifecycle', entityName: 'Asset', operation: 'deleted', summary: 'Asset soft-deleted' },
            });
        }
        return { deleted: rows.length };
    });
}

export async function deleteAsset(ctx: RequestContext, id: string) {
    assertCanAdmin(ctx);

    return runInTenantContext(ctx, async (db) => {
        const deleted = await AssetRepository.delete(db, ctx, id);
        if (!deleted) throw notFound('Asset not found');

        await logEvent(db, ctx, {
            action: 'SOFT_DELETE',
            entityType: 'Asset',
            entityId: id,
            details: 'Asset soft-deleted',
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Asset',
                operation: 'deleted',
                summary: 'Asset soft-deleted',
            },
        });

        return { success: true };
    });
}

// ─── Restore / Purge / Include Deleted ───

import { restoreEntity, purgeEntity } from './soft-delete-operations';

export async function restoreAsset(ctx: RequestContext, id: string) {
    return restoreEntity(ctx, 'Asset', id);
}

export async function purgeAsset(ctx: RequestContext, id: string) {
    return purgeEntity(ctx, 'Asset', id);
}

export async function listAssetsWithDeleted(ctx: RequestContext, filters?: AssetFilters) {
    assertCanAdmin(ctx);
    return runInTenantContext(ctx, async (db) => {
        // ONLY soft-deleted rows (the repository adds `deletedAt: { not: null }`),
        // honouring the same type/status/criticality/q filters as the live list.
        const rows = await AssetRepository.listDeleted(db, ctx, filters);
        // Same rollups as listAssets so the deleted-assets view renders with the
        // identical column set (task counts + open-vuln signal).
        return enrichAssetRows(db, ctx, rows);
    });
}

// ─── Attached Evidence ───
//
// Evidence attached directly to an asset via `Evidence.assetId` — same
// pattern as Control/Task/Risk. The asset Evidence tab renders this
// through the shared <EvidenceSubTable> ({ links, evidence } shape;
// `links` always empty). Distinct from the read-only INHERITED evidence
// (aggregated from the asset's mapped controls), shown in its own
// section.

/** Asset attached-evidence payload — `{ links, evidence }` for the shared sub-table. */
export async function getAssetEvidenceTab(ctx: RequestContext, assetId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const asset = await db.asset.findFirst({
            where: { id: assetId, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!asset) throw notFound('Asset not found');
        // Read through the join — mirrors the risk tab. `Evidence.assetId`
        // survives as "uploaded from" provenance only; it could hold one
        // asset, which forced a re-upload to attach the same document to a
        // second one.
        const links = await db.evidenceAssetLink.findMany({
            where: { assetId, tenantId: ctx.tenantId, evidence: { deletedAt: null } },
            orderBy: { createdAt: 'desc' },
            include: { evidence: true },
            take: 500,
        });
        return { links: [], evidence: links.map((l) => l.evidence) };
    });
}

/** Attach a URL as evidence on an asset (file uploads go through /evidence/uploads with an assetId). */
export async function linkAssetEvidence(
    ctx: RequestContext,
    assetId: string,
    data: { url: string; note?: string | null },
) {
    assertCanWrite(ctx);
    const url = data.url.trim();
    const note = data.note ? sanitizePlainText(data.note) : null;
    const result = await runInTenantContext(ctx, async (db) => {
        const asset = await db.asset.findFirst({
            where: { id: assetId, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!asset) throw notFound('Asset not found');
        const evidence = await db.evidence.create({
            data: {
                tenantId: ctx.tenantId,
                // Kept as the "uploaded from" provenance stamp.
                assetId,
                type: 'LINK',
                title: note || url,
                content: url,
                status: 'DRAFT',
                ownerUserId: ctx.userId,
            },
        });
        // The association itself lives in the join.
        await db.evidenceAssetLink.create({
            data: {
                tenantId: ctx.tenantId,
                evidenceId: evidence.id,
                assetId,
                createdByUserId: ctx.userId,
            },
        });
        await logEvent(db, ctx, {
            action: 'ASSET_EVIDENCE_LINKED',
            entityType: 'Asset',
            entityId: assetId,
            details: `Evidence linked: ${url}`,
            detailsJson: { category: 'relationship', operation: 'linked', sourceEntity: 'Asset', sourceId: assetId, targetEntity: 'Evidence', targetId: evidence.id, relation: 'LINK' },
        });
        return evidence;
    });
    await bumpEntityCacheVersion(ctx, 'evidence');
    return result;
}

/** Detach evidence from an asset — clears `Evidence.assetId`; the evidence survives in the library. */
export async function unlinkAssetEvidence(
    ctx: RequestContext,
    assetId: string,
    evidenceId: string,
) {
    assertCanWrite(ctx);
    const outcome = await runInTenantContext(ctx, async (db) => {
        const link = await db.evidenceAssetLink.findFirst({
            where: { evidenceId, assetId, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!link) throw notFound('Asset evidence not found');
        // Detach = drop the join row; the evidence survives in the library
        // and stays attached to any OTHER assets it is linked to.
        await db.evidenceAssetLink.delete({ where: { id: link.id } });
        await db.evidence.updateMany({
            where: { id: evidenceId, tenantId: ctx.tenantId, assetId },
            data: { assetId: null },
        });
        await logEvent(db, ctx, {
            action: 'ASSET_EVIDENCE_UNLINKED',
            entityType: 'Asset',
            entityId: assetId,
            details: `Evidence unlinked: ${evidenceId}`,
            detailsJson: { category: 'relationship', operation: 'unlinked', sourceEntity: 'Asset', sourceId: assetId, targetEntity: 'Evidence', targetId: evidenceId },
        });
        return { success: true };
    });
    await bumpEntityCacheVersion(ctx, 'evidence');
    return outcome;
}
