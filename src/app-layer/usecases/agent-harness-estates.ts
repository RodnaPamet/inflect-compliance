/**
 * Client estates and their schedule health (#3678, step 4a) — the ONLY writer
 * of AgentHarnessEstate and AgentHarnessEstateSource.
 *
 * ── WHAT AN ESTATE IS HERE ──────────────────────────────────────────────────
 *
 * A client environment one harness scanner deployment covers: a name, the
 * REGISTERED scanner agent whose signed reports describe it, the cadence a
 * complete scan is expected at, and the sources that scanner reads, each with
 * the person accountable for it. It is a declaration, and only that: scans stay
 * what the ingest recorded (`agent-harness-scans.ts`), and this module never
 * writes or links one.
 *
 * A scan is an estate's through the scanner that signed it. The report cannot
 * name an estate — the contract is strict and has no such member, and adding
 * one is a new contract id — so `scannerAgentId` is the join, and one estate
 * per scanner is a unique key rather than a convention. The register decides
 * which agent is the scanner, and a scanner key that could also declare its own
 * estate could decide what it is measured against, so declaring takes
 * `admin.agent_registry` and the ingest key never reaches this module.
 *
 * ── THE RULES THE WRITES HOLD ───────────────────────────────────────────────
 *
 *   • EVERY SOURCE HAS A NAMED OWNER, an ACTIVE member when written. A source
 *     with nobody accountable is the gap the hardening checklist names; the
 *     column is NOT NULL and the check is here.
 *   • AN ESTATE DECLARES AT LEAST ONE SOURCE (zero is never complete), each
 *     kind once, from the contract's `SOURCE_KINDS` — the database CHECKs both.
 *   • THE SCANNER IS A LIVE REGISTER ROW: not deleted, not retired. It is fixed
 *     at declaration; moving an estate to another scanner is a new estate, so a
 *     history of scans is never re-attributed.
 *
 * ── THE READ ────────────────────────────────────────────────────────────────
 *
 * `getHarnessEstateHealth` reads the estates and their scanners' newest scans
 * and hands them to the pure `computeEstateHealth`. It is the inventory read
 * (`mayReadAgentInventory`, the key the scan list takes), because it shows
 * nothing a reader of the scans could not already see except the owners.
 */
import { z } from 'zod';

import type { RequestContext } from '../types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors/types';
import { mayReadAgentInventory } from '@/lib/permissions';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logEvent } from '../events/audit';
import { parseStoredHarnessSources, SOURCE_KINDS } from '@/lib/agentic/harness-contract';
import {
    computeEstateHealth,
    type EstateScanInput,
    type HarnessEstateHealthView,
} from '@/lib/agentic/harness-estate-health';

/** Estates a tenant declares. A client portfolio is a handful; the page shows them all. */
export const ESTATE_CAP = 50;
/** The newest scans read across every estate's scanner. A daily estate's 500 scans span well over a year. */
export const ESTATE_SCAN_WINDOW = 500;

const sourceInput = z.object({ kind: z.enum(SOURCE_KINDS), ownerUserId: z.string().min(1).max(64) }).strict();

const sourcesInput = z
    .array(sourceInput)
    .min(1, 'an estate declares at least one source')
    .max(SOURCE_KINDS.length)
    .superRefine((sources, ctx) => {
        const kinds = sources.map((s) => s.kind);
        if (new Set(kinds).size !== kinds.length) ctx.addIssue({ code: 'custom', message: 'each source kind appears once' });
    });

export const CreateHarnessEstateSchema = z
    .object({
        name: z.string().trim().min(1).max(120),
        scannerAgentId: z.string().min(1).max(64),
        cadenceHours: z.number().int().min(1).max(720),
        sources: sourcesInput,
    })
    .strict();

