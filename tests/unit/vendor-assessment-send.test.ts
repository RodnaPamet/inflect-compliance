/**
 * Epic G-3 prompt 3 — sendAssessment unit tests.
 *
 * Pure-memory tests of the outbound flow. Pins the four invariants
 * the prompt called out:
 *
 *   1. Token storage is hash-only — the raw token never appears in
 *      the assessment row's persisted columns.
 *   2. Source template stays canonical — sendAssessment writes a
 *      new VendorAssessment row pointing AT the template via
 *      templateVersionId; it never copies questions.
 *   3. Lifecycle starts at SENT (with sentAt + sentByUserId
 *      stamped) — not DRAFT.
 *   4. Notification is queued via the canonical enqueueEmail
 *      pipeline; same-day re-send is collapsed by the dedupeKey.
 */

// ─── Mocks ─────────────────────────────────────────────────────────

const mockTx = {
    vendor: { findFirst: jest.fn() },
    vendorAssessmentTemplate: { findFirst: jest.fn() },
    vendorAssessment: { findFirst: jest.fn(), create: jest.fn() },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: unknown, fn: (db: unknown) => Promise<unknown>) =>
            fn(mockTx),
    ),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => s.trim()),
}));

const mockEnqueueEmail = jest.fn();
jest.mock('@/app-layer/notifications/enqueue', () => ({
    enqueueEmail: (...args: unknown[]) => mockEnqueueEmail(...args),
}));

// `resolveAppOrigin` reads `env.APP_URL` through a lazy `require('@/env')`.
// A GETTER (not a bare `{ env: mockEnv }`) because `@/lib/errors/types`
// imports `env` at module load — i.e. during the hoisted import block, before
// `mockEnv`'s `const` is initialised. The getter defers the read to use time.
const mockEnv: { APP_URL?: string; NODE_ENV: string } = { NODE_ENV: 'test' };
jest.mock('@/env', () => ({
    get env() {
        return mockEnv;
    },
}));

import { sendAssessment } from '@/app-layer/usecases/vendor-assessment-send';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { getPermissionsForRole } from '@/lib/permissions';

// ─── Helpers ───────────────────────────────────────────────────────

function makeCtx(overrides: { canWrite?: boolean } = {}) {
    const canWrite = overrides.canWrite ?? true;
    const base = getPermissionsForRole('ADMIN');
    return {
        requestId: 'req-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        role: 'ADMIN' as const,
        permissions: {
            canRead: true,
            canWrite,
            canAdmin: false,
            canAudit: false,
            canExport: false,
        },
        // Vendor policies read the CUSTOM-ROLE-AWARE set (2026-07-28), so the
        // `canWrite` knob this helper exposes has to move `vendors.edit` in
        // step. It was `{} as never`, which made `appPermissions.vendors`
        // undefined the moment the policies stopped reading the coarse tier.
        appPermissions: {
            ...base,
            vendors: { ...base.vendors, edit: canWrite, create: canWrite },
        },
    };
}

const VALID_INPUT = {
    respondentEmail: 'security@example.com',
    respondentName: 'Security team',
};

beforeEach(() => {
    jest.clearAllMocks();
    Object.values(mockTx.vendor).forEach((fn) =>
        (fn as jest.Mock).mockReset(),
    );
    Object.values(mockTx.vendorAssessmentTemplate).forEach((fn) =>
        (fn as jest.Mock).mockReset(),
    );
    Object.values(mockTx.vendorAssessment).forEach((fn) =>
        (fn as jest.Mock).mockReset(),
    );
    mockEnqueueEmail.mockReset();
    delete mockEnv.APP_URL;
});

// ═══════════════════════════════════════════════════════════════════
// 1. Permission + input validation
// ═══════════════════════════════════════════════════════════════════

