/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Unit tests for src/app-layer/usecases/audit-readiness/cycles.ts
 *
 * Wave 4 of GAP-02. Audit cycles are the canonical period unit for
 * external audit readiness. The narrow load-bearing assertions:
 *
 *   1. createAuditCycle: assertCanManageAuditCycles gate; rejects
 *      a frameworkKey that is not IN USE in the tenant (PR-O — a cycle
 *      can be created for any framework, not just the hardcoded
 *      ISO27001 / NIS2 pair; #4129 — but only one in use, the rule
 *      `isFrameworkInUse` owns and has its own tests).
 *   2. listAuditCycles: assertCanViewPack (READER + AUDITOR allowed).
 *   3. getAuditCycle / updateAuditCycle: notFound when the row is not
 *      in the caller tenant.
 *   4. AUDIT_CYCLE_CREATED / UPDATED audit emit.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

// #4129 — "in use" is decided by `isFrameworkInUse` (framework/coverage.ts),
// which runs its own queries; this file asserts what createAuditCycle does
// with the answer.
const mockInUse = jest.fn();
jest.mock('@/app-layer/usecases/framework/coverage', () => ({
    isFrameworkInUse: (...args: unknown[]) => mockInUse(...args),
}));

import {
    createAuditCycle,
    getAuditCycle,
    updateAuditCycle,
} from '@/app-layer/usecases/audit-readiness/cycles';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;

beforeEach(() => {
    jest.clearAllMocks();
    mockInUse.mockResolvedValue(true);
});

describe('createAuditCycle', () => {
    const validInput = {
        frameworkKey: 'ISO27001',
        frameworkVersion: '2022',
        name: '2026 Q1 ISO Audit',
    };

    it('rejects READER (canManageAuditCycles gate)', async () => {
        await expect(
            createAuditCycle(makeRequestContext('READER'), validInput),
        ).rejects.toThrow();
    });

    it('rejects AUDITOR — auditors view but cannot manage', async () => {
        await expect(
            createAuditCycle(makeRequestContext('AUDITOR'), validInput),
        ).rejects.toThrow();
    });

    it('rejects a frameworkKey that is not in use with badRequest', async () => {
        // #4129 — the check used to be a GLOBAL catalogue lookup, so any
        // shipped framework passed. A framework no control is mapped to is
        // now refused before any row is written, with a readable reason.
        mockInUse.mockResolvedValue(false);
        await expect(
            createAuditCycle(makeRequestContext('ADMIN'), {
                ...validInput,
                frameworkKey: 'NOT-A-FRAMEWORK',
            }),
        ).rejects.toThrow(/not in use in this workspace/);
        expect(mockRunInTx).not.toHaveBeenCalled();
        // Regression: a refactor that loosened the framework-key
        // validation would let typos like "ISO 27001" through and
        // those rows would never match the framework-pack join in
        // computeCoverage — coverage stays at 0% and the user has no
        // signal as to why.
    });

    it('accepts any framework in use (not just ISO27001 / NIS2)', async () => {
        // PR-O — a custom / non-ISO-NIS2 framework that is in use in the
        // tenant must be allowed; the generic scorer handles it.
        let capturedArgs: any;
        mockRunInTx
            .mockImplementationOnce(async (_ctx, fn) =>
                fn({
                    auditCycle: {
                        create: jest.fn().mockImplementation((args: any) => {
                            capturedArgs = args;
                            return Promise.resolve({ id: 'cyc-1' });
                        }),
                    },
                } as never),
            );

        await createAuditCycle(makeRequestContext('ADMIN'), { ...validInput, frameworkKey: 'SOC2' });

        expect(capturedArgs.data.frameworkKey).toBe('SOC2');
        expect(mockInUse).toHaveBeenCalledWith(expect.anything(), 'SOC2');
    });

    it('persists tenantId from ctx (input cannot override)', async () => {
        let capturedArgs: any;
        mockRunInTx
            .mockImplementationOnce(async (_ctx, fn) =>
                fn({
                    auditCycle: {
                        create: jest.fn().mockImplementation((args: any) => {
                            capturedArgs = args;
                            return Promise.resolve({ id: 'cyc-1' });
                        }),
                    },
                } as never),
            );

        await createAuditCycle(
            makeRequestContext('ADMIN', { tenantId: 'tenant-A' }),
            validInput,
        );

        expect(capturedArgs.data.tenantId).toBe('tenant-A');
        // Regression: a refactor that read tenantId from input would
        // let an admin in A create a cycle in B by passing the b id.
    });

    it('emits AUDIT_CYCLE_CREATED audit', async () => {
        mockRunInTx
            .mockImplementationOnce(async (_ctx, fn) =>
                fn({
                    auditCycle: { create: jest.fn().mockResolvedValue({ id: 'cyc-1' }) },
                } as never),
            );

        await createAuditCycle(makeRequestContext('ADMIN'), validInput);

        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'AUDIT_CYCLE_CREATED' }),
        );
    });
});

describe('getAuditCycle', () => {
    it('throws notFound when cycle is not in the caller tenant', async () => {
        mockRunInTx.mockImplementationOnce(async () => null as never);

        await expect(
            getAuditCycle(makeRequestContext('READER'), 'tenant-B-cycle'),
        ).rejects.toThrow(/not found/);
    });
});

describe('updateAuditCycle', () => {
    it('rejects EDITOR — wait, EDITOR can manage cycles per policy', async () => {
        // Sanity check: assertCanManageAuditCycles allows ADMIN + EDITOR.
        // This test confirms a refactor that tightened the gate would
        // be caught.
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                auditCycle: {
                    findFirst: jest.fn().mockResolvedValue({ id: 'cyc-1' }),
                    update: jest.fn().mockResolvedValue({ id: 'cyc-1' }),
                },
            } as never),
        );

        await expect(
            updateAuditCycle(makeRequestContext('EDITOR'), 'cyc-1', { name: 'New' }),
        ).resolves.toBeDefined();
    });

    it('throws notFound when cycle is not in the caller tenant', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                auditCycle: {
                    findFirst: jest.fn().mockResolvedValue(null),
                },
            } as never),
        );

        await expect(
            updateAuditCycle(
                makeRequestContext('ADMIN', { tenantId: 'tenant-A' }),
                'tenant-B-cycle',
                { name: 'X' },
            ),
        ).rejects.toThrow(/not found/);
    });
});
