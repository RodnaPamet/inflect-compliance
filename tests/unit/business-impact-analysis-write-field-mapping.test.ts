/**
 * What the BIA write path actually PERSISTS.
 *
 * `createBia` / `updateBia` are a long column of `?? null`,
 * `!== undefined && { … }` and `? sanitize(…) : null` expressions — the class
 * of code where copy-pasting one line onto the next compiles, type-checks and
 * silently writes the wrong column, or drops a `0`. So every assertion below
 * is on the exact argument object handed to Prisma, read off `mock.calls` and
 * compared with `toStrictEqual` (a key present-but-`undefined` is NOT the same
 * as an absent key, and that distinction is load-bearing here: `impactProfile`
 * is deliberately `undefined` so Prisma leaves the JSON column alone, while
 * every other omitted field is an explicit `null` that clears it).
 *
 * Two things are deliberately NOT mocked, because mocking them would make the
 * tests weaker than the code:
 *   - `sanitizePlainText` is the real Epic C.5 helper, so a dropped sanitise
 *     call on `name` or `notes` shows up as raw markup in the payload;
 *   - `assertCanWrite` is the real policy, so the refusal test is the real
 *     refusal.
 */
jest.mock('@/lib/db-context', () => ({ runInTenantContext: jest.fn() }));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

import {
    createBia,
    updateBia,
    addBiaDependency,
} from '@/app-layer/usecases/business-impact-analysis';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../helpers/make-context';
import { ForbiddenError, ValidationError } from '@/lib/errors/types';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const ctx = makeRequestContext('ADMIN', { tenantId: 't-acme', userId: 'u-1' });

