/**
 * Coverage for the half of `src/lib/auth/security-events.ts` that
 * `tests/unit/security-events.test.ts` does not reach.
 *
 * That file exercises `recordLoginSuccess` / `recordLoginFailure`. The
 * five account-lifecycle emitters — email-verification issued/verified
 * and the three password events — were entirely untested, as was the
 * `resolvePrimaryTenantId` failure path they all share.
 *
 * The thing worth guarding here is not that each function "runs". It is
 * that each one:
 *   - writes its OWN action constant (a copy-paste slip between five
 *     near-identical bodies would be invisible otherwise),
 *   - takes the caller's tenantId when given one and does NOT hit the
 *     database for it,
 *   - REFUSES to write an audit row when no tenant can be attributed,
 *     rather than inventing a sentinel tenant, and
 *   - never puts the plaintext email into the audit payload.
 */

// ── Mocks (hoisted above the imports by Jest) ───────────────────────

type MembershipRow = { tenantId: string } | null;
const mockFindFirst = jest.fn<Promise<MembershipRow>, [unknown]>();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenantMembership: { findFirst: (a: unknown) => mockFindFirst(a) },
    },
}));

type AuditEntryArg = {
    tenantId: string;
    userId: string;
    action: string;
    entity: string;
    entityId: string;
    requestId: string | null;
    detailsJson: {
        category: string;
        auth: {
            method: string;
            identifierHash: string;
            reason?: string;
        };
    };
};
const mockAppendAuditEntry = jest.fn<Promise<unknown>, [AuditEntryArg]>();
jest.mock('@/lib/audit', () => ({
    __esModule: true,
    appendAuditEntry: (a: AuditEntryArg) => mockAppendAuditEntry(a),
}));

