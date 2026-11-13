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
import { assertMayChangeEvidenceControlLinks } from '../../../usecases/evidence-control-links';
import { edgeLogger } from '@/lib/observability/edge-logger';
import { getSharePointClient } from './service';
import { encodeRemoteId } from './client';
import type { SharePointClient } from './client';

export const SP_IMPORT_MAX_ITEMS = 20;

/** The route `importSharePointItems` serves, named on a refusal's audit row. */
const SP_IMPORT_SURFACE = { method: 'POST', path: '/api/t/[tenantSlug]/integrations/sharepoint/import' } as const;

export interface SpImportInput {
    connectionId: string;
    items: Array<{ driveId: string; itemId: string; name?: string }>;
    controlId?: string;
    /** #5018 — several controls, as the upload form now sends. Merged with `controlId`. */
    controlIds?: string[];
    category?: string;
    /** #5018 — what the evidence shows; applied to every imported record. */
    description?: string;
    folder?: string;
}
export interface SpImportResult {
    imported: number;
    failed: number;
    evidenceIds: string[];
    errors: Array<{ itemId: string; message: string }>;
}

/**
 * Download one DriveItem + create an Evidence row + the sync mapping.
 *
 * `opts.reimportChanged` is the DELTA path's mode (#5193). Without it, an item
 * that is already mapped SYNCED short-circuits to its existing evidence id —
 * correct for a repeat sync of an UNCHANGED item, and exactly wrong for one the
 * delta walk has just told us changed. The caller knows which it is; this
 * function could not.
 */
