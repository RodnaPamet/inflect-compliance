/**
 * SP-3 — SharePoint → evidence import.
 *
 * Two flows, both file-oriented (download → uploadEvidenceFile + a sync mapping)
 * rather than the field-mapper BaseSyncOrchestrator (which fits SP-4's
 * bidirectional content sync, not file import):
 *   - `importSharePointItems` — manual: import the files picked in the UI.
 *   - `runSharePointDeltaSync` — scheduled: Graph delta tokens detect changed
 *     files in mapped drives and re-import / mark stale automatically.
 *
 * @module integrations/providers/sharepoint/import
 */
import type { RequestContext } from '../../../types';
import { validateProviderConfig } from '../../config-schema';
import { runInTenantContext } from '@/lib/db-context';
import { Prisma } from '@prisma/client';
import { uploadEvidenceFile } from '../../../usecases/evidence';
import { edgeLogger } from '@/lib/observability/edge-logger';
import { getSharePointClient } from './service';
import { encodeRemoteId } from './client';
import type { SharePointClient } from './client';

export const SP_IMPORT_MAX_ITEMS = 20;

export interface SpImportInput {
    connectionId: string;
    items: Array<{ driveId: string; itemId: string; name?: string }>;
    controlId?: string;
    category?: string;
    folder?: string;
}
export interface SpImportResult {
    imported: number;
    failed: number;
    evidenceIds: string[];
    errors: Array<{ itemId: string; message: string }>;
}

/** Download one DriveItem + create an Evidence row + the sync mapping. */
async function importOne(
    ctx: RequestContext,
    client: SharePointClient,
    connectionId: string,
    sel: { driveId: string; itemId: string; name?: string },
    target: { controlId?: string; category?: string; folder?: string },
): Promise<string> {
    const remoteEntityId = encodeRemoteId(sel.driveId, sel.itemId);

    // ═══ CLAIM THE DRIVE ITEM BEFORE DOWNLOADING OR STORING IT ═══
    //
    // `uploadEvidenceFile` is NOT idempotent: it AV-scans and stores a NEW
    // object every time, and mints a new Evidence row. The mapping that would
    // have deduped the item was written AFTERWARDS, so two overlapping delta
    // syncs — or a delta sync overlapping a manual picker import — both
    // downloaded the same file, both stored it, and both created evidence, with
    // the mapping arriving too late to prevent either.
    //
    // The unique on (tenantId, provider, remoteEntityType, remoteEntityId) is
    // the interlock. `createMany` with skipDuplicates makes the insert the
    // claim: exactly one caller gets count 1, the loser gets 0 and does not
    // download anything.
    //
    // `localEntityId` carries its OWN unique, so the placeholder has to be
    // per-item rather than a shared sentinel — two different items claiming at
    // once would otherwise collide on it. The upsert at the end of a successful
    // import replaces it with the real evidence id.
    const claimPlaceholder = `pending:${remoteEntityId}`;
    const claim = await runInTenantContext(ctx, (db) =>
        db.integrationSyncMapping.createMany({
            data: [
                {
                    tenantId: ctx.tenantId,
                    provider: 'sharepoint',
                    connectionId,
                    localEntityType: 'Evidence',
                    localEntityId: claimPlaceholder,
                    remoteEntityType: 'DriveItem',
                    remoteEntityId,
                    syncStatus: 'PENDING',
                    lastSyncDirection: 'PULL',
                },
            ],
            skipDuplicates: true,
        }),
    );

    if (claim.count === 0) {
        // Already mapped, or being imported right now. A SYNCED row is the
        // ordinary case — the item was imported on an earlier pass — and
        // returning its evidence id makes a repeat sync the no-op it should
        // always have been.
        const existing = await runInTenantContext(ctx, (db) =>
            db.integrationSyncMapping.findUnique({
                where: {
                    tenantId_provider_remoteEntityType_remoteEntityId: {
                        tenantId: ctx.tenantId,
                        provider: 'sharepoint',
                        remoteEntityType: 'DriveItem',
                        remoteEntityId,
                    },
                },
                select: { localEntityId: true, syncStatus: true },
            }),
        );
        if (existing && existing.syncStatus === 'SYNCED') return existing.localEntityId;
        throw new Error(
            `SharePoint item ${sel.itemId} is already being imported by another pass. Nothing was ` +
                `downloaded or stored — retry once that pass has finished.`,
        );
    }

    try {
        const item = await client.getItem(sel.driveId, sel.itemId);
        const name = sel.name ?? item.name ?? 'sharepoint-file';
        const mimeType = item.file?.mimeType ?? 'application/octet-stream';
        const ab = await client.downloadItemContent(sel.driveId, sel.itemId);
        const file = new File([ab], name, { type: mimeType });

        const evidence = await uploadEvidenceFile(ctx, file, {
            title: name,
            controlId: target.controlId ?? null,
            category: target.category ?? null,
            folder: target.folder ?? null,
        });

        await upsertEvidenceMapping(ctx, {
            connectionId,
            evidenceId: evidence.id,
            driveId: sel.driveId,
            itemId: sel.itemId,
            eTag: item.eTag,
            cTag: item.cTag,
            webUrl: item.webUrl,
            remoteUpdatedAt: item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime) : null,
        });
        return evidence.id;
    } catch (err) {
        // Release the claim so a retry can proceed. Scoped to the placeholder,
        // so this can only ever delete a row THIS call created — a claim that
        // has already been resolved into a real mapping no longer matches, and
        // a successful import by anyone else is never undone here.
        await runInTenantContext(ctx, (db) =>
            db.integrationSyncMapping.deleteMany({
                where: {
                    tenantId: ctx.tenantId,
                    provider: 'sharepoint',
                    remoteEntityType: 'DriveItem',
                    remoteEntityId,
                    localEntityId: claimPlaceholder,
                },
            }),
        ).catch(() => undefined);
        throw err;
    }
}

