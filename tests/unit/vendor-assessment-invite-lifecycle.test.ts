/**
 * `resendAssessmentInvite` + `revokeAssessmentLink`.
 *
 * Both exports had ZERO unit-test references — `vendor-assessment-send.ts` sat
 * at 55.5% FUNCTION coverage because two of its three exports were never
 * called, not because conditionals were missed. Only the DB-backed
 * `tests/integration/vendor-assessment-lifecycle.test.ts` touched this ground.
 *
 * These two manage an EXTERNAL access token — a link a third party holds — so
 * the assertions here are about token lifetime, not about row counts. The two
 * that matter, and they pull in opposite directions by design:
 *
 *   resend  MUST rotate.     A resend that reused the hash would leave any
 *                            already-circulating link live.
 *   revoke  MUST NOT rotate. Rotating is useless when the goal is to kill a
 *                            leaked link; the usecase docstring says exactly
 *                            this, and the kill switch exists because the only
 *                            prior recourses were waiting for expiry or
 *                            corrupting the lifecycle to get a security outcome.
 */

const mockTx = {
    vendorAssessment: { findFirst: jest.fn(), update: jest.fn() },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: unknown, fn: (db: unknown) => Promise<unknown>) => fn(mockTx),
    ),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockEnqueueEmail = jest.fn();
jest.mock('@/app-layer/notifications/enqueue', () => ({
    enqueueEmail: (...args: unknown[]) => mockEnqueueEmail(...args),
}));

import {
    resendAssessmentInvite,
    revokeAssessmentLink,
} from '@/app-layer/usecases/vendor-assessment-send';
import { logEvent } from '@/app-layer/events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { getPermissionsForRole } from '@/lib/permissions';

const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;
const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;

// `assertCanRunAssessment` reads the CUSTOM-ROLE-AWARE set (`vendors.edit`),
// not the coarse `canWrite` tier — so the knob has to move that key.
function makeCtx(opts: { canRun?: boolean; tenantId?: string } = {}) {
    const canRun = opts.canRun ?? true;
    const base = getPermissionsForRole('ADMIN');
    return {
        requestId: 'req-1',
        userId: 'user-1',
        tenantId: opts.tenantId ?? 'tenant-1',
        role: 'ADMIN' as const,
        permissions: {
            canRead: true, canWrite: true, canAdmin: false,
            canAudit: false, canExport: false,
        },
        appPermissions: {
            ...base,
            vendors: { ...base.vendors, edit: canRun, create: canRun },
        },
    };
}

const row = (over: Record<string, unknown> = {}) => ({
    id: 'a1',
    status: 'SENT',
    respondentEmail: 'security@vendor.example',
    revokedAt: null,
    externalAccessTokenHash: 'OLD-HASH',
    vendor: { id: 'v1', name: 'Acme' },
    templateVersion: { name: 'SIG Lite v3' },
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    mockTx.vendorAssessment.findFirst.mockReset();
    mockTx.vendorAssessment.update.mockReset();
    mockTx.vendorAssessment.update.mockResolvedValue({});
    mockEnqueueEmail.mockReset();
    mockEnqueueEmail.mockResolvedValue({ id: 'outbox-1' });
});