async function importOne(
    ctx: RequestContext,
    client: SharePointClient,
    connectionId: string,
    sel: { driveId: string; itemId: string; name?: string },
    target: { controlIds: string[]; category?: string; description?: string; folder?: string },
    opts: { reimportChanged?: boolean } = {},
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
        if (existing && existing.syncStatus === 'SYNCED') {
            // ═══ A CHANGED ITEM IS NOT A REPEAT (#5193) ═══
            //
            // Returning the existing id here is what made "re-import changed
            // files" never happen: nothing was downloaded, the stored cTag kept
            // its old value, and the caller still counted a reimport. Because
            // the delta token advances regardless, the edit was lost for good
            // rather than retried.
            //
            // The claim for this path is a STATUS TRANSITION, not an insert:
            // the row already exists, so `createMany` can never be the
            // interlock. `updateMany` scoped to `syncStatus: 'SYNCED'` is —
            // exactly one concurrent caller moves it to PENDING and gets
            // count 1; a loser gets 0 and falls through to the refusal below,
            // which is the same answer it would have had before.
            if (!opts.reimportChanged) return existing.localEntityId;

            const reclaim = await runInTenantContext(ctx, (db) =>
                db.integrationSyncMapping.updateMany({
                    where: {
                        tenantId: ctx.tenantId,
                        provider: 'sharepoint',
                        remoteEntityType: 'DriveItem',
                        remoteEntityId,
                        syncStatus: 'SYNCED',
                    },
                    data: { syncStatus: 'PENDING' },
                }),
            );
            if (reclaim.count === 1) {
                return await reimportChangedItem(ctx, client, connectionId, sel, target, existing.localEntityId);
            }
        }
        throw new Error(
            `SharePoint item ${sel.itemId} is already being imported by another pass. Nothing was ` +
                `downloaded or stored — retry once that pass has finished.`,
        );
    }

    try {
        return await downloadAndStore(ctx, client, connectionId, sel, target, target.controlIds);
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

/**
 * Download one DriveItem and store it: a new Evidence row plus the mapping that
 * points at it and records the content tag it came from.
 *
 * ONE copy, shared by the first import and the re-import of a changed item
 * (#5193). It was briefly two, and that is worth not repeating for two reasons.
 * The obvious one is drift: five steps that must agree about title, category,
 * folder and which tags get stored. The other is that
 * `evidence-upload-sends-what-it-renders` asserts that the modal, the route and
 * THIS call all pass the same metadata, and it does so by matching the category
 * and folder assignments below against this file. A second copy gave each of
 * those needles two satisfying positions, so the guard would have stayed green
 * with either copy deleted. The assertion-needle ratchet caught it, which is
 * the whole point of counting ambiguous needles — and note this comment
 * deliberately does NOT spell either assignment out, because quoting a needle
 * in prose recreates the same ambiguity it is describing.
 *
 * `controlIds` is a PARAMETER rather than read off `target`, because the two
 * callers answer it differently: a picker import uses what the person chose,
 * and a re-import carries the previous Evidence row's links across.
 */
async function downloadAndStore(
    ctx: RequestContext,
    client: SharePointClient,
    connectionId: string,
    sel: { driveId: string; itemId: string; name?: string },
    target: { category?: string; description?: string; folder?: string },
    controlIds: string[],
): Promise<string> {
    const item = await client.getItem(sel.driveId, sel.itemId);
    const name = sel.name ?? item.name ?? 'sharepoint-file';
    const mimeType = item.file?.mimeType ?? 'application/octet-stream';
    const ab = await client.downloadItemContent(sel.driveId, sel.itemId);
    const file = new File([ab], name, { type: mimeType });

    const evidence = await uploadEvidenceFile(ctx, file, {
        title: name,
        controlIds: controlIds.length > 0 ? controlIds : null,
        category: target.category ?? null,
        description: target.description ?? null,
        folder: target.folder ?? null,
    });

    // Repoints the mapping at the new row AND stores the new cTag/eTag, which
    // is what stops the next delta walk seeing the same change again.
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
}

/**
 * Re-download a changed DriveItem and store it as a NEW Evidence row, carrying
 * the previous row's control links across (#5193).
 *
 * ── WHY A NEW ROW ───────────────────────────────────────────────────────────
 *
 * It is what this import path is built for: `uploadEvidenceFile` mints a row
 * and `upsertEvidenceMapping` is keyed on the REMOTE id, so it repoints the
 * mapping at whatever the latest import produced. The sync route's own comment
 * describes the same shape ("a fresh Evidence row for every changed file").
 * The previous row stays in the library as the historical version — an auditor
 * who relied on it still finds exactly what they saw, which is the property
 * that matters for a compliance artefact and the reason this does not overwrite
 * in place.
 *
 * ── WHY THE CONTROL LINKS ARE CARRIED ───────────────────────────────────────
 *
 * The delta caller has no control ids to pass — it re-imports whatever changed,
 * not something a person picked — so a naive re-import creates the new row with
 * `controlIds: null` and the file silently stops satisfying the controls the old
 * row was attached to. That is a WORSE failure than the stale version it
 * replaces: a control's evidence disappears rather than merely ageing. So the
 * previous row's links are read first and passed through.
 *
 * Links are carried, not moved: the old row keeps its own, because it remains
 * the evidence for the period it covered.
 *
 * ── ON FAILURE ──────────────────────────────────────────────────────────────
 *
 * The caller claimed the mapping by moving it SYNCED → PENDING. If anything
 * here throws, the status is put BACK to SYNCED, because the row still
 * describes a real, intact evidence import — the previous one. Leaving it
 * PENDING would make every later pass refuse it with "already being imported by
 * another pass", which is how a transient Graph error would have frozen the
 * item for ever.
 */
async function reimportChangedItem(
    ctx: RequestContext,
    client: SharePointClient,
    connectionId: string,
    sel: { driveId: string; itemId: string; name?: string },
    target: { controlIds: string[]; category?: string; description?: string; folder?: string },
    previousEvidenceId: string,
): Promise<string> {
    const remoteEntityId = encodeRemoteId(sel.driveId, sel.itemId);
    try {
        // The links the PREVIOUS row carried. Read before the upload, so a
        // failure leaves nothing half-done.
        const carried = await runInTenantContext(ctx, (db) =>
            db.evidenceControlLink.findMany({
                where: { tenantId: ctx.tenantId, evidenceId: previousEvidenceId },
                select: { controlId: true },
                take: 200,
            }),
        );
        const controlIds = target.controlIds.length > 0
            ? target.controlIds
            : carried.map((l) => l.controlId);

        return await downloadAndStore(ctx, client, connectionId, sel, target, controlIds);
    } catch (err) {
        // Back to SYNCED — see the docblock. Scoped to the row still sitting at
        // the PENDING this call set, so it can never undo somebody else's work.
        await runInTenantContext(ctx, (db) =>
            db.integrationSyncMapping.updateMany({
                where: {
                    tenantId: ctx.tenantId,
                    provider: 'sharepoint',
                    remoteEntityType: 'DriveItem',
                    remoteEntityId,
                    syncStatus: 'PENDING',
                    localEntityId: previousEvidenceId,
                },
                data: { syncStatus: 'SYNCED' },
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
    // A chosen control links every imported record to it, which takes the
    // control side's rule as well (#4326). `uploadEvidenceFile` asks it per
    // file; asking it once here refuses the whole import before anything is
    // claimed or downloaded, with one refusal on record rather than one per file.
    const controlIds = [...new Set([...(input.controlIds ?? []), ...(input.controlId ? [input.controlId] : [])])];
    if (controlIds.length > 0) {
        await assertMayChangeEvidenceControlLinks(ctx, SP_IMPORT_SURFACE);
    }
    const client = await getSharePointClient(ctx, input.connectionId, deps);
    const evidenceIds: string[] = [];
    const errors: SpImportResult['errors'] = [];
    for (const sel of input.items) {
        try {
            evidenceIds.push(
                await importOne(ctx, client, input.connectionId, sel, {
                    controlIds,
                    category: input.category,
                    description: input.description,
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
    /**
     * Changed items whose content was actually re-downloaded and stored.
     *
     * It used to be incremented whether or not anything happened — the delta
     * path called `importOne`, which returned the existing evidence id without
     * downloading, and the counter went up anyway (#5193). A run that
     * re-imported nothing reported `reimported: N`, which is the kind of figure
     * an operator trusts.
     */
    reimported: number;
    staled: number;
    /** Changed items whose re-import threw. Their drive's token is held back. */
    failed: number;
    /**
     * Drives whose delta cursor was NOT advanced because a re-import failed in
     * them (#5193).
     *
     * Non-zero means the next run re-walks those drives. That is the intended
     * cost: advancing past a failed item means its change is never offered
     * again, because a delta response carries only what changed since the token
     * it was given.
     */
    tokensHeld: number;
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
    let failed = 0;
    let tokensHeld = 0;

    for (const driveId of driveIds) {
        // The failure count as this drive STARTS, so the decision below is
        // about this drive alone — a failure in an earlier drive must not pin
        // a later drive's cursor.
        const failedBefore = failed;
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
                    await importOne(
                        ctx,
                        client,
                        connectionId,
                        { driveId, itemId: it.id },
                        { controlIds: [] },
                        // The whole point (#5193): tell importOne this item
                        // CHANGED, so it re-downloads instead of returning the
                        // existing evidence id untouched.
                        { reimportChanged: true },
                    );
                    // Counted only now. It used to be counted whether or not
                    // anything was stored, so a run that re-imported nothing
                    // reported `reimported: N`.
                    reimported++;
                } catch (err) {
                    failed++;
                    edgeLogger.error('SharePoint delta re-import failed', {
                        component: 'sharepoint',
                        remoteId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }
        }
        // ═══ THE TOKEN ONLY ADVANCES OVER WORK THAT LANDED (#5193) ═══
        //
        // It used to advance unconditionally. A delta response returns only
        // what changed since the token it was given, so advancing past an item
        // whose re-import threw meant that change was never offered again —
        // the same silent permanent loss this change exists to fix, by a
        // different route.
        //
        // Held back PER DRIVE, because the token is per drive. The cost is that
        // the next run re-walks this drive's changes, and the items that DID
        // succeed are then no-ops: their stored cTag now matches, so the
        // `curTag !== prevTag` test is false and nothing is re-downloaded. That
        // is why holding the token is affordable here and why re-walking is not
        // re-importing.
        //
        // A permanently failing item does hold its drive's cursor. That is
        // deliberate: the alternative is losing its changes silently, and this
        // way the run reports `failed > 0` every time, which is a signal
        // somebody can act on. `tokensHeld` carries it to the caller.
        if (delta.deltaToken) {
            if (failed === failedBefore) {
                tokens[driveId] = delta.deltaToken;
            } else {
                tokensHeld++;
                edgeLogger.warn('SharePoint delta token held back — a re-import failed in this drive', {
                    component: 'sharepoint',
                    driveId,
                    failedInDrive: failed - failedBefore,
                });
            }
        }
    }

    await writeDeltaTokens(ctx, connectionId, tokens);
    return { drivesSynced: driveIds.size, reimported, staled, failed, tokensHeld };
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