/** Create/refresh the Evidence ↔ DriveItem sync mapping (keyed on the remote id). */
async function upsertEvidenceMapping(
    ctx: RequestContext,
    m: {
        connectionId: string;
        evidenceId: string;
        driveId: string;
        itemId: string;
        eTag?: string;
        cTag?: string;
        webUrl?: string;
        remoteUpdatedAt: Date | null;
    },
): Promise<void> {
    const remoteEntityId = encodeRemoteId(m.driveId, m.itemId);
    const remoteDataJson = { eTag: m.eTag, cTag: m.cTag, driveId: m.driveId, itemId: m.itemId } as Prisma.InputJsonValue;
    await runInTenantContext(ctx, (db) =>
        db.integrationSyncMapping.upsert({
            where: {
                tenantId_provider_remoteEntityType_remoteEntityId: {
                    tenantId: ctx.tenantId,
                    provider: 'sharepoint',
                    remoteEntityType: 'DriveItem',
                    remoteEntityId,
                },
            },
            create: {
                tenantId: ctx.tenantId,
                provider: 'sharepoint',
                connectionId: m.connectionId,
                localEntityType: 'Evidence',
                localEntityId: m.evidenceId,
                remoteEntityType: 'DriveItem',
                remoteEntityId,
                syncStatus: 'SYNCED',
                lastSyncDirection: 'PULL',
                remoteDataJson,
                sourceUrl: m.webUrl ?? null,
                remoteUpdatedAt: m.remoteUpdatedAt,
                lastSyncedAt: new Date(),
            },
            update: {
                localEntityId: m.evidenceId,
                connectionId: m.connectionId,
                syncStatus: 'SYNCED',
                lastSyncDirection: 'PULL',
                remoteDataJson,
                sourceUrl: m.webUrl ?? null,
                remoteUpdatedAt: m.remoteUpdatedAt,
                lastSyncedAt: new Date(),
                version: { increment: 1 },
                errorMessage: null,
            },
        }),
    );
}

/** Manual import of the files selected in the picker. */
export async function importSharePointItems(
    ctx: RequestContext,
    input: SpImportInput,
    deps: { fetchImpl?: typeof fetch } = {},
): Promise<SpImportResult> {
    if (input.items.length === 0) return { imported: 0, failed: 0, evidenceIds: [], errors: [] };
    if (input.items.length > SP_IMPORT_MAX_ITEMS) {
        throw new Error(`Too many items — import at most ${SP_IMPORT_MAX_ITEMS} at a time`);
    }
    const client = await getSharePointClient(ctx, input.connectionId, deps);
    const evidenceIds: string[] = [];
    const errors: SpImportResult['errors'] = [];
    for (const sel of input.items) {
        try {
            evidenceIds.push(
                await importOne(ctx, client, input.connectionId, sel, {
                    controlId: input.controlId,
                    category: input.category,
                    // `folder` is declared on SpImportInput, accepted by the
                    // route schema and persisted by importOne — this hop was
                    // the only one that dropped it, so the destination the
                    // user picked in the modal silently became `null`.
                    folder: input.folder,
                }),
            );
        } catch (err) {
            errors.push({ itemId: sel.itemId, message: err instanceof Error ? err.message : String(err) });
        }
    }
    return { imported: evidenceIds.length, failed: errors.length, evidenceIds, errors };
}