export const UpdateHarnessEstateSchema = z
    .object({
        name: z.string().trim().min(1).max(120).optional(),
        cadenceHours: z.number().int().min(1).max(720).optional(),
        /** Replaces the whole set when present. */
        sources: sourcesInput.optional(),
    })
    .strict()
    .refine((p) => p.name !== undefined || p.cadenceHours !== undefined || p.sources !== undefined, 'nothing to change');

export type CreateHarnessEstateInput = z.infer<typeof CreateHarnessEstateSchema>;
export type UpdateHarnessEstateInput = z.infer<typeof UpdateHarnessEstateSchema>;

function assertMayDeclare(ctx: RequestContext): void {
    if (!ctx.appPermissions.admin.agent_registry) {
        throw forbidden('Declaring a harness estate requires admin.agent_registry');
    }
}

function assertMayRead(ctx: RequestContext): void {
    if (!mayReadAgentInventory(ctx.appPermissions.admin)) {
        throw forbidden('Reading harness estate health requires admin.agent_registry_view');
    }
}

function cleanName(raw: string): string {
    const name = sanitizePlainText(raw).trim();
    if (name === '') throw badRequest('The estate name is empty once sanitised');
    return name;
}

/** Every owner must hold an ACTIVE membership in this tenant. */
async function assertOwnersActive(db: PrismaTx, ctx: RequestContext, ownerIds: readonly string[]): Promise<void> {
    const unique = [...new Set(ownerIds)];
    const active = await db.tenantMembership.findMany({
        where: { tenantId: ctx.tenantId, userId: { in: unique }, status: 'ACTIVE' },
        select: { userId: true },
        take: unique.length,
    });
    const found = new Set(active.map((m) => m.userId));
    if (unique.some((id) => !found.has(id))) {
        throw badRequest('Every source needs an owner who is an active member of this tenant');
    }
}

const estateSelect = {
    id: true,
    name: true,
    scannerAgentId: true,
    cadenceHours: true,
    createdAt: true,
    updatedAt: true,
    sources: { select: { kind: true, ownerUserId: true }, orderBy: { kind: 'asc' as const } },
} as const;

/** Declare one estate: its scanner, its cadence, and an owner for each source. */
export async function createHarnessEstate(ctx: RequestContext, input: CreateHarnessEstateInput) {
    assertMayDeclare(ctx);
    const data = CreateHarnessEstateSchema.parse(input);
    const name = cleanName(data.name);

    return runInTenantContext(ctx, async (db) => {
        const scanner = await db.registeredAgent.findFirst({
            where: { id: data.scannerAgentId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, status: true },
        });
        if (!scanner) throw notFound('Registered agent not found');
        if (scanner.status === 'RETIRED') throw badRequest('A retired agent cannot scan an estate');
        await assertOwnersActive(db, ctx, data.sources.map((s) => s.ownerUserId));

        const clash = await db.agentHarnessEstate.findFirst({
            where: { tenantId: ctx.tenantId, OR: [{ scannerAgentId: scanner.id }, { name }] },
            select: { scannerAgentId: true },
        });
        if (clash) {
            throw conflict(
                clash.scannerAgentId === scanner.id
                    ? 'This scanner already covers an estate: one estate per scanner'
                    : 'An estate with this name already exists',
            );
        }

        const estate = await db.agentHarnessEstate.create({
            data: {
                tenantId: ctx.tenantId,
                name,
                scannerAgentId: scanner.id,
                cadenceHours: data.cadenceHours,
                createdByUserId: ctx.userId,
            },
            select: { id: true },
        });
        await db.agentHarnessEstateSource.createMany({
            data: data.sources.map((s) => ({ tenantId: ctx.tenantId, estateId: estate.id, kind: s.kind, ownerUserId: s.ownerUserId })),
        });
        const created = await db.agentHarnessEstate.findFirstOrThrow({ where: { id: estate.id, tenantId: ctx.tenantId }, select: estateSelect });

        await logEvent(db, ctx, {
            action: 'AGENT_HARNESS_ESTATE_DECLARED',
            entityType: 'AgentHarnessEstate',
            entityId: created.id,
            details: `Declared harness estate ${created.id} for scanner ${created.scannerAgentId}`,
            detailsJson: {
                category: 'custom',
                entityName: 'AgentHarnessEstate',
                operation: 'created',
                after: {
                    name: created.name,
                    scannerAgentId: created.scannerAgentId,
                    cadenceHours: created.cadenceHours,
                    sources: created.sources,
                },
            },
        });
        return created;
    });
}