/** Bind a mock `db` to `runInTenantContext` and hand it back for assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withDb<T extends Record<string, any>>(db: T): T {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRunInTx.mockImplementation(async (_c: any, fn: any) => fn(db));
    return db;
}

beforeEach(() => jest.clearAllMocks());

describe('createBia — persisted payload', () => {
    function createDb(over: Record<string, unknown> = {}) {
        return withDb({
            processNode: {
                findFirst: jest.fn().mockResolvedValue({ id: 'node-1' }),
                findMany: jest.fn().mockResolvedValue([]),
            },
            asset: { findMany: jest.fn().mockResolvedValue([]) },
            vendor: { findMany: jest.fn().mockResolvedValue([]) },
            risk: { findMany: jest.fn().mockResolvedValue([]) },
            businessImpactAnalysis: {
                // Echo the persisted name back, so the audit assertion below
                // proves the SANITISED value is what reaches the trail.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                create: jest.fn(async ({ data }: any) => ({ id: 'bia-1', name: data.name })),
            },
            biaDependency: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
            ...over,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
    }

    it('writes every supplied field, sanitised, and names the sanitised value in the audit entry', async () => {
        const db = createDb();
        const profile = [{ atHours: 4, financial: 10_000, operational: 3 }];

        const bia = await createBia(ctx, {
            name: 'Payroll <b>run</b>',
            criticality: 'CRITICAL',
            processNodeId: 'node-1',
            rtoHours: 4,
            rpoHours: 0,
            mtpdHours: 8,
            impactProfile: profile,
            notes: 'Restore from <script>alert(1)</script>tape',
            ownerUserId: 'u-owner',
        });

        expect(db.businessImpactAnalysis.create.mock.calls[0][0]).toStrictEqual({
            data: {
                tenantId: 't-acme',
                name: 'Payroll run',
                criticality: 'CRITICAL',
                processNodeId: 'node-1',
                rtoHours: 4,
                // 0 is falsy and must still be written — a `data.rpoHours &&`
                // refactor would silently turn "no downtime tolerated" into null.
                rpoHours: 0,
                mtpdHours: 8,
                impactProfile: profile,
                notes: 'Restore from tape',
                ownerUserId: 'u-owner',
            },
        });
        expect(bia).toStrictEqual({ id: 'bia-1', name: 'Payroll run' });
        expect(logEvent).toHaveBeenCalledWith(db, ctx, {
            action: 'CREATE',
            entityType: 'BusinessImpactAnalysis',
            entityId: 'bia-1',
            details: 'Created BIA: Payroll run',
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'BusinessImpactAnalysis',
                operation: 'created',
            },
        });
    });

    it('coalesces omitted optionals to explicit nulls, but leaves impactProfile undefined', async () => {
        const db = createDb();

        await createBia(ctx, { name: 'Payroll', criticality: 'LOW' });

        expect(db.businessImpactAnalysis.create.mock.calls[0][0]).toStrictEqual({
            data: {
                tenantId: 't-acme',
                name: 'Payroll',
                criticality: 'LOW',
                processNodeId: null,
                rtoHours: null,
                rpoHours: null,
                mtpdHours: null,
                // `undefined`, not `null`: Prisma skips the column instead of
                // writing JSON null into it.
                impactProfile: undefined,
                notes: null,
                ownerUserId: null,
            },
        });
        expect(db.processNode.findFirst).not.toHaveBeenCalled();
        expect(db.biaDependency.createMany).not.toHaveBeenCalled();
    });

    it('validates dependency targets with one deduplicated query per type and skips unused types', async () => {
        const db = createDb({
            processNode: {
                findFirst: jest.fn().mockResolvedValue({ id: 'node-1' }),
                findMany: jest.fn().mockResolvedValue([{ id: 'node-1' }]),
            },
            asset: { findMany: jest.fn().mockResolvedValue([{ id: 'asset-1' }]) },
        });

        await createBia(ctx, {
            name: 'Payroll',
            criticality: 'HIGH',
            dependencies: [
                { dependsOnType: 'PROCESS', dependsOnId: 'node-1' },
                { dependsOnType: 'PROCESS', dependsOnId: 'node-1' },
                { dependsOnType: 'ASSET', dependsOnId: 'asset-1' },
            ],
        });

        expect(db.processNode.findMany.mock.calls[0][0]).toStrictEqual({
            where: { tenantId: 't-acme', id: { in: ['node-1'] } },
            select: { id: true },
            take: 500,
        });
        expect(db.asset.findMany.mock.calls[0][0]).toStrictEqual({
            where: { tenantId: 't-acme', id: { in: ['asset-1'] } },
            select: { id: true },
            take: 500,
        });
        // No dependency of these types was asked for, so no query is issued.
        expect(db.vendor.findMany).not.toHaveBeenCalled();
        expect(db.risk.findMany).not.toHaveBeenCalled();
        // The duplicate is deduplicated for VALIDATION only — both rows persist.
        expect(db.biaDependency.createMany.mock.calls[0][0]).toStrictEqual({
            data: [
                { tenantId: 't-acme', biaId: 'bia-1', dependsOnType: 'PROCESS', dependsOnId: 'node-1' },
                { tenantId: 't-acme', biaId: 'bia-1', dependsOnType: 'PROCESS', dependsOnId: 'node-1' },
                { tenantId: 't-acme', biaId: 'bia-1', dependsOnType: 'ASSET', dependsOnId: 'asset-1' },
            ],
        });
    });

    it('refuses the whole create when one dependency type has a missing target, naming that type', async () => {
        const db = createDb({
            vendor: { findMany: jest.fn().mockResolvedValue([{ id: 'vendor-1' }]) },
            asset: { findMany: jest.fn().mockResolvedValue([]) },
        });

        const err = await createBia(ctx, {
            name: 'Payroll',
            criticality: 'HIGH',
            dependencies: [
                { dependsOnType: 'VENDOR', dependsOnId: 'vendor-1' },
                { dependsOnType: 'ASSET', dependsOnId: 'asset-gone' },
            ],
        }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ValidationError);
        // `badRequest(code, detail)` puts the code in `message` and the prose
        // in `details` — the prose names the offending TYPE, not the id.
        expect((err as ValidationError).message).toBe('INVALID_DEPENDENCY_TARGET');
        expect((err as ValidationError).details).toBe('ASSET not found in this tenant');
        expect(db.businessImpactAnalysis.create).not.toHaveBeenCalled();
    });

    it('reports the offending process node as INVALID_PROCESS_NODE, scoped to the tenant', async () => {
        const db = createDb({
            processNode: {
                findFirst: jest.fn().mockResolvedValue(null),
                findMany: jest.fn().mockResolvedValue([]),
            },
        });

        const err = await createBia(ctx, {
            name: 'Payroll',
            criticality: 'HIGH',
            processNodeId: 'node-other-tenant',
        }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).message).toBe('INVALID_PROCESS_NODE');
        expect((err as ValidationError).details).toBe('Process node not found in this tenant');
        expect(db.processNode.findFirst.mock.calls[0][0]).toStrictEqual({
            where: { id: 'node-other-tenant', tenantId: 't-acme' },
            select: { id: true },
        });
        expect(db.businessImpactAnalysis.create).not.toHaveBeenCalled();
    });

    it('refuses a READER before opening a tenant transaction', async () => {
        createDb();
        const reader = makeRequestContext('READER', { tenantId: 't-acme' });

        await expect(createBia(reader, { name: 'Payroll', criticality: 'LOW' })).rejects.toBeInstanceOf(
            ForbiddenError,
        );
        expect(mockRunInTx).not.toHaveBeenCalled();
    });
});

describe('updateBia — patch semantics', () => {
    function updateDb(existing: unknown = { id: 'bia-1' }) {
        return withDb({
            businessImpactAnalysis: {
                findFirst: jest.fn().mockResolvedValue(existing),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                update: jest.fn(async ({ data }: any) => ({ id: 'bia-1', name: data.name ?? 'Payroll' })),
            },
            processNode: { findFirst: jest.fn().mockResolvedValue({ id: 'node-2' }) },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
    }

    it('writes exactly the keys the patch supplied, sanitised, with reviewedAt parsed to a Date', async () => {
        const db = updateDb();
        const profile = [{ atHours: 24, reputational: 5 }];

        await updateBia(ctx, 'bia-1', {
            name: 'Payroll <i>v2</i>',
            criticality: 'MEDIUM',
            processNodeId: 'node-2',
            rtoHours: 1,
            rpoHours: 0,
            mtpdHours: 12,
            impactProfile: profile,
            notes: '<script>alert(1)</script>Runbook 7',
            ownerUserId: 'u-owner',
            reviewedAt: '2026-03-01T09:00:00.000Z',
        });

        expect(db.businessImpactAnalysis.update.mock.calls[0][0]).toStrictEqual({
            where: { id: 'bia-1' },
            data: {
                name: 'Payroll v2',
                criticality: 'MEDIUM',
                processNodeId: 'node-2',
                rtoHours: 1,
                rpoHours: 0,
                mtpdHours: 12,
                impactProfile: profile,
                notes: 'Runbook 7',
                ownerUserId: 'u-owner',
                reviewedAt: new Date('2026-03-01T09:00:00.000Z'),
            },
        });
    });

    it('writes an empty data object for an empty patch — nothing is written unconditionally', async () => {
        const db = updateDb();

        await updateBia(ctx, 'bia-1', {});

        expect(db.businessImpactAnalysis.update.mock.calls[0][0]).toStrictEqual({
            where: { id: 'bia-1' },
            data: {},
        });
        expect(db.processNode.findFirst).not.toHaveBeenCalled();
        expect(db.businessImpactAnalysis.findFirst.mock.calls[0][0]).toStrictEqual({
            where: { id: 'bia-1', tenantId: 't-acme' },
            select: { id: true },
        });
    });

    it('clears nullable fields when the patch sends null, and drops impactProfile to undefined', async () => {
        const db = updateDb();

        await updateBia(ctx, 'bia-1', {
            processNodeId: null,
            impactProfile: null,
            notes: null,
            ownerUserId: null,
            reviewedAt: null,
        });

        expect(db.businessImpactAnalysis.update.mock.calls[0][0]).toStrictEqual({
            where: { id: 'bia-1' },
            data: {
                processNodeId: null,
                // A JSON column cannot be cleared with `null` through Prisma's
                // default JSON semantics, so a null patch means "leave it".
                impactProfile: undefined,
                notes: null,
                ownerUserId: null,
                reviewedAt: null,
            },
        });
        // A null processNodeId detaches — there is nothing to validate.
        expect(db.processNode.findFirst).not.toHaveBeenCalled();
    });

    it('validates a patched process node against this tenant and writes nothing when it is foreign', async () => {
        const db = updateDb();
        db.processNode.findFirst.mockResolvedValue(null);

        const err = await updateBia(ctx, 'bia-1', { processNodeId: 'node-other-tenant' }).catch(
            (e: unknown) => e,
        );

        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).message).toBe('INVALID_PROCESS_NODE');
        expect(db.processNode.findFirst.mock.calls[0][0]).toStrictEqual({
            where: { id: 'node-other-tenant', tenantId: 't-acme' },
            select: { id: true },
        });
        expect(db.businessImpactAnalysis.update).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('audits the update under the persisted name', async () => {
        const db = updateDb();

        await updateBia(ctx, 'bia-1', { name: 'Renamed <em>ok</em>' });

        expect(logEvent).toHaveBeenCalledWith(db, ctx, {
            action: 'UPDATE',
            entityType: 'BusinessImpactAnalysis',
            entityId: 'bia-1',
            details: 'Updated BIA: Renamed ok',
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'BusinessImpactAnalysis',
                operation: 'updated',
            },
        });
    });
});

describe('addBiaDependency', () => {
    it('validates only the type it was given, persists a tenant-scoped row, and audits that type', async () => {
        const db = withDb({
            businessImpactAnalysis: { findFirst: jest.fn().mockResolvedValue({ id: 'bia-1' }) },
            processNode: { findMany: jest.fn().mockResolvedValue([]) },
            asset: { findMany: jest.fn().mockResolvedValue([]) },
            vendor: { findMany: jest.fn().mockResolvedValue([]) },
            risk: { findMany: jest.fn().mockResolvedValue([{ id: 'risk-1' }]) },
            biaDependency: { create: jest.fn().mockResolvedValue({ id: 'dep-1' }) },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

        const dep = await addBiaDependency(ctx, 'bia-1', {
            dependsOnType: 'RISK',
            dependsOnId: 'risk-1',
        });

        expect(dep).toStrictEqual({ id: 'dep-1' });
        expect(db.businessImpactAnalysis.findFirst.mock.calls[0][0]).toStrictEqual({
            where: { id: 'bia-1', tenantId: 't-acme' },
            select: { id: true },
        });
        expect(db.risk.findMany.mock.calls[0][0]).toStrictEqual({
            where: { tenantId: 't-acme', id: { in: ['risk-1'] } },
            select: { id: true },
            take: 500,
        });
        expect(db.asset.findMany).not.toHaveBeenCalled();
        expect(db.vendor.findMany).not.toHaveBeenCalled();
        expect(db.processNode.findMany).not.toHaveBeenCalled();
        expect(db.biaDependency.create.mock.calls[0][0]).toStrictEqual({
            data: {
                tenantId: 't-acme',
                biaId: 'bia-1',
                dependsOnType: 'RISK',
                dependsOnId: 'risk-1',
            },
        });
        expect(logEvent).toHaveBeenCalledWith(db, ctx, {
            action: 'UPDATE',
            entityType: 'BusinessImpactAnalysis',
            entityId: 'bia-1',
            details: 'Added RISK dependency to BIA',
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'BusinessImpactAnalysis',
                operation: 'updated',
            },
        });
    });
});