const mockLoggerInfo = jest.fn<void, [string, Record<string, unknown>?]>();
const mockLoggerWarn = jest.fn<void, [string, Record<string, unknown>?]>();
jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: {
        info: mockLoggerInfo,
        warn: mockLoggerWarn,
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

import {
    AUTH_ACTIONS,
    hashEmailForLog,
    recordEmailVerificationIssued,
    recordEmailVerified,
    recordPasswordResetRequested,
    recordPasswordResetCompleted,
    recordPasswordChanged,
    recordLoginFailure,
} from '@/lib/auth/security-events';

const EMAIL = 'Alice@Example.COM';

/** The single audit entry the emitter under test wrote. */
function auditedEntry(): AuditEntryArg {
    expect(mockAppendAuditEntry).toHaveBeenCalledTimes(1);
    return mockAppendAuditEntry.mock.calls[0][0];
}

beforeEach(() => {
    mockFindFirst.mockReset();
    mockAppendAuditEntry.mockReset();
    mockAppendAuditEntry.mockResolvedValue({ id: 'a', entryHash: 'h', previousHash: null });
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
});

// ─── The five lifecycle emitters, table-driven ──────────────────────

type Emitter = (params: {
    userId: string;
    email: string;
    tenantId?: string | null;
    requestId?: string;
}) => Promise<void>;

const LIFECYCLE_EMITTERS: ReadonlyArray<[string, Emitter, string]> = [
    [
        'recordEmailVerificationIssued',
        recordEmailVerificationIssued,
        AUTH_ACTIONS.EMAIL_VERIFICATION_ISSUED,
    ],
    ['recordEmailVerified', recordEmailVerified, AUTH_ACTIONS.EMAIL_VERIFIED],
    [
        'recordPasswordResetRequested',
        recordPasswordResetRequested,
        AUTH_ACTIONS.PASSWORD_RESET_REQUESTED,
    ],
    [
        'recordPasswordResetCompleted',
        recordPasswordResetCompleted,
        AUTH_ACTIONS.PASSWORD_RESET_COMPLETED,
    ],
    ['recordPasswordChanged', recordPasswordChanged, AUTH_ACTIONS.PASSWORD_CHANGED],
];

describe.each(LIFECYCLE_EMITTERS)('%s', (_name, emit, expectedAction) => {
    it('writes its own action constant, scoped to the caller-supplied tenant', async () => {
        await emit({
            userId: 'u1',
            email: EMAIL,
            tenantId: 't1',
            requestId: 'req-1',
        });

        const entry = auditedEntry();
        // The action is the whole point: five near-identical bodies make a
        // copy-pasted constant the most likely defect in this file.
        expect(entry.action).toBe(expectedAction);
        expect(entry.tenantId).toBe('t1');
        expect(entry.userId).toBe('u1');
        expect(entry.entity).toBe('Auth');
        expect(entry.entityId).toBe('u1');
        expect(entry.requestId).toBe('req-1');
        // Reset/change/verification only ever apply to credentials accounts.
        expect(entry.detailsJson.auth.method).toBe('credentials');
    });

    it('does NOT query membership when the caller already knows the tenant', async () => {
        await emit({ userId: 'u1', email: EMAIL, tenantId: 't1' });
        expect(mockFindFirst).not.toHaveBeenCalled();
    });

    it('resolves the primary tenant from ACTIVE memberships when none is supplied', async () => {
        mockFindFirst.mockResolvedValue({ tenantId: 't-resolved' });

        await emit({ userId: 'u1', email: EMAIL });

        expect(mockFindFirst).toHaveBeenCalledWith({
            where: { userId: 'u1', status: 'ACTIVE' },
            orderBy: { createdAt: 'asc' },
            select: { tenantId: true },
        });
        expect(auditedEntry().tenantId).toBe('t-resolved');
    });

    it('REFUSES to write an audit row when the user has no ACTIVE membership', async () => {
        mockFindFirst.mockResolvedValue(null);

        await emit({ userId: 'u1', email: EMAIL });

        // No sentinel tenant is invented — the audit trail is per-tenant
        // and hash-chained, so an unattributable row has nowhere to go.
        expect(mockAppendAuditEntry).not.toHaveBeenCalled();
        // The event is not lost, though: it still left an operational log.
        expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    });

    it('treats an explicit tenantId of null as "unknown" and falls back to lookup', async () => {
        mockFindFirst.mockResolvedValue({ tenantId: 't-resolved' });
        await emit({ userId: 'u1', email: EMAIL, tenantId: null });
        expect(mockFindFirst).toHaveBeenCalledTimes(1);
        expect(auditedEntry().tenantId).toBe('t-resolved');
    });

    it('never puts the plaintext email in the audit payload — only the hash', async () => {
        await emit({ userId: 'u1', email: EMAIL, tenantId: 't1' });

        const serialised = JSON.stringify(auditedEntry());
        expect(serialised).not.toContain('Alice@Example.COM');
        expect(serialised).not.toContain('alice@example.com');
        expect(auditedEntry().detailsJson.auth.identifierHash).toBe(
            hashEmailForLog(EMAIL),
        );
    });

});

// ─── Shared-helper behaviour — asserted ONCE, not five times ────────
//
// The three cases below live in `writeAudit` / `resolvePrimaryTenantId`,
// which all five emitters call. Running them per-emitter produced five
// identical failures for one defect and zero extra detection: dropping
// `?? null` from `writeAudit` failed all five copies, and so did making
// `resolvePrimaryTenantId` rethrow. They are therefore driven through a
// single representative emitter.
//
// The rows that REMAIN in the table above are the ones a per-emitter
// mutation proved are NOT shared — including the plaintext-email row,
// which the review proposed lifting too. Rewiring ONE emitter to pass
// the wrong address to `writeAudit` fails exactly one test, its own
// `never puts the plaintext email…` row, so that row detects a
// per-emitter copy-paste slip that nothing else in the repo sees. It
// stays in the table.

describe('shared audit-write helper (via recordPasswordChanged)', () => {
    it('REFUSES to write an audit row when the membership read THROWS', async () => {
        mockFindFirst.mockRejectedValue(new Error('database unreachable'));

        // A DB blip must degrade to log-only, never reject into the auth path.
        await expect(
            recordPasswordChanged({ userId: 'u1', email: EMAIL }),
        ).resolves.toBeUndefined();
        expect(mockAppendAuditEntry).not.toHaveBeenCalled();
    });

    it('records requestId as null (not undefined) when the caller has none', async () => {
        await recordPasswordChanged({ userId: 'u1', email: EMAIL, tenantId: 't1' });
        // The column is nullable; `undefined` would make Prisma skip the
        // field entirely and silently drop the correlation id.
        expect(auditedEntry().requestId).toBeNull();
    });

    it('survives an audit-write failure without rejecting the caller', async () => {
        mockAppendAuditEntry.mockRejectedValue(new Error('chain head moved'));

        await expect(
            recordPasswordChanged({ userId: 'u1', email: EMAIL, tenantId: 't1' }),
        ).resolves.toBeUndefined();

        expect(mockLoggerWarn).toHaveBeenCalledWith(
            'auth audit write failed',
            expect.objectContaining({
                component: 'auth',
                action: AUTH_ACTIONS.PASSWORD_CHANGED,
                error: 'chain head moved',
            }),
        );
    });
});

// ─── The five actions must be distinct ──────────────────────────────

describe('lifecycle action constants', () => {
    it('are five DISTINCT values — a duplicate would silently merge two events', () => {
        const actions = LIFECYCLE_EMITTERS.map(([, , action]) => action);
        expect(new Set(actions).size).toBe(5);
    });
});

// ─── recordLoginFailure — the enumeration guard ─────────────────────

describe('recordLoginFailure — userId is withheld for unknown_email', () => {
    it('omits userId from the log line when the reason is unknown_email', async () => {
        mockFindFirst.mockResolvedValue(null);

        await recordLoginFailure({
            email: EMAIL,
            method: 'credentials',
            reason: 'unknown_email',
            // A userId present ALONGSIDE unknown_email is contradictory,
            // but the guard must hold regardless of what the caller passes:
            // logging it would confirm that the address maps to an account.
            userId: 'u-should-not-appear',
        });

        const fields = mockLoggerWarn.mock.calls[0][1] as Record<string, unknown>;
        expect(fields).not.toHaveProperty('userId');
        expect(fields.reason).toBe('unknown_email');
        expect(fields.identifierHash).toBe(hashEmailForLog(EMAIL));
    });

    it('omits userId when the reason permits it but no userId was resolved', async () => {
        await recordLoginFailure({
            email: EMAIL,
            method: 'credentials',
            reason: 'credentials_invalid',
        });

        const fields = mockLoggerWarn.mock.calls[0][1] as Record<string, unknown>;
        expect(fields).not.toHaveProperty('userId');
        expect(mockAppendAuditEntry).not.toHaveBeenCalled();
    });

    it('INCLUDES userId when the reason is not unknown_email and the user resolved', async () => {
        await recordLoginFailure({
            email: EMAIL,
            method: 'credentials',
            reason: 'credentials_invalid',
            userId: 'u1',
            tenantId: 't1',
        });

        const fields = mockLoggerWarn.mock.calls[0][1] as Record<string, unknown>;
        expect(fields.userId).toBe('u1');
    });

    it('does not attempt a tenant lookup when there is no userId to look up', async () => {
        await recordLoginFailure({
            email: EMAIL,
            method: 'google',
            reason: 'unknown_email',
        });
        expect(mockFindFirst).not.toHaveBeenCalled();
        expect(mockAppendAuditEntry).not.toHaveBeenCalled();
    });
});

// ─── hashEmailForLog ────────────────────────────────────────────────

// Case/whitespace normalisation is NOT retested here: it is already
// asserted by 'hashEmailForLog is deterministic and case/whitespace-
// insensitive' in tests/unit/security-events.test.ts. A duplicate of it
// here fired on the same mutation and detected nothing the sibling
// missed, so it was removed rather than kept as decoration.
describe('hashEmailForLog', () => {
    it('is a 16-hex-char truncated SHA-256, not the address itself', () => {
        const h = hashEmailForLog(EMAIL);
        expect(h).toMatch(/^[0-9a-f]{16}$/);
        expect(h).not.toContain('alice');
    });

    it('distinguishes different addresses', () => {
        expect(hashEmailForLog('a@example.com')).not.toBe(
            hashEmailForLog('b@example.com'),
        );
    });

    it('tolerates a NULLISH identifier rather than throwing in the auth path', () => {
        // The `email ?? ''` guard exists because the auth path calls this
        // on failure branches where no address was ever parsed. Passing
        // `''` would NOT exercise it (empty string is not nullish), so the
        // cast is deliberate: it reproduces the untyped runtime value the
        // guard is actually defending against.
        const missing = undefined as unknown as string;
        expect(() => hashEmailForLog(missing)).not.toThrow();
        expect(hashEmailForLog(missing)).toBe(hashEmailForLog(''));
    });
});