/** Rename, re-cadence, or replace the sources (and so their owners) of one estate. */
export async function updateHarnessEstate(ctx: RequestContext, estateId: string, input: UpdateHarnessEstateInput) {
    assertMayDeclare(ctx);
    const data = UpdateHarnessEstateSchema.parse(input);
    const name = data.name === undefined ? undefined : cleanName(data.name);

    return runInTenantContext(ctx, async (db) => {
        const before = await db.agentHarnessEstate.findFirst({ where: { id: estateId, tenantId: ctx.tenantId }, select: estateSelect });
        if (!before) throw notFound('Harness estate not found');
        if (data.sources) await assertOwnersActive(db, ctx, data.sources.map((s) => s.ownerUserId));
        if (name !== undefined && name !== before.name) {
            const clash = await db.agentHarnessEstate.findFirst({
                where: { tenantId: ctx.tenantId, name, NOT: { id: estateId } },
                select: { id: true },
            });
            if (clash) throw conflict('An estate with this name already exists');
        }

        await db.agentHarnessEstate.updateMany({
            where: { id: estateId, tenantId: ctx.tenantId },
            data: { ...(name !== undefined ? { name } : {}), ...(data.cadenceHours !== undefined ? { cadenceHours: data.cadenceHours } : {}) },
        });
        if (data.sources) {
            await db.agentHarnessEstateSource.deleteMany({ where: { tenantId: ctx.tenantId, estateId } });
            await db.agentHarnessEstateSource.createMany({
                data: data.sources.map((s) => ({ tenantId: ctx.tenantId, estateId, kind: s.kind, ownerUserId: s.ownerUserId })),
            });
        }
        const after = await db.agentHarnessEstate.findFirstOrThrow({ where: { id: estateId, tenantId: ctx.tenantId }, select: estateSelect });

        await logEvent(db, ctx, {
            action: 'AGENT_HARNESS_ESTATE_UPDATED',
            entityType: 'AgentHarnessEstate',
            entityId: before.id,
            details: `Updated harness estate ${before.id}`,
            detailsJson: {
                category: 'custom',
                entityName: 'AgentHarnessEstate',
                operation: 'updated',
                before: { name: before.name, cadenceHours: before.cadenceHours, sources: before.sources },
                after: { name: after.name, cadenceHours: after.cadenceHours, sources: after.sources },
            },
        });
        return after;
    });
}

/** Remove an estate and its sources. Its scans stay: they are the ingest's, not the estate's. */
export async function deleteHarnessEstate(ctx: RequestContext, estateId: string) {
    assertMayDeclare(ctx);
    return runInTenantContext(ctx, async (db) => {
        const before = await db.agentHarnessEstate.findFirst({ where: { id: estateId, tenantId: ctx.tenantId }, select: estateSelect });
        if (!before) throw notFound('Harness estate not found');
        await db.agentHarnessEstate.deleteMany({ where: { id: estateId, tenantId: ctx.tenantId } });
        await logEvent(db, ctx, {
            action: 'AGENT_HARNESS_ESTATE_REMOVED',
            entityType: 'AgentHarnessEstate',
            entityId: before.id,
            details: `Removed harness estate ${before.id}`,
            detailsJson: {
                category: 'custom',
                entityName: 'AgentHarnessEstate',
                operation: 'deleted',
                before: { name: before.name, scannerAgentId: before.scannerAgentId, cadenceHours: before.cadenceHours, sources: before.sources },
            },
        });
        return { id: estateId, removed: true };
    });
}