describe('sendAssessment — permission + input', () => {
    test('rejects callers without canWrite', async () => {
        await expect(
            sendAssessment(
                makeCtx({ canWrite: false }),
                'v-1',
                't-1',
                VALID_INPUT,
            ),
        ).rejects.toThrow(/permission|ADMIN/);
    });

    test('rejects invalid email', async () => {
        await expect(
            sendAssessment(makeCtx(), 'v-1', 't-1', {
                ...VALID_INPUT,
                respondentEmail: 'not-an-email',
            }),
        ).rejects.toThrow(/email/i);
    });

    test('rejects missing vendor', async () => {
        mockTx.vendor.findFirst.mockResolvedValueOnce(null);
        await expect(
            sendAssessment(makeCtx(), 'v-missing', 't-1', VALID_INPUT),
        ).rejects.toThrow(/Vendor not found/);
    });

    test('rejects missing template', async () => {
        mockTx.vendor.findFirst.mockResolvedValueOnce({
            id: 'v-1',
            name: 'Acme',
        });
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce(null);
        await expect(
            sendAssessment(makeCtx(), 'v-1', 't-missing', VALID_INPUT),
        ).rejects.toThrow(/Template not found/);
    });

    test('rejects unpublished template', async () => {
        mockTx.vendor.findFirst.mockResolvedValueOnce({
            id: 'v-1',
            name: 'Acme',
        });
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce({
            id: 't-1',
            name: 'SOC 2',
            isPublished: false,
        });
        await expect(
            sendAssessment(makeCtx(), 'v-1', 't-1', VALID_INPUT),
        ).rejects.toThrow(/Publish/);
    });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Idempotency / in-flight guard
// ═══════════════════════════════════════════════════════════════════

describe('sendAssessment — in-flight guard', () => {
    test('refuses fresh send when SENT/IN_PROGRESS already exists for same recipient', async () => {
        mockTx.vendor.findFirst.mockResolvedValueOnce({
            id: 'v-1',
            name: 'Acme',
        });
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce({
            id: 't-1',
            name: 'SOC 2',
            isPublished: true,
        });
        mockTx.vendorAssessment.findFirst.mockResolvedValueOnce({
            id: 'a-prev',
        });

        await expect(
            sendAssessment(makeCtx(), 'v-1', 't-1', VALID_INPUT),
        ).rejects.toThrow(/in flight/);

        // No write happens after rejection.
        expect(mockTx.vendorAssessment.create).not.toHaveBeenCalled();
        expect(mockEnqueueEmail).not.toHaveBeenCalled();
    });

    test('force=true bypasses the in-flight guard', async () => {
        mockTx.vendor.findFirst.mockResolvedValueOnce({
            id: 'v-1',
            name: 'Acme',
        });
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce({
            id: 't-1',
            name: 'SOC 2',
            isPublished: true,
        });
        mockTx.vendorAssessment.create.mockResolvedValueOnce({
            id: 'a-new',
        });
        mockEnqueueEmail.mockResolvedValueOnce({
            id: 'outbox-1',
            dedupeKey: 'k',
        });

        await sendAssessment(makeCtx(), 'v-1', 't-1', {
            ...VALID_INPUT,
            force: true,
        });

        // findFirst for the in-flight check is skipped when force=true.
        // (vendor + template findFirst are still called.)
        expect(mockTx.vendorAssessment.findFirst).not.toHaveBeenCalled();
        expect(mockTx.vendorAssessment.create).toHaveBeenCalledTimes(1);
    });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Happy path — instance creation + token + outbox
// ═══════════════════════════════════════════════════════════════════

describe('sendAssessment — happy path', () => {
    function setupSuccess() {
        mockTx.vendor.findFirst.mockResolvedValueOnce({
            id: 'v-1',
            name: 'Acme Cloud',
        });
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce({
            id: 't-v3',
            name: 'SOC 2 questionnaire',
            isPublished: true,
        });
        mockTx.vendorAssessment.findFirst.mockResolvedValueOnce(null);
        mockTx.vendorAssessment.create.mockResolvedValueOnce({
            id: 'a-new',
        });
        mockEnqueueEmail.mockResolvedValueOnce({
            id: 'outbox-1',
            dedupeKey: 'k',
        });
    }

    test('creates assessment in SENT state pinned to templateVersionId', async () => {
        setupSuccess();
        const result = await sendAssessment(
            makeCtx(),
            'v-1',
            't-v3',
            VALID_INPUT,
        );

        expect(result.assessmentId).toBe('a-new');
        expect(result.notificationQueued).toBe(true);

        const data = mockTx.vendorAssessment.create.mock.calls[0][0].data;
        expect(data).toMatchObject({
            tenantId: 'tenant-1',
            vendorId: 'v-1',
            // Legacy templateId left null — G-3 sends only carry
            // templateVersionId.
            templateId: null,
            templateVersionId: 't-v3',
            requestedByUserId: 'user-1',
            sentByUserId: 'user-1',
            status: 'SENT',
            respondentEmail: 'security@example.com',
        });
        expect(data.sentAt).toBeInstanceOf(Date);
        expect(data.startedAt).toBeInstanceOf(Date);
    });

    test('stores SHA-256 hash of token, never the raw value', async () => {
        setupSuccess();
        const result = await sendAssessment(
            makeCtx(),
            'v-1',
            't-v3',
            VALID_INPUT,
        );

        const data = mockTx.vendorAssessment.create.mock.calls[0][0].data as {
            externalAccessTokenHash: string;
            externalAccessTokenExpiresAt: Date;
        };

        // The raw token returned to the caller is base64url and ~43
        // chars long for 32 bytes; the stored hash is 64 hex chars.
        expect(result.externalAccessToken.length).toBeGreaterThan(20);
        expect(data.externalAccessTokenHash).toMatch(/^[a-f0-9]{64}$/);
        expect(data.externalAccessTokenHash).not.toBe(result.externalAccessToken);
        // Recompute to confirm hash(raw) === stored.
        const { createHash } = require('crypto');
        const recomputed = createHash('sha256')
            .update(result.externalAccessToken)
            .digest('hex');
        expect(recomputed).toBe(data.externalAccessTokenHash);

        // Expiry is in the future and matches the returned expiresAt.
        expect(data.externalAccessTokenExpiresAt.getTime()).toBeGreaterThan(
            Date.now(),
        );
        expect(result.expiresAt).toEqual(data.externalAccessTokenExpiresAt);
    });

    test('does not write any question/section content into the instance', async () => {
        setupSuccess();
        await sendAssessment(makeCtx(), 'v-1', 't-v3', VALID_INPUT);

        // The only mutation is `create` on VendorAssessment. The
        // template's sections/questions are not copied; they're
        // referenced through templateVersionId at render time.
        const data = mockTx.vendorAssessment.create.mock.calls[0][0].data;
        expect(data).not.toHaveProperty('sections');
        expect(data).not.toHaveProperty('questions');
        expect(data).not.toHaveProperty('templateSnapshotJson');
    });

    test('queues VENDOR_ASSESSMENT_INVITATION email with the response URL containing the raw token', async () => {
        setupSuccess();
        const result = await sendAssessment(makeCtx(), 'v-1', 't-v3', {
            ...VALID_INPUT,
            appOriginOverride: 'https://app.example.com',
        });

        expect(mockEnqueueEmail).toHaveBeenCalledTimes(1);
        const enqueueArgs = mockEnqueueEmail.mock.calls[0][1];
        expect(enqueueArgs.type).toBe('VENDOR_ASSESSMENT_INVITATION');
        expect(enqueueArgs.toEmail).toBe('security@example.com');
        expect(enqueueArgs.entityId).toBe('a-new');
        expect(enqueueArgs.payload.vendorName).toBe('Acme Cloud');
        expect(enqueueArgs.payload.templateName).toBe(
            'SOC 2 questionnaire',
        );
        // Response URL contains the RAW token — only place it
        // appears in the system.
        expect(enqueueArgs.payload.responseUrl).toContain(
            'https://app.example.com/vendor-assessment/a-new',
        );
        expect(enqueueArgs.payload.responseUrl).toContain(
            `t=${result.externalAccessToken}`,
        );
    });

    test('honours expiresInDays clamping (max 90)', async () => {
        setupSuccess();
        const result = await sendAssessment(makeCtx(), 'v-1', 't-v3', {
            ...VALID_INPUT,
            expiresInDays: 9999,
        });
        const ms = result.expiresAt.getTime() - Date.now();
        // 90 days ± a small tolerance for execution time.
        expect(ms).toBeGreaterThan(89 * 24 * 3600 * 1000);
        expect(ms).toBeLessThanOrEqual(90 * 24 * 3600 * 1000 + 5000);
    });

    test('lowercases respondent email so dedupe collisions match', async () => {
        setupSuccess();
        await sendAssessment(makeCtx(), 'v-1', 't-v3', {
            ...VALID_INPUT,
            respondentEmail: 'Security@Example.COM',
        });
        const data = mockTx.vendorAssessment.create.mock.calls[0][0].data;
        expect(data.respondentEmail).toBe('security@example.com');
    });

    test('returns notificationQueued=false when enqueueEmail returns null', async () => {
        // enqueueEmail returns null when notifications are disabled
        // for the tenant or the same-day dedupeKey already exists.
        // The send still creates the assessment row.
        mockTx.vendor.findFirst.mockResolvedValueOnce({
            id: 'v-1',
            name: 'Acme',
        });
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce({
            id: 't-1',
            name: 'SOC 2',
            isPublished: true,
        });
        mockTx.vendorAssessment.findFirst.mockResolvedValueOnce(null);
        mockTx.vendorAssessment.create.mockResolvedValueOnce({
            id: 'a-new',
        });
        mockEnqueueEmail.mockResolvedValueOnce(null);

        const result = await sendAssessment(makeCtx(), 'v-1', 't-1', VALID_INPUT);

        expect(result.notificationQueued).toBe(false);
        // Assessment WAS created — the outbox skip doesn't roll
        // back the row.
        expect(mockTx.vendorAssessment.create).toHaveBeenCalledTimes(1);
    });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Response-URL origin resolution
// ═══════════════════════════════════════════════════════════════════
//
// The response URL is the ONLY artefact carrying the raw token. Getting
// the origin wrong does not fail loudly — it mails the external
// respondent a link that 404s (or, worse, points at the wrong
// deployment), while the assessment row, the audit entry and the
// returned token all look perfectly healthy. So each of the three
// origin sources is pinned to a DISTINCT host, and the assertion is on
// the whole URL rather than on a substring: `toContain('example')`
// would be satisfied by any of them.

describe('sendAssessment — response URL origin', () => {
    function setupSuccess() {
        mockTx.vendor.findFirst.mockResolvedValueOnce({
            id: 'v-1',
            name: 'Acme Cloud',
        });
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce({
            id: 't-v3',
            name: 'SOC 2 questionnaire',
            isPublished: true,
        });
        mockTx.vendorAssessment.findFirst.mockResolvedValueOnce(null);
        mockTx.vendorAssessment.create.mockResolvedValueOnce({ id: 'a-new' });
        mockEnqueueEmail.mockResolvedValueOnce({ id: 'outbox-1' });
    }

    function queuedUrl(): string {
        return mockEnqueueEmail.mock.calls[0][1].payload.responseUrl;
    }

    test('uses env.APP_URL when no override is supplied, stripping the trailing slash', async () => {
        mockEnv.APP_URL = 'https://prod.inflect.example/';
        setupSuccess();

        const result = await sendAssessment(makeCtx(), 'v-1', 't-v3', VALID_INPUT);

        // Exact — a `//` from an unstripped trailing slash and a silent
        // fall-through to localhost both fail here.
        expect(queuedUrl()).toBe(
            `https://prod.inflect.example/vendor-assessment/a-new?t=${result.externalAccessToken}`,
        );
    });

    test('falls back to localhost:3000 when APP_URL is unset', async () => {
        // mockEnv.APP_URL deliberately left undefined by beforeEach.
        setupSuccess();

        const result = await sendAssessment(makeCtx(), 'v-1', 't-v3', VALID_INPUT);

        expect(queuedUrl()).toBe(
            `http://localhost:3000/vendor-assessment/a-new?t=${result.externalAccessToken}`,
        );
    });

    test('an explicit appOriginOverride beats a configured APP_URL', async () => {
        // The two sources are different HOSTS on purpose: if the override
        // and the env value were the same string, no assertion could tell
        // which one the code actually read.
        mockEnv.APP_URL = 'https://prod.inflect.example';
        setupSuccess();

        const result = await sendAssessment(makeCtx(), 'v-1', 't-v3', {
            ...VALID_INPUT,
            appOriginOverride: 'https://preview.inflect.example/',
        });

        expect(queuedUrl()).toBe(
            `https://preview.inflect.example/vendor-assessment/a-new?t=${result.externalAccessToken}`,
        );
        expect(queuedUrl()).not.toContain('prod.inflect.example');
    });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Recipient name — default vs sanitised
// ═══════════════════════════════════════════════════════════════════

describe('sendAssessment — recipientName', () => {
    function setupSuccess() {
        mockTx.vendor.findFirst.mockResolvedValueOnce({
            id: 'v-1',
            name: 'Acme Cloud',
        });
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce({
            id: 't-v3',
            name: 'SOC 2 questionnaire',
            isPublished: true,
        });
        mockTx.vendorAssessment.findFirst.mockResolvedValueOnce(null);
        mockTx.vendorAssessment.create.mockResolvedValueOnce({ id: 'a-new' });
        mockEnqueueEmail.mockResolvedValueOnce({ id: 'outbox-1' });
    }

    test('greets "Vendor team" when no respondentName is supplied', async () => {
        setupSuccess();
        await sendAssessment(makeCtx(), 'v-1', 't-v3', {
            respondentEmail: 'security@example.com',
        });

        expect(mockEnqueueEmail.mock.calls[0][1].payload.recipientName).toBe(
            'Vendor team',
        );
    });

    test('routes a supplied respondentName through sanitizePlainText, not raw', async () => {
        // The mock is stubbed to a value the raw input can never equal, so
        // the assertion separates "sanitised" from "passed straight
        // through" — a fixture where both sides read the same string could
        // not. The name reaches an emailed HTML body; the sanitiser is the
        // only thing standing between the two.
        (sanitizePlainText as jest.Mock).mockReturnValueOnce('Bob');
        setupSuccess();

        await sendAssessment(makeCtx(), 'v-1', 't-v3', {
            respondentEmail: 'security@example.com',
            respondentName: '<script>alert(1)</script>Bob',
        });

        const recipientName =
            mockEnqueueEmail.mock.calls[0][1].payload.recipientName;
        expect(recipientName).toBe('Bob');
        expect(recipientName).not.toContain('<script>');
        // And it is not the "no name given" default either.
        expect(recipientName).not.toBe('Vendor team');
    });
});

// ═══════════════════════════════════════════════════════════════════
// 6. In-flight lookup is tenant- and recipient-scoped
// ═══════════════════════════════════════════════════════════════════

describe('sendAssessment — in-flight query shape', () => {
    test('scopes the idempotency probe to tenant + vendor + template + LOWERCASED recipient', async () => {
        mockTx.vendor.findFirst.mockResolvedValueOnce({
            id: 'v-1',
            name: 'Acme Cloud',
        });
        mockTx.vendorAssessmentTemplate.findFirst.mockResolvedValueOnce({
            id: 't-v3',
            name: 'SOC 2 questionnaire',
            isPublished: true,
        });
        mockTx.vendorAssessment.findFirst.mockResolvedValueOnce(null);
        mockTx.vendorAssessment.create.mockResolvedValueOnce({ id: 'a-new' });
        mockEnqueueEmail.mockResolvedValueOnce({ id: 'outbox-1' });

        // Mixed case on the way in, so the stored/queried form is provably
        // the normalised one and not simply the argument echoed back.
        await sendAssessment(makeCtx(), 'v-1', 't-v3', {
            respondentEmail: 'Security@Example.COM',
        });

        expect(mockTx.vendorAssessment.findFirst).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                vendorId: 'v-1',
                templateVersionId: 't-v3',
                respondentEmail: 'security@example.com',
                status: { in: ['SENT', 'IN_PROGRESS'] },
            },
            select: { id: true },
        });
    });
});
