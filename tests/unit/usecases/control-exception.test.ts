/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks +
 * fakeDb shims mirror runtime Prisma contracts; per-line typing has
 * poor cost/benefit in test files (codebase convention — see
 * tests/unit/usecases/control-test.test.ts). */
/**
 * Unit tests for src/app-layer/usecases/control-exception.ts
 *
 * Epic G-5 — Control Exception Register. The lifecycle has hard
 * state-machine invariants the usecase enforces at the application
 * boundary (the DB CHECK is the backstop). Branch coverage here
 * protects:
 *
 *   - RBAC tiers: request/renew need WRITE, approve/reject need
 *     ADMIN. A mix-up lets an EDITOR approve their own exception.
 *   - Transition guard: only REQUESTED → APPROVED / REJECTED. Any
 *     other source status → 400.
 *   - approveException's "expiresAt in the future" guard — approving
 *     an already-expired exception is rejected.
 *   - The concurrent-transition race: repo returns count 0 → 400
 *     "state changed concurrently", NOT a misleading 404.
 *   - renewException's REJECTED-laundering block + the
 *     copy-from-prior-row default chain (justification /
 *     compensatingControlId / riskAcceptedByUserId).
 *   - getExpiringExceptions's `days` validation + null-expiresAt
 *     filter.
 *   - Epic D.2 sanitisation of justification + reason.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/repositories/ControlExceptionRepository', () => ({
    ControlExceptionRepository: {
        list: jest.fn(),
        getById: jest.fn(),
        create: jest.fn(),
        approve: jest.fn(),
        reject: jest.fn(),
        findExpiringWithin: jest.fn(),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => `SANITISED(${s})`),
}));

import {
    listControlExceptions,
    getControlException,
    requestException,
    approveException,
    rejectException,
    renewException,
    getExpiringExceptions,
} from '@/app-layer/usecases/control-exception';
import { ControlExceptionRepository } from '@/app-layer/repositories/ControlExceptionRepository';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '@/app-layer/events/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockRepo = ControlExceptionRepository as jest.Mocked<typeof ControlExceptionRepository>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;
const mockSanitize = sanitizePlainText as jest.MockedFunction<typeof sanitizePlainText>;

const FUTURE = new Date(Date.now() + 30 * 86400000);
const PAST = new Date(Date.now() - 86400000);

beforeEach(() => {
    jest.clearAllMocks();
    mockSanitize.mockImplementation((s: any) => `SANITISED(${s})`);
});

function fakeDb(overrides: Record<string, any> = {}) {
    return {
        control: { findFirst: jest.fn() },
        controlException: { findFirst: jest.fn() },
        // requestException now validates the body-supplied
        // riskAcceptedByUserId against an ACTIVE TenantMembership.
        // Always present on the base shape so no requestException test
        // hits `undefined.findFirst`.
        tenantMembership: { findFirst: jest.fn() },
        ...overrides,
    };
}

describe('listControlExceptions / getControlException — read gate', () => {
    it('rejects a caller without read permission', async () => {
        const ctx = makeRequestContext('READER', {
            permissions: {
                canRead: false,
                canWrite: false,
                canAdmin: false,
                canAudit: false,
                canExport: false,
            },
        });
        await expect(listControlExceptions(ctx)).rejects.toThrow(/permission/i);
        await expect(getControlException(ctx, 'ex-1')).rejects.toThrow(/permission/i);
    });

    it('getControlException throws notFound when the row is absent', async () => {
        mockRepo.getById.mockResolvedValueOnce(null as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        await expect(
            getControlException(makeRequestContext('EDITOR'), 'ex-missing'),
        ).rejects.toThrow(/not found/i);
    });
});

describe('requestException', () => {
    it('rejects a caller without write permission before any DB work', async () => {
        await expect(
            requestException(makeRequestContext('READER'), {
                controlId: 'c1',
                justification: 'why',
                riskAcceptedByUserId: 'u1',
            }),
        ).rejects.toThrow(/permission/i);
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('rejects malformed input (zod) — missing justification', async () => {
        await expect(
            requestException(makeRequestContext('EDITOR'), {
                controlId: 'c1',
                riskAcceptedByUserId: 'u1',
            }),
        ).rejects.toThrow();
    });

    it('throws notFound when the target control is not in the tenant', async () => {
        const db = fakeDb();
        db.control.findFirst.mockResolvedValueOnce(null);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await expect(
            requestException(makeRequestContext('EDITOR'), {
                controlId: 'c-foreign',
                justification: 'why',
                riskAcceptedByUserId: 'u1',
            }),
        ).rejects.toThrow(/control not found/i);
        expect(mockRepo.create).not.toHaveBeenCalled();
    });

    it('throws notFound when the compensating control is not in the tenant', async () => {
        const db = fakeDb();
        // first findFirst → the primary control (found),
        // second findFirst → compensating control (absent)
        db.control.findFirst
            .mockResolvedValueOnce({ id: 'c1', name: 'Primary' })
            .mockResolvedValueOnce(null);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await expect(
            requestException(makeRequestContext('EDITOR'), {
                controlId: 'c1',
                compensatingControlId: 'c-comp-missing',
                justification: 'why',
                riskAcceptedByUserId: 'u1',
            }),
        ).rejects.toThrow(/compensating control not found/i);
        expect(mockRepo.create).not.toHaveBeenCalled();
    });

    it('creates the exception, sanitises justification, and emits a lifecycle audit event', async () => {
        const db = fakeDb();
        db.control.findFirst.mockResolvedValueOnce({ id: 'c1', name: 'Encryption' });
        // Risk acceptor resolves to an ACTIVE member → the new gate passes
        // and the flow reaches ControlExceptionRepository.create, which
        // consumes its own mockResolvedValueOnce (prevents once-queue bleed
        // into the renewException tests).
        db.tenantMembership.findFirst.mockResolvedValueOnce({ id: 'm1' });
        mockRepo.create.mockResolvedValueOnce({ id: 'ex-new' } as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        const result = await requestException(makeRequestContext('EDITOR'), {
            controlId: 'c1',
            justification: '<script>x</script>legit reason',
            riskAcceptedByUserId: 'u1',
        });

        expect(result).toEqual({ exceptionId: 'ex-new' });
        const createArgs = mockRepo.create.mock.calls[0][2] as any;
        expect(createArgs.justification).toBe('SANITISED(<script>x</script>legit reason)');
        expect(createArgs.compensatingControlId).toBeNull();
        expect(mockLog).toHaveBeenCalledTimes(1);
        const logArg = mockLog.mock.calls[0][2] as any;
        expect(logArg.action).toBe('CONTROL_EXCEPTION_REQUESTED');
        expect(logArg.detailsJson.category).toBe('entity_lifecycle');
    });

    it('throws notFound when the risk acceptor is not an active member of the tenant', async () => {
        const db = fakeDb();
        db.control.findFirst.mockResolvedValueOnce({ id: 'c1', name: 'Encryption' });
        // No ACTIVE membership for the supplied riskAcceptedByUserId → the
        // new gate rejects before any repository write.
        db.tenantMembership.findFirst.mockResolvedValueOnce(null);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await expect(
            requestException(makeRequestContext('EDITOR'), {
                controlId: 'c1',
                justification: 'why',
                riskAcceptedByUserId: 'u-not-a-member',
            }),
        ).rejects.toThrow(/active member/i);
        expect(mockRepo.create).not.toHaveBeenCalled();
    });
});

describe('approveException — ADMIN-gated REQUESTED → APPROVED transition', () => {
    it('rejects an EDITOR (write but not admin)', async () => {
        await expect(
            approveException(makeRequestContext('EDITOR'), 'ex-1', { expiresAt: FUTURE }),
        ).rejects.toThrow(/permission/i);
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('throws notFound when the exception row is absent', async () => {
        const db = fakeDb();
        db.controlException.findFirst.mockResolvedValueOnce(null);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await expect(
            approveException(makeRequestContext('ADMIN'), 'ex-x', { expiresAt: FUTURE }),
        ).rejects.toThrow(/not found/i);
    });

    it('rejects approving an exception that is not in REQUESTED state', async () => {
        const db = fakeDb();
        db.controlException.findFirst.mockResolvedValueOnce({
            id: 'ex-1',
            status: 'REJECTED',
            controlId: 'c1',
        });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await expect(
            approveException(makeRequestContext('ADMIN'), 'ex-1', { expiresAt: FUTURE }),
        ).rejects.toThrow(/only REQUESTED rows can be approved/i);
        expect(mockRepo.approve).not.toHaveBeenCalled();
    });

    it('rejects approving with an expiresAt that is already in the past', async () => {
        const db = fakeDb();
        db.controlException.findFirst.mockResolvedValueOnce({
            id: 'ex-1',
            status: 'REQUESTED',
            controlId: 'c1',
        });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await expect(
            approveException(makeRequestContext('ADMIN'), 'ex-1', { expiresAt: PAST }),
        ).rejects.toThrow(/must be in the future/i);
        expect(mockRepo.approve).not.toHaveBeenCalled();
    });

    it('surfaces a 400 (not a 404) when the repo reports a concurrent transition (count 0)', async () => {
        const db = fakeDb();
        db.controlException.findFirst.mockResolvedValueOnce({
            id: 'ex-1',
            status: 'REQUESTED',
            controlId: 'c1',
        });
        mockRepo.approve.mockResolvedValueOnce(0 as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await expect(
            approveException(makeRequestContext('ADMIN'), 'ex-1', { expiresAt: FUTURE }),
        ).rejects.toThrow(/changed concurrently/i);
    });

    it('approves a REQUESTED exception and emits a status_change audit event', async () => {
        const db = fakeDb();
        db.controlException.findFirst.mockResolvedValueOnce({
            id: 'ex-1',
            status: 'REQUESTED',
            controlId: 'c1',
            // Requester differs from the acting ADMIN (makeRequestContext
            // default userId 'user-1') so the separation-of-duties
            // self-approval guard does not fire.
            createdByUserId: 'requester-user',
        });
        mockRepo.approve.mockResolvedValueOnce(1 as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        const result = await approveException(makeRequestContext('ADMIN'), 'ex-1', {
            expiresAt: FUTURE,
        });

        expect(result).toEqual({ exceptionId: 'ex-1', expiresAt: FUTURE });
        const logArg = mockLog.mock.calls[0][2] as any;
        expect(logArg.action).toBe('CONTROL_EXCEPTION_APPROVED');
        expect(logArg.detailsJson.fromStatus).toBe('REQUESTED');
        expect(logArg.detailsJson.toStatus).toBe('APPROVED');
    });
});

describe('rejectException — ADMIN-gated REQUESTED → REJECTED transition', () => {
    it('rejects an EDITOR', async () => {
        await expect(
            rejectException(makeRequestContext('EDITOR'), 'ex-1', { reason: 'no' }),
        ).rejects.toThrow(/permission/i);
    });

    it('rejects rejecting an exception not in REQUESTED state', async () => {
        const db = fakeDb();
        db.controlException.findFirst.mockResolvedValueOnce({
            id: 'ex-1',
            status: 'APPROVED',
            controlId: 'c1',
        });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await expect(
            rejectException(makeRequestContext('ADMIN'), 'ex-1', { reason: 'late' }),
        ).rejects.toThrow(/only REQUESTED rows can be rejected/i);
    });

    it('surfaces a 400 on a concurrent-transition race (count 0)', async () => {
        const db = fakeDb();
        db.controlException.findFirst.mockResolvedValueOnce({
            id: 'ex-1',
            status: 'REQUESTED',
            controlId: 'c1',
        });
        mockRepo.reject.mockResolvedValueOnce(0 as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await expect(
            rejectException(makeRequestContext('ADMIN'), 'ex-1', { reason: 'no' }),
        ).rejects.toThrow(/changed concurrently/i);
    });

    it('rejects a REQUESTED exception, sanitises the reason, and emits a status_change event', async () => {
        const db = fakeDb();
        db.controlException.findFirst.mockResolvedValueOnce({
            id: 'ex-1',
            status: 'REQUESTED',
            controlId: 'c1',
            // Requester differs from the acting ADMIN so the SoD
            // self-rejection guard does not fire.
            createdByUserId: 'requester-user',
        });
        mockRepo.reject.mockResolvedValueOnce(1 as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        const result = await rejectException(makeRequestContext('ADMIN'), 'ex-1', {
            reason: '<b>bad</b> rationale',
        });

        expect(result).toEqual({ exceptionId: 'ex-1' });
        // 4th arg of reject() is the sanitised reason.
        expect(mockRepo.reject.mock.calls[0][4]).toBe('SANITISED(<b>bad</b> rationale)');
        const logArg = mockLog.mock.calls[0][2] as any;
        expect(logArg.detailsJson.toStatus).toBe('REJECTED');
    });
});

describe('renewException', () => {
    it('rejects a caller without write permission', async () => {
        await expect(
            renewException(makeRequestContext('READER'), 'ex-1', {}),
        ).rejects.toThrow(/permission/i);
    });

    it('throws notFound when the prior row is absent', async () => {
        const db = fakeDb();
        db.controlException.findFirst.mockResolvedValueOnce(null);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await expect(
            renewException(makeRequestContext('EDITOR'), 'ex-gone', {}),
        ).rejects.toThrow(/prior exception not found/i);
    });

    it('refuses to renew a REJECTED exception (no laundering a declined exception)', async () => {
        const db = fakeDb();
        db.controlException.findFirst.mockResolvedValueOnce({
            id: 'ex-1',
            controlId: 'c1',
            justification: 'old',
            compensatingControlId: null,
            riskAcceptedByUserId: 'u1',
            status: 'REJECTED',
        });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await expect(
            renewException(makeRequestContext('EDITOR'), 'ex-1', {}),
        ).rejects.toThrow(/cannot renew a REJECTED exception/i);
        expect(mockRepo.create).not.toHaveBeenCalled();
    });

    it('copies justification + compensatingControlId + riskAcceptedByUserId from the prior row when omitted', async () => {
        const db = fakeDb();
        db.controlException.findFirst.mockResolvedValueOnce({
            id: 'ex-prior',
            controlId: 'c1',
            justification: 'prior-justification',
            compensatingControlId: 'comp-prior',
            riskAcceptedByUserId: 'risk-owner-prior',
            status: 'EXPIRED',
        });
        mockRepo.create.mockResolvedValueOnce({ id: 'ex-renewed' } as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        const result = await renewException(makeRequestContext('EDITOR'), 'ex-prior', {});

        expect(result).toEqual({ exceptionId: 'ex-renewed', renewedFromId: 'ex-prior' });
        const createArgs = mockRepo.create.mock.calls[0][2] as any;
        // omitted justification → copied verbatim, NOT re-sanitised.
        expect(createArgs.justification).toBe('prior-justification');
        expect(createArgs.compensatingControlId).toBe('comp-prior');
        expect(createArgs.riskAcceptedByUserId).toBe('risk-owner-prior');
        expect(createArgs.renewedFromId).toBe('ex-prior');
    });

    it('sanitises a supplied justification and honours an explicit-null compensatingControlId override', async () => {
        const db = fakeDb();
        db.controlException.findFirst.mockResolvedValueOnce({
            id: 'ex-prior',
            controlId: 'c1',
            justification: 'prior-justification',
            compensatingControlId: 'comp-prior',
            riskAcceptedByUserId: 'risk-owner-prior',
            status: 'APPROVED',
        });
        mockRepo.create.mockResolvedValueOnce({ id: 'ex-renewed' } as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await renewException(makeRequestContext('EDITOR'), 'ex-prior', {
            justification: '<i>fresh</i> rationale',
            compensatingControlId: null,
        });

        const createArgs = mockRepo.create.mock.calls[0][2] as any;
        expect(createArgs.justification).toBe('SANITISED(<i>fresh</i> rationale)');
        // explicit null override must NOT fall back to the prior value.
        expect(createArgs.compensatingControlId).toBeNull();
    });
});

describe('getExpiringExceptions', () => {
    it('rejects a caller without read permission', async () => {
        const ctx = makeRequestContext('READER', {
            permissions: {
                canRead: false,
                canWrite: false,
                canAdmin: false,
                canAudit: false,
                canExport: false,
            },
        });
        await expect(getExpiringExceptions(ctx, 30)).rejects.toThrow(/permission/i);
    });

    it('rejects a negative days argument', async () => {
        await expect(
            getExpiringExceptions(makeRequestContext('EDITOR'), -1),
        ).rejects.toThrow(/non-negative/i);
    });

    it('rejects a non-finite days argument', async () => {
        await expect(
            getExpiringExceptions(makeRequestContext('EDITOR'), Number.POSITIVE_INFINITY),
        ).rejects.toThrow(/finite/i);
    });

    it('filters out rows whose expiresAt is null and maps control name/code', async () => {
        const exp = new Date(Date.now() + 5 * 86400000);
        mockRepo.findExpiringWithin.mockResolvedValueOnce([
            {
                id: 'ex-1',
                tenantId: 'tenant-1',
                controlId: 'c1',
                expiresAt: exp,
                riskAcceptedByUserId: 'u1',
                control: { name: 'Encryption', code: 'CR-1' },
            },
            // null expiresAt → must be dropped by the filter
            {
                id: 'ex-2',
                tenantId: 'tenant-1',
                controlId: 'c2',
                expiresAt: null,
                riskAcceptedByUserId: 'u2',
                control: null,
            },
        ] as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));

        const rows = await getExpiringExceptions(makeRequestContext('EDITOR'), 7);

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            id: 'ex-1',
            controlName: 'Encryption',
            controlCode: 'CR-1',
            expiresAt: exp,
        });
    });

    it('falls back to null controlName/controlCode when the joined control is absent', async () => {
        const exp = new Date(Date.now() + 2 * 86400000);
        mockRepo.findExpiringWithin.mockResolvedValueOnce([
            {
                id: 'ex-3',
                tenantId: 'tenant-1',
                controlId: 'c3',
                expiresAt: exp,
                riskAcceptedByUserId: 'u3',
                control: null,
            },
        ] as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));

        const rows = await getExpiringExceptions(makeRequestContext('EDITOR'), 0);

        expect(rows[0].controlName).toBeNull();
        expect(rows[0].controlCode).toBeNull();
    });
});