describe('resendAssessmentInvite', () => {
    it('refuses without vendors.edit, before opening a transaction', async () => {
        await expect(resendAssessmentInvite(makeCtx({ canRun: false }), 'a1'))
            .rejects.toThrow(/Only ADMIN or EDITOR/);
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('scopes the lookup to ctx.tenantId and 404s outside it', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValue(null);
        await expect(
            resendAssessmentInvite(makeCtx({ tenantId: 'tenant-Z' }), 'other-tenants-id'),
        ).rejects.toThrow(/Assessment not found/);
        expect(mockTx.vendorAssessment.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'other-tenants-id', tenantId: 'tenant-Z' },
            }),
        );
    });

    // THE security property. The old link is unrecoverable (hash-only storage),
    // so "resend" cannot mean "send the same link again" — it mints a new one
    // and the old hash must be gone. A resend that wrote the same hash back
    // would leave a link the operator believes they replaced still working.
    it('mints a FRESH token, replacing the stored hash', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValue(row());
        const out = await resendAssessmentInvite(makeCtx(), 'a1');

        const data = mockTx.vendorAssessment.update.mock.calls[0][0].data;
        expect(data.externalAccessTokenHash).toEqual(expect.any(String));
        expect(data.externalAccessTokenHash).not.toBe('OLD-HASH');
        // The RAW token is returned to the caller but must never be what is
        // stored — hash-only persistence is the invariant the send path pins.
        expect(out.externalAccessToken).toEqual(expect.any(String));
        expect(data.externalAccessTokenHash).not.toBe(out.externalAccessToken);
    });

    it('re-stamps sentAt and sentByUserId', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValue(row());
        await resendAssessmentInvite(makeCtx(), 'a1');
        const data = mockTx.vendorAssessment.update.mock.calls[0][0].data;
        expect(data.sentAt).toBeInstanceOf(Date);
        expect(data.sentByUserId).toBe('user-1');
    });

    it.each([
        ['DRAFT'], ['SUBMITTED'], ['REVIEWED'], ['CLOSED'],
    ])('refuses to resend an assessment in status %s', async (status) => {
        mockTx.vendorAssessment.findFirst.mockResolvedValue(row({ status }));
        await expect(resendAssessmentInvite(makeCtx(), 'a1'))
            .rejects.toThrow(/Only SENT or IN_PROGRESS assessments can be resent/);
        // Load-bearing: the rejection alone does not say the token was left
        // alone. A resend that minted first and validated second would have
        // already invalidated the live link.
        expect(mockTx.vendorAssessment.update).not.toHaveBeenCalled();
    });

    it('allows IN_PROGRESS as well as SENT', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValue(row({ status: 'IN_PROGRESS' }));
        await expect(resendAssessmentInvite(makeCtx(), 'a1')).resolves.toBeDefined();
    });

    it('refuses when there is no respondent email to send to', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValue(row({ respondentEmail: null }));
        await expect(resendAssessmentInvite(makeCtx(), 'a1'))
            .rejects.toThrow(/no respondent email/);
        expect(mockTx.vendorAssessment.update).not.toHaveBeenCalled();
    });

    // clamp(n, 1, 90) with NaN -> min. An unclamped expiry is a link that
    // outlives the engagement.
    it.each([
        [undefined, 14],
        [1, 1],
        [90, 90],
        [0, 1],
        [365, 90],
        [-5, 1],
        [Number.NaN, 1],
    ])('clamps expiresInDays %p to %p days', async (given, expectedDays) => {
        mockTx.vendorAssessment.findFirst.mockResolvedValue(row());
        const before = Date.now();
        const out = await resendAssessmentInvite(
            makeCtx(), 'a1',
            given === undefined ? {} : { expiresInDays: given as number },
        );
        const after = Date.now();
        // Bracketed by BOTH clock reads rather than measured from `before`
        // alone. The usecase calls its own `Date.now()` strictly after mine, so
        // a one-sided `<= expectedDays` window fails on any drift between the
        // two — which it did, intermittently, on unrelated mutation runs.
        const span = expectedDays * 86_400_000;
        expect(out.expiresAt.getTime()).toBeGreaterThanOrEqual(before + span);
        expect(out.expiresAt.getTime()).toBeLessThanOrEqual(after + span);
    });

    it('queues the invitation email carrying the NEW raw token in the link', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValue(row());
        const out = await resendAssessmentInvite(makeCtx(), 'a1', {
            appOriginOverride: 'https://app.example.com/',
        });
        const payload = mockEnqueueEmail.mock.calls[0][1];
        expect(payload.type).toBe('VENDOR_ASSESSMENT_INVITATION');
        expect(payload.toEmail).toBe('security@vendor.example');
        // Trailing slash on the override is stripped, so the URL has no `//`.
        expect(payload.payload.responseUrl).toBe(
            `https://app.example.com/vendor-assessment/a1?t=${out.externalAccessToken}`,
        );
        expect(out.notificationQueued).toBe(true);
    });

    it('reports notificationQueued false when the outbox declines', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValue(row());
        mockEnqueueEmail.mockResolvedValue(null);
        const out = await resendAssessmentInvite(makeCtx(), 'a1');
        expect(out.notificationQueued).toBe(false);
    });

    it('audits the resend', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValue(row());
        await resendAssessmentInvite(makeCtx(), 'a1');
        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(), expect.anything(),
            expect.objectContaining({
                action: 'VENDOR_ASSESSMENT_RESENT',
                entityType: 'VendorAssessment',
                entityId: 'a1',
            }),
        );
    });
});