export interface SpDeltaSyncResult {
    drivesSynced: number;
    reimported: number;
    staled: number;
    /**
     * Set when another run held the per-connection sync lock, so this one did
     * nothing. Kept on the SAME shape rather than returned as a separate union
     * member: a caller reading `reimported` must see 0, not a type error, and a
     * skip that reported no counters at all would be indistinguishable from a
     * sync that ran and found nothing to do.
     */
    skipped?: 'sync_already_running';
}

/**
 * Scheduled delta sync: for every drive with mapped evidence, walk the Graph
 * delta from the stored token; re-import changed files and mark deleted ones
 * STALE. Persists the new delta token per drive on the connection config.
 */
export async function runSharePointDeltaSync(
    ctx: RequestContext,
    connectionId: string,
    deps: { fetchImpl?: typeof fetch } = {},
): Promise<SpDeltaSyncResult> {
    const client = await getSharePointClient(ctx, connectionId, deps);

    // Mappings for this connection, indexed by remote id (driveId:itemId).
    const mappings = await runInTenantContext(ctx, (db) =>
        db.integrationSyncMapping.findMany({
            where: { tenantId: ctx.tenantId, provider: 'sharepoint', connectionId, remoteEntityType: 'DriveItem' },
            select: { id: true, remoteEntityId: true, remoteDataJson: true, localEntityId: true },
            take: 5000,
        }),
    );
    const byRemoteId = new Map(mappings.map((m) => [m.remoteEntityId, m]));
    const driveIds = new Set(mappings.map((m) => m.remoteEntityId.split(':')[0]));

    const tokens = await readDeltaTokens(ctx, connectionId);
    let reimported = 0;
    let staled = 0;

    for (const driveId of driveIds) {
        const delta = await client.getDelta(driveId, tokens[driveId]);
        for (const it of delta.items) {
            const remoteId = encodeRemoteId(driveId, it.id);
            const mapping = byRemoteId.get(remoteId);
            if (!mapping) continue; // only items IC already tracks

            if (it.deleted) {
                await runInTenantContext(ctx, (db) =>
                    db.integrationSyncMapping.update({
                        where: { id: mapping.id },
                        data: { syncStatus: 'STALE', lastSyncedAt: new Date() },
                    }),
                );
                staled++;
                continue;
            }
            // Detect changes by cTag (content tag) — eTag also bumps on
            // metadata-only touches, which would cause spurious re-imports.
            // Fall back to eTag when cTag is absent.
            const prev = mapping.remoteDataJson as { cTag?: string; eTag?: string } | null;
            const prevTag = prev?.cTag ?? prev?.eTag;
            const curTag = it.cTag ?? it.eTag;
            if (curTag && curTag !== prevTag) {
                try {
                    await importOne(ctx, client, connectionId, { driveId, itemId: it.id }, {});
                    reimported++;
                } catch (err) {
                    edgeLogger.error('SharePoint delta re-import failed', {
                        component: 'sharepoint',
                        remoteId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }
        }
        if (delta.deltaToken) tokens[driveId] = delta.deltaToken;
    }

    await writeDeltaTokens(ctx, connectionId, tokens);
    return { drivesSynced: driveIds.size, reimported, staled };
}

async function readDeltaTokens(ctx: RequestContext, connectionId: string): Promise<Record<string, string>> {
    const conn = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirst({
            where: { id: connectionId, tenantId: ctx.tenantId },
            select: { configJson: true },
        }),
    );
    const cfg = (conn?.configJson ?? {}) as { deltaTokens?: Record<string, string> };
    return { ...(cfg.deltaTokens ?? {}) };
}

async function writeDeltaTokens(ctx: RequestContext, connectionId: string, tokens: Record<string, string>): Promise<void> {
    await runInTenantContext(ctx, async (db) => {
        const conn = await db.integrationConnection.findFirst({
            where: { id: connectionId, tenantId: ctx.tenantId },
            select: { configJson: true },
        });
        const cfg = (conn?.configJson ?? {}) as Record<string, unknown>;
        await db.integrationConnection.update({
            where: { id: connectionId },
            data: {
                configJson: validateProviderConfig('sharepoint', {
                    ...cfg,
                    deltaTokens: tokens,
                }) as Prisma.InputJsonValue,
            },
        });
    });
}