/**
 * Every estate's schedule health, as of now: the last complete scan per estate
 * and per source, and whether each is stale against its cadence.
 *
 * `limits` can only LOWER the module's bounds, for tests of the bounded paths.
 */
export async function getHarnessEstateHealth(
    ctx: RequestContext,
    opts: { now?: Date; limits?: { estates?: number; scans?: number } } = {},
): Promise<HarnessEstateHealthView> {
    assertMayRead(ctx);
    const now = opts.now ?? new Date();
    const estateCap = Math.min(Math.max(Math.trunc(opts.limits?.estates ?? ESTATE_CAP), 1), ESTATE_CAP);
    const scanCap = Math.min(Math.max(Math.trunc(opts.limits?.scans ?? ESTATE_SCAN_WINDOW), 1), ESTATE_SCAN_WINDOW);

    return runInTenantContext(ctx, async (db) => {
        const estates = await db.agentHarnessEstate.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            take: estateCap + 1,
            select: {
                id: true,
                name: true,
                scannerAgentId: true,
                cadenceHours: true,
                scanner: { select: { name: true, status: true, deletedAt: true } },
                sources: {
                    orderBy: { kind: 'asc' },
                    select: { kind: true, ownerUserId: true, owner: { select: { name: true } } },
                },
            },
        });
        const shown = estates.slice(0, estateCap);
        const scannerIds = shown.map((e) => e.scannerAgentId);
        const ownerIds = [...new Set(shown.flatMap((e) => e.sources.map((s) => s.ownerUserId)))];

        const [active, scans] = await Promise.all([
            ownerIds.length === 0
                ? Promise.resolve([] as { userId: string }[])
                : db.tenantMembership.findMany({
                    where: { tenantId: ctx.tenantId, userId: { in: ownerIds }, status: 'ACTIVE' },
                    select: { userId: true },
                    take: ownerIds.length,
                }),
            scannerIds.length === 0
                ? Promise.resolve([])
                : db.agentHarnessScan.findMany({
                    where: { tenantId: ctx.tenantId, scannerAgentId: { in: scannerIds } },
                    orderBy: [{ asOf: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
                    take: scanCap + 1,
                    select: {
                        id: true,
                        scanRef: true,
                        scannerAgentId: true,
                        asOf: true,
                        createdAt: true,
                        complete: true,
                        agentCount: true,
                        sourcesJson: true,
                    },
                }),
        ]);
        const activeOwners = new Set(active.map((m) => m.userId));
        const read = scans.slice(0, scanCap);
        const byScanner = new Map<string, EstateScanInput[]>();
        for (const s of read) {
            const list = byScanner.get(s.scannerAgentId) ?? [];
            list.push({
                id: s.id,
                scanRef: s.scanRef,
                asOf: s.asOf.toISOString(),
                ingestedAt: s.createdAt.toISOString(),
                complete: s.complete,
                agentCount: s.agentCount,
                sources: parseStoredHarnessSources(s.sourcesJson),
            });
            byScanner.set(s.scannerAgentId, list);
        }

        return {
            generatedAt: now.toISOString(),
            scanWindow: scanCap,
            windowTruncated: scans.length > scanCap,
            estates: {
                truncated: estates.length > estateCap,
                rows: shown.map((e) =>
                    computeEstateHealth(
                        {
                            id: e.id,
                            name: e.name,
                            scannerAgentId: e.scannerAgentId,
                            scannerName: e.scanner.deletedAt === null ? e.scanner.name : null,
                            scannerLive: e.scanner.deletedAt === null && e.scanner.status !== 'RETIRED',
                            cadenceHours: e.cadenceHours,
                            sources: e.sources.map((s) => ({
                                kind: s.kind,
                                owner: { userId: s.ownerUserId, name: s.owner.name ?? null, active: activeOwners.has(s.ownerUserId) },
                            })),
                        },
                        byScanner.get(e.scannerAgentId) ?? [],
                        now,
                    ),
                ),
            },
        };
    });
}