describe('revokeAssessmentLink', () => {
    it('refuses without vendors.edit, before opening a transaction', async () => {
        await expect(revokeAssessmentLink(makeCtx({ canRun: false }), 'a1'))
            .rejects.toThrow(/Only ADMIN or EDITOR/);
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('scopes the lookup to ctx.tenantId and 404s outside it', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValue(null);
        await expect(
            revokeAssessmentLink(makeCtx({ tenantId: 'tenant-Z' }), 'other-tenants-id'),
        ).rejects.toThrow(/Assessment not found/);
    });

    it('refuses when there is no external link to revoke', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValue(
            row({ externalAccessTokenHash: null }),
        );
        await expect(revokeAssessmentLink(makeCtx(), 'a1'))
            .rejects.toThrow(/no external link to revoke/);
        expect(mockTx.vendorAssessment.update).not.toHaveBeenCalled();
    });

    it('stamps revokedAt and audits it', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValue(row());
        const out = await revokeAssessmentLink(makeCtx(), 'a1');

        expect(out.revokedAt).toBeInstanceOf(Date);
        const call = mockTx.vendorAssessment.update.mock.calls[0][0];
        expect(call.data).toEqual({ revokedAt: out.revokedAt });
        // Tenant-scoped on the WRITE too, not only on the read — defence in
        // depth against an id that resolved through a widened read.
        expect(call.where).toEqual({ id: 'a1', tenantId: 'tenant-1' });
        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(), expect.anything(),
            expect.objectContaining({ action: 'VENDOR_ASSESSMENT_LINK_REVOKED' }),
        );
    });

    // Idempotent by design: the operator's intent (this link must not work) is
    // already satisfied. Returning the ORIGINAL timestamp is the part that
    // matters — overwriting it would falsify when the link actually died, which
    // is the one fact an incident review needs from this row.
    it('is idempotent: a second revoke returns the ORIGINAL timestamp and writes nothing', async () => {
        const firstRevoke = new Date('2026-08-01T09:00:00Z');
        mockTx.vendorAssessment.findFirst.mockResolvedValue(row({ revokedAt: firstRevoke }));

        const out = await revokeAssessmentLink(makeCtx(), 'a1');

        expect(out.revokedAt).toEqual(firstRevoke);
        expect(mockTx.vendorAssessment.update).not.toHaveBeenCalled();
        // And no second audit row — a re-revoke is not an event.
        expect(mockLog).not.toHaveBeenCalled();
    });

    // The inverse of resend, and the reason both exist. Rotating here would
    // defeat the purpose: the goal is to kill the link already circulating,
    // not to hand out a replacement.
    it('does NOT rotate the token', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValue(row());
        await revokeAssessmentLink(makeCtx(), 'a1');
        const data = mockTx.vendorAssessment.update.mock.calls[0][0].data;
        expect(data).not.toHaveProperty('externalAccessTokenHash');
        expect(data).not.toHaveProperty('externalAccessTokenExpiresAt');
    });

    // Revocation is deliberately independent of lifecycle state — the docstring
    // records that dragging status out of SENT/IN_PROGRESS was the old
    // workaround, and that it corrupts the lifecycle to achieve a security
    // outcome. So a CLOSED assessment's leaked link is still killable.
    it.each([['SENT'], ['IN_PROGRESS'], ['SUBMITTED'], ['REVIEWED'], ['CLOSED']])(
        'revokes regardless of status (%s)',
        async (status) => {
            mockTx.vendorAssessment.findFirst.mockResolvedValue(row({ status }));
            await expect(revokeAssessmentLink(makeCtx(), 'a1')).resolves.toMatchObject({
                assessmentId: 'a1',
            });
        },
    );
});

// ═══════════════════════════════════════════════════════════════════
// Missing relations — the `?? ''` / `?? 'unknown'` fallbacks
// ═══════════════════════════════════════════════════════════════════
//
// `templateId` is nullable (the G-3 migration made it so) and the
// resend/revoke reads pull `vendor` and `templateVersion` through
// OPTIONAL relations, so both can come back null on a real row. Neither
// fallback is defensive decoration: without them the send throws inside
// the transaction — after the fresh token has already been written —
// leaving the assessment with a hash nobody holds the preimage of. Each
// case below is paired with the populated-relation case so the two arms
// of the coalesce produce visibly different output.

describe('resendAssessmentInvite — email payload when relations are missing', () => {
    it('emits empty vendor/template names rather than throwing when both relations are null', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValue(
            row({ vendor: null, templateVersion: null }),
        );

        const out = await resendAssessmentInvite(makeCtx(), 'a1');

        const payload = mockEnqueueEmail.mock.calls[0][1].payload;
        expect(payload.vendorName).toBe('');
        expect(payload.templateName).toBe('');
        // The resend still completes — the whole point of the fallback.
        expect(out.notificationQueued).toBe(true);
        expect(mockTx.vendorAssessment.update).toHaveBeenCalledTimes(1);
    });

    it('carries the real vendor/template names when the relations ARE present', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValue(row());

        await resendAssessmentInvite(makeCtx(), 'a1');

        const payload = mockEnqueueEmail.mock.calls[0][1].payload;
        expect(payload.vendorName).toBe('Acme');
        expect(payload.templateName).toBe('SIG Lite v3');
    });
});

describe('revokeAssessmentLink — audit detail when the vendor relation is missing', () => {
    it('names the vendor as "unknown" rather than emitting "undefined"', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValue(row({ vendor: null }));

        await revokeAssessmentLink(makeCtx(), 'a1');

        // The audit row is the only durable record of WHICH link was
        // killed; an interpolated `undefined` there is what an incident
        // reviewer would be reading six months later.
        const entry = mockLog.mock.calls[0][2] as { details?: string };
        expect(entry.details).toContain('(vendor=unknown)');
        expect(entry.details).not.toContain('undefined');
    });

    it('names the real vendor when the relation is present', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValue(row());

        await revokeAssessmentLink(makeCtx(), 'a1');

        const entry = mockLog.mock.calls[0][2] as { details?: string };
        expect(entry.details).toContain('(vendor=Acme)');
        expect(entry.details).not.toContain('unknown');
    });
});
