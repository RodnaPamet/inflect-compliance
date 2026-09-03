/**
 * `vendor-assessment-review.ts` — the refusal, fallback and post-commit
 * branches the three existing unit files never reach.
 *
 * The existing files cover the happy lifecycle (`vendor-assessment-review`),
 * the two read surfaces (`vendor-assessment-list-usecases`,
 * `vendor-assessment-review-view`) and the risk/link failure-domain split
 * (`vendor-assessment-risk-writeback`). None of them mocks `@/lib/prisma`
 * fully enough to enter `notifyAssessmentReviewed`, and none supplies the
 * SECOND `vendorAssessment.findFirst` that `attachReviewedAssessmentEvidence`
 * needs — so the whole evidence-attach body and the whole notification body
 * were unexecuted, along with every three-state `reviewerNotes` arm and the
 * `nextReviewAt` roll-forward decision.
 *
 * Two fixture choices are deliberate:
 *
 *  • `sanitizePlainText` is mocked to PREFIX its input rather than to
 *    `.trim()` it (as the sibling file does). A trim is the identity function
 *    on the strings those tests pass, so "sanitised" and "raw" are the same
 *    runtime string and no assertion can separate them. The prefix makes the
 *    sanitise call observable.
 *  • `APP_URL` carries a trailing slash, so the `.replace(/\/$/, '')` strip is
 *    the difference between the asserted URL and a double-slashed one.
 */

// ─── Mocks (declared before imports) ───────────────────────────────

const mockTx = {
    vendorAssessment: { findFirst: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    vendorAssessmentAnswer: { updateMany: jest.fn(), findMany: jest.fn() },
    vendorAssessmentTemplateQuestion: { findMany: jest.fn() },
    vendorAssessmentTemplate: { findUnique: jest.fn() },
    vendor: { findUnique: jest.fn() },
    evidence: { create: jest.fn() },
    vendorEvidenceBundle: { findFirst: jest.fn(), create: jest.fn() },
    vendorEvidenceBundleItem: { create: jest.fn() },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: unknown, fn: (db: unknown) => Promise<unknown>) => fn(mockTx),
    ),
}));

const mockLogEvent = jest.fn<Promise<void>, unknown[]>();
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: (...args: unknown[]) => mockLogEvent(...args),
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: (s: string) => `CLEAN:${s}`,
}));

const mockPrisma = {
    vendor: {
        findFirst: jest.fn<Promise<unknown>, unknown[]>(),
        updateMany: jest.fn<Promise<unknown>, unknown[]>(),
    },
    vendorAssessment: { findUnique: jest.fn<Promise<unknown>, unknown[]>() },
    user: { findUnique: jest.fn<Promise<unknown>, unknown[]>() },
    $transaction: jest.fn(
        async (fn: (tx: unknown) => Promise<unknown>) => fn({ emailTx: true }),
    ),
};
jest.mock('@/lib/prisma', () => ({ prisma: mockPrisma }));

const mockEnv: { APP_URL: string | undefined } = {
    APP_URL: 'https://app.example.com/',
};
jest.mock('@/env', () => ({ env: mockEnv }));

const mockEnqueueEmail = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('@/app-layer/notifications/enqueue', () => ({
    enqueueEmail: (...a: unknown[]) => mockEnqueueEmail(...a),
}));

const mockCreateRisk = jest.fn<Promise<{ id: string }>, unknown[]>();
jest.mock('@/app-layer/usecases/risk', () => ({
    createRisk: (...a: unknown[]) => mockCreateRisk(...a),
}));

const mockAddVendorLink = jest.fn<Promise<unknown>, unknown[]>();
const mockListVendorLinks = jest.fn<Promise<unknown[]>, unknown[]>();
jest.mock('@/app-layer/usecases/vendor', () => ({
    addVendorLink: (...a: unknown[]) => mockAddVendorLink(...a),
    listVendorLinks: (...a: unknown[]) => mockListVendorLinks(...a),
}));

const mockLoggerWarn = jest.fn<void, unknown[]>();
const mockLoggerError = jest.fn<void, unknown[]>();
const mockLoggerInfo = jest.fn<void, unknown[]>();
jest.mock('@/lib/observability/logger', () => ({
    logger: {
        warn: (...a: unknown[]) => mockLoggerWarn(...a),
        error: (...a: unknown[]) => mockLoggerError(...a),
        info: (...a: unknown[]) => mockLoggerInfo(...a),
        debug: jest.fn(),
    },
}));

import {
    reviewAssessment,
    closeAssessment,
    getReviewView,
    listVendorAssessments,
} from '@/app-layer/usecases/vendor-assessment-review';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';

// ─── Helpers ───────────────────────────────────────────────────────

function makeCtx(over: { canAdmin?: boolean; canRead?: boolean } = {}): RequestContext {
    return {
        requestId: 'req-1',
        userId: 'user-reviewer',
        tenantId: 'tenant-1',
        role: 'ADMIN',
        permissions: {
            canRead: over.canRead ?? true,
            canWrite: true,
            canAdmin: over.canAdmin ?? true,
            canAudit: false,
            canExport: false,
        },
        appPermissions: {} as never,
    } as unknown as RequestContext;
}

interface SeedOpts {
    vendorName?: string | null;
    questions?: Array<{ id: string; weight?: number }>;
    answers?: Array<{ questionId: string; computedPoints: number }>;
    scoringConfigJson?: unknown;
    /** null ⇒ the template row is missing entirely (optional-chain arm). */
    templateRow?: 'missing' | 'present';
    /** Second findFirst — the evidence-attach context. */
    evidence?: { vendorId: string; templateVersion: { name: string; key: string; version: number } | null } | null;
    bundle?: { id: string } | null;
}

function seedReview(opts: SeedOpts = {}) {
    mockTx.vendorAssessment.findFirst.mockResolvedValueOnce({
        id: 'a-1',
        tenantId: 'tenant-1',
        status: 'SUBMITTED',
        templateVersionId: 'tv-1',
        templateId: null,
        vendorId: 'vendor-1',
        vendor: opts.vendorName === undefined
            ? { name: 'Acme Corp' }
            : opts.vendorName === null
                ? null
                : { name: opts.vendorName },
    });
    // Second findFirst — attachReviewedAssessmentEvidence. Defaults to a row
    // with no templateVersion, i.e. the documented early return.
    mockTx.vendorAssessment.findFirst.mockResolvedValueOnce(
        opts.evidence === undefined ? { vendorId: 'vendor-1', templateVersion: null } : opts.evidence,
    );
    mockTx.vendorAssessmentAnswer.updateMany.mockResolvedValue({ count: 1 });
    mockTx.vendorAssessmentTemplateQuestion.findMany.mockResolvedValue(
        (opts.questions ?? [{ id: 'q1' }]).map((q) => ({
            id: q.id,
            weight: q.weight ?? 1,
            required: false,
        })),
    );
    mockTx.vendorAssessmentAnswer.findMany.mockResolvedValue(
        (opts.answers ?? [{ questionId: 'q1', computedPoints: 4 }]).map((a) => ({
            questionId: a.questionId,
            computedPoints: a.computedPoints,
            reviewerOverridePoints: null,
        })),
    );
    mockTx.vendorAssessmentTemplate.findUnique.mockResolvedValue(
        opts.templateRow === 'missing'
            ? null
            : { scoringConfigJson: opts.scoringConfigJson ?? null },
    );
    mockTx.vendorAssessment.update.mockResolvedValue({});
    mockTx.evidence.create.mockResolvedValue({ id: 'ev-new' });
    mockTx.vendorEvidenceBundle.findFirst.mockResolvedValue(opts.bundle ?? null);
    mockTx.vendorEvidenceBundle.create.mockResolvedValue({ id: 'bundle-new' });
    mockTx.vendorEvidenceBundleItem.create.mockResolvedValue({});
}

const reviewUpdateData = () =>
    mockTx.vendorAssessment.update.mock.calls[0][0].data as Record<string, unknown>;

beforeEach(() => {
    jest.clearAllMocks();
    // `clearAllMocks` leaves queued `mockResolvedValueOnce` implementations in
    // place, and this file leans on a two-deep `findFirst` queue — an
    // unconsumed leftover would silently answer the NEXT test's first read.
    for (const group of Object.values(mockTx)) {
        for (const fn of Object.values(group as unknown as Record<string, jest.Mock>)) {
            fn.mockReset();
        }
    }
    mockPrisma.vendor.findFirst.mockReset();
    mockPrisma.vendor.updateMany.mockReset();
    mockPrisma.vendorAssessment.findUnique.mockReset();
    mockPrisma.user.findUnique.mockReset();
    mockLogEvent.mockResolvedValue(undefined);
    mockEnqueueEmail.mockResolvedValue({ id: 'mail-1', dedupeKey: 'k' });
    // Notification off by default — the assessment row it re-reads post-commit
    // is absent, so notifyAssessmentReviewed returns before enqueuing.
    mockPrisma.vendorAssessment.findUnique.mockResolvedValue(null);
    mockPrisma.vendor.findFirst.mockResolvedValue({ nextReviewAt: null });
    mockPrisma.vendor.updateMany.mockResolvedValue({ count: 1 });
    mockListVendorLinks.mockResolvedValue([]);
    mockCreateRisk.mockResolvedValue({ id: 'risk-1' });
    mockAddVendorLink.mockResolvedValue(undefined);
    mockEnv.APP_URL = 'https://app.example.com/';
});

// ═══════════════════════════════════════════════════════════════════
// 1. Guards — the typed error, not just the message
// ═══════════════════════════════════════════════════════════════════

describe('reviewAssessment — refusals carry the right error type', () => {
    it('refuses a non-admin with ForbiddenError, before opening a transaction', async () => {
        await expect(reviewAssessment(makeCtx({ canAdmin: false }), 'a-1', {}))
            .rejects.toBeInstanceOf(ForbiddenError);
        expect(mockTx.vendorAssessment.findFirst).not.toHaveBeenCalled();
    });

    it('refuses a wrong-status assessment with ValidationError (400), naming the status', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValueOnce({
            id: 'a-1', tenantId: 'tenant-1', status: 'REVIEWED',
            templateVersionId: 'tv-1', templateId: null, vendorId: 'v-1', vendor: { name: 'X' },
        });
        const err = await reviewAssessment(makeCtx(), 'a-1', {}).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).message).toContain('status REVIEWED');
        // A refusal must not have transitioned anything.
        expect(mockTx.vendorAssessment.update).not.toHaveBeenCalled();
    });

    it('refuses a missing assessment with NotFoundError (404), not a 400', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValueOnce(null);
        const err = await reviewAssessment(makeCtx(), 'gone', {}).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(NotFoundError);
        expect(err).not.toBeInstanceOf(ValidationError);
    });
});

// ═══════════════════════════════════════════════════════════════════
// 2. reviewerNotes — the three states are three DIFFERENT writes
// ═══════════════════════════════════════════════════════════════════

describe('reviewAssessment — assessment-level reviewerNotes is three-state', () => {
    it('sanitises a supplied note rather than storing it verbatim', async () => {
        seedReview();
        await reviewAssessment(makeCtx(), 'a-1', { reviewerNotes: '<b>ok</b>' });
        expect(reviewUpdateData().reviewerNotes).toBe('CLEAN:<b>ok</b>');
    });

    it('writes an explicit null when the note is cleared', async () => {
        seedReview();
        await reviewAssessment(makeCtx(), 'a-1', { reviewerNotes: null });
        const data = reviewUpdateData();
        expect(data.reviewerNotes).toBeNull();
    });

    it('leaves the stored note untouched (undefined) when none is supplied', async () => {
        seedReview();
        await reviewAssessment(makeCtx(), 'a-1', {});
        const data = reviewUpdateData();
        // Present-as-undefined is Prisma's "do not write this column"; a null
        // here would erase a previously-recorded note.
        expect(data.reviewerNotes).toBeUndefined();
        expect(data.reviewerNotes).not.toBeNull();
    });

    it('treats an empty string as "leave untouched", not as a clear', async () => {
        seedReview();
        await reviewAssessment(makeCtx(), 'a-1', { reviewerNotes: '' });
        const data = reviewUpdateData();
        expect(data.reviewerNotes).toBeUndefined();
    });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Per-answer override notes
// ═══════════════════════════════════════════════════════════════════

describe('reviewAssessment — per-answer reviewerNotes', () => {
    it('sanitises a per-answer note', async () => {
        seedReview();
        await reviewAssessment(makeCtx(), 'a-1', {
            overrides: [{ questionId: 'q1', reviewerNotes: '<i>x</i>' }],
        });
        const data = mockTx.vendorAssessmentAnswer.updateMany.mock.calls[0][0].data;
        expect(data).toStrictEqual({ reviewerNotes: 'CLEAN:<i>x</i>' });
    });

    it('clears a per-answer note on null WITHOUT touching the override points', async () => {
        seedReview();
        await reviewAssessment(makeCtx(), 'a-1', {
            overrides: [{ questionId: 'q1', reviewerNotes: null }],
        });
        const data = mockTx.vendorAssessmentAnswer.updateMany.mock.calls[0][0].data;
        // toStrictEqual, not toEqual: an accidental
        // `reviewerOverridePoints: undefined` would pass toEqual and would
        // still be a different Prisma write.
        expect(data).toStrictEqual({ reviewerNotes: null });
    });

    it('stores an empty per-answer note as null rather than as "CLEAN:"', async () => {
        seedReview();
        await reviewAssessment(makeCtx(), 'a-1', {
            overrides: [{ questionId: 'q1', reviewerNotes: '' }],
        });
        const data = mockTx.vendorAssessmentAnswer.updateMany.mock.calls[0][0].data;
        expect(data).toStrictEqual({ reviewerNotes: null });
    });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Audit detail line — formatScore + rating/verdict fallbacks
// ═══════════════════════════════════════════════════════════════════

describe('reviewAssessment — audit detail line', () => {
    it('renders a fractional score to three decimals', async () => {
        seedReview({
            questions: [{ id: 'q1' }, { id: 'q2' }],
            answers: [
                { questionId: 'q1', computedPoints: 2 },
                { questionId: 'q2', computedPoints: 3 },
            ],
            scoringConfigJson: { mode: 'WEIGHTED_AVERAGE' },
        });
        await reviewAssessment(makeCtx(), 'a-1', {});
        const details = mockLogEvent.mock.calls[0][2] as { details: string };
        // 5 / 2 = 2.5
        expect(details.details).toContain('score=2.500,');
    });

    it('renders a whole score with no decimal point at all', async () => {
        seedReview({
            questions: [{ id: 'q1' }, { id: 'q2' }],
            answers: [
                { questionId: 'q1', computedPoints: 2 },
                { questionId: 'q2', computedPoints: 2 },
            ],
            scoringConfigJson: { mode: 'WEIGHTED_AVERAGE' },
        });
        await reviewAssessment(makeCtx(), 'a-1', {});
        const details = mockLogEvent.mock.calls[0][2] as { details: string };
        expect(details.details).toContain('score=2,');
        expect(details.details).not.toContain('score=2.000');
    });

    it('says rating=none when the review lands no rating', async () => {
        seedReview();
        await reviewAssessment(makeCtx(), 'a-1', { finalRiskRating: null });
        const details = mockLogEvent.mock.calls[0][2] as { details: string };
        expect(details.details).toContain('rating=none,');
    });

    it('appends the verdict when the engine produced one', async () => {
        seedReview({
            answers: [{ questionId: 'q1', computedPoints: 9 }],
            scoringConfigJson: { mode: 'PASS_FAIL_THRESHOLD', threshold: 5 },
        });
        await reviewAssessment(makeCtx(), 'a-1', {});
        const details = mockLogEvent.mock.calls[0][2] as { details: string };
        expect(details.details).toContain(', verdict=PASS');
    });

    it('appends no verdict clause at all under a verdict-less mode', async () => {
        // Same answers, same score — only the mode differs, so the presence of
        // the clause is attributable to the verdict and to nothing else.
        seedReview({ answers: [{ questionId: 'q1', computedPoints: 9 }] });
        await reviewAssessment(makeCtx(), 'a-1', {});
        const details = mockLogEvent.mock.calls[0][2] as { details: string };
        expect(details.details).not.toContain('verdict=');
    });

    it('falls back to SIMPLE_SUM when the template row itself is missing', async () => {
        seedReview({
            templateRow: 'missing',
            answers: [{ questionId: 'q1', computedPoints: 9 }],
        });
        const r = await reviewAssessment(makeCtx(), 'a-1', {});
        // A missing template cannot yield a verdict — the config is null, so
        // the engine never enters PASS_FAIL_THRESHOLD.
        expect(r.scoring.mode).toBe('SIMPLE_SUM');
        expect(r.scoring.verdict).toBeUndefined();
        expect(r.score).toBe(9);
    });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Evidence attachment — the whole body
// ═══════════════════════════════════════════════════════════════════

const EV_CTX = {
    vendorId: 'vendor-1',
    templateVersion: { name: 'SOC 2 Lite', key: 'soc2-lite', version: 3 },
};

describe('attachReviewedAssessmentEvidence (via reviewAssessment)', () => {
    it('does nothing at all when the assessment has no template version', async () => {
        seedReview({ evidence: { vendorId: 'vendor-1', templateVersion: null } });
        await reviewAssessment(makeCtx(), 'a-1', {});
        expect(mockTx.evidence.create).not.toHaveBeenCalled();
        expect(mockTx.vendorEvidenceBundleItem.create).not.toHaveBeenCalled();
        // Only the REVIEWED audit row — no evidence-attached row.
        expect(mockLogEvent).toHaveBeenCalledTimes(1);
    });

    it('writes an APPROVED Evidence row naming the template and the final score', async () => {
        seedReview({
            evidence: EV_CTX,
            answers: [{ questionId: 'q1', computedPoints: 12 }],
        });
        await reviewAssessment(makeCtx(), 'a-1', { finalRiskRating: 'HIGH' });
        const data = mockTx.evidence.create.mock.calls[0][0].data;
        expect(data).toMatchObject({
            tenantId: 'tenant-1',
            type: 'TEXT',
            title: 'Vendor assessment: SOC 2 Lite',
            category: 'vendor-assessment',
            status: 'APPROVED',
            ownerUserId: 'user-reviewer',
        });
        expect(data.content).toContain('Template: SOC 2 Lite (soc2-lite v3)');
        expect(data.content).toContain('Final score: 12');
        expect(data.content).toContain('Risk rating: HIGH');
    });

    it('renders an em dash — not "null" — when the review landed no rating', async () => {
        seedReview({ evidence: EV_CTX });
        await reviewAssessment(makeCtx(), 'a-1', { finalRiskRating: null });
        const content = mockTx.evidence.create.mock.calls[0][0].data.content as string;
        expect(content).toContain('Risk rating: —');
        expect(content).not.toContain('Risk rating: null');
    });

    it('reuses an existing "Vendor Assessments" bundle instead of creating a second one', async () => {
        seedReview({ evidence: EV_CTX, bundle: { id: 'bundle-existing' } });
        await reviewAssessment(makeCtx(), 'a-1', {});
        expect(mockTx.vendorEvidenceBundle.create).not.toHaveBeenCalled();
        expect(mockTx.vendorEvidenceBundleItem.create.mock.calls[0][0].data.bundleId)
            .toBe('bundle-existing');
    });

    it('creates the vendor bundle when none exists, and files the item into THAT one', async () => {
        seedReview({ evidence: EV_CTX, bundle: null });
        await reviewAssessment(makeCtx(), 'a-1', {});
        expect(mockTx.vendorEvidenceBundle.create.mock.calls[0][0].data).toMatchObject({
            tenantId: 'tenant-1',
            vendorId: 'vendor-1',
            name: 'Vendor Assessments',
            createdByUserId: 'user-reviewer',
        });
        expect(mockTx.vendorEvidenceBundleItem.create.mock.calls[0][0].data.bundleId)
            .toBe('bundle-new');
    });

    it('links the bundle item to the Evidence row it just created', async () => {
        seedReview({ evidence: EV_CTX, answers: [{ questionId: 'q1', computedPoints: 6 }] });
        await reviewAssessment(makeCtx(), 'a-1', { finalRiskRating: 'MEDIUM' });
        const data = mockTx.vendorEvidenceBundleItem.create.mock.calls[0][0].data;
        expect(data).toMatchObject({
            tenantId: 'tenant-1',
            entityType: 'Evidence',
            entityId: 'ev-new',
        });
        expect(data.snapshotJson).toMatchObject({
            assessmentId: 'a-1',
            templateName: 'SOC 2 Lite',
            finalScore: 6,
            finalRating: 'MEDIUM',
        });
    });

    it('audits the attachment against the VENDOR, not the assessment', async () => {
        seedReview({ evidence: EV_CTX, answers: [{ questionId: 'q1', computedPoints: 6 }] });
        await reviewAssessment(makeCtx(), 'a-1', { finalRiskRating: 'MEDIUM' });
        expect(mockLogEvent).toHaveBeenCalledTimes(2);
        const ev = mockLogEvent.mock.calls[1][2] as {
            action: string; entityType: string; entityId: string;
            detailsJson: { after: Record<string, unknown> };
        };
        expect(ev.action).toBe('VENDOR_ASSESSMENT_EVIDENCE_ATTACHED');
        expect(ev.entityType).toBe('Vendor');
        expect(ev.entityId).toBe('vendor-1');
        expect(ev.detailsJson.after).toMatchObject({
            vendorId: 'vendor-1',
            bundleId: 'bundle-new',
            evidenceId: 'ev-new',
            assessmentId: 'a-1',
            finalScore: 6,
            finalRating: 'MEDIUM',
        });
    });
});

// ═══════════════════════════════════════════════════════════════════
// 6. notifyAssessmentReviewed
// ═══════════════════════════════════════════════════════════════════

function seedNotify(over: {
    ownerUserId?: string | null;
    recipient?: { email: string | null; name: string | null } | null;
    vendor?: unknown;
    templateVersion?: unknown;
    tenant?: unknown;
} = {}) {
    mockPrisma.vendorAssessment.findUnique.mockResolvedValue({
        tenantId: 'tenant-1',
        vendor: 'vendor' in over
            ? over.vendor
            : { name: 'Acme Corp', ownerUserId: over.ownerUserId === undefined ? 'owner-9' : over.ownerUserId },
        templateVersion: 'templateVersion' in over ? over.templateVersion : { name: 'SOC 2 Lite' },
        tenant: 'tenant' in over ? over.tenant : { slug: 'acme' },
        requestedByUserId: 'requester-3',
        vendorId: 'vendor-1',
    });
    mockPrisma.user.findUnique.mockResolvedValue(
        over.recipient === undefined
            ? { email: 'owner@example.com', name: 'Olive Owner' }
            : over.recipient,
    );
}

describe('notifyAssessmentReviewed (via reviewAssessment)', () => {
    it('enqueues the REVIEWED email with a slash-normalised deep link', async () => {
        seedReview({ answers: [{ questionId: 'q1', computedPoints: 12 }] });
        seedNotify();
        await reviewAssessment(makeCtx(), 'a-1', { finalRiskRating: 'HIGH' });

        expect(mockEnqueueEmail).toHaveBeenCalledTimes(1);
        const [tx, input] = mockEnqueueEmail.mock.calls[0] as [
            unknown,
            { tenantId: string; type: string; toEmail: string; entityId: string;
              payload: Record<string, unknown> },
        ];
        // The email goes out on the dedicated post-commit transaction, not on
        // the review's own tenant-bound client.
        expect(tx).toEqual({ emailTx: true });
        expect(input).toMatchObject({
            tenantId: 'tenant-1',
            type: 'VENDOR_ASSESSMENT_REVIEWED',
            toEmail: 'owner@example.com',
            entityId: 'a-1',
        });
        expect(input.payload).toMatchObject({
            recipientName: 'Olive Owner',
            vendorName: 'Acme Corp',
            templateName: 'SOC 2 Lite',
            finalScore: 12,
            finalRating: 'HIGH',
            // APP_URL carries a trailing slash; without the strip this reads
            // "https://app.example.com//t/acme/...".
            reviewUrl: 'https://app.example.com/t/acme/admin/vendor-assessment-reviews/a-1',
        });
    });

    it('builds a root-relative link when APP_URL is unset', async () => {
        mockEnv.APP_URL = undefined;
        seedReview();
        seedNotify();
        await reviewAssessment(makeCtx(), 'a-1', {});
        const input = mockEnqueueEmail.mock.calls[0][1] as { payload: { reviewUrl: string } };
        expect(input.payload.reviewUrl)
            .toBe('/t/acme/admin/vendor-assessment-reviews/a-1');
    });

    it('addresses the vendor owner when one is set', async () => {
        seedReview();
        seedNotify({ ownerUserId: 'owner-9' });
        await reviewAssessment(makeCtx(), 'a-1', {});
        expect(mockPrisma.user.findUnique.mock.calls[0][0]).toMatchObject({
            where: { id: 'owner-9' },
        });
    });

    it('falls back to the requester when the vendor has no owner', async () => {
        seedReview();
        seedNotify({ ownerUserId: null });
        await reviewAssessment(makeCtx(), 'a-1', {});
        expect(mockPrisma.user.findUnique.mock.calls[0][0]).toMatchObject({
            where: { id: 'requester-3' },
        });
    });

    it('greets an unnamed recipient as "there" rather than as null', async () => {
        seedReview();
        seedNotify({ recipient: { email: 'nobody@example.com', name: null } });
        await reviewAssessment(makeCtx(), 'a-1', {});
        const input = mockEnqueueEmail.mock.calls[0][1] as { payload: { recipientName: string } };
        expect(input.payload.recipientName).toBe('there');
    });

    it('sends nothing when the recipient has no email address', async () => {
        seedReview();
        seedNotify({ recipient: { email: null, name: 'No Mail' } });
        const r = await reviewAssessment(makeCtx(), 'a-1', {});
        expect(mockEnqueueEmail).not.toHaveBeenCalled();
        // The review still completed — the notification is best-effort.
        expect(r.status).toBe('REVIEWED');
    });

    it('sends nothing when the assessment has no template version to name', async () => {
        seedReview();
        seedNotify({ templateVersion: null });
        await reviewAssessment(makeCtx(), 'a-1', {});
        expect(mockEnqueueEmail).not.toHaveBeenCalled();
        // It bailed before even resolving a recipient.
        expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('sends nothing when the tenant relation did not load', async () => {
        seedReview();
        seedNotify({ tenant: null });
        await reviewAssessment(makeCtx(), 'a-1', {});
        expect(mockEnqueueEmail).not.toHaveBeenCalled();
    });

    it('returns CLEANLY when the recipient user row is gone entirely', async () => {
        seedReview();
        seedNotify({ recipient: null });
        await reviewAssessment(makeCtx(), 'a-1', {});
        expect(mockEnqueueEmail).not.toHaveBeenCalled();
        // "Not sent" is not enough: dereferencing a null recipient would also
        // send nothing, by throwing into the catch. The guard is the
        // difference between a quiet no-op and a swallowed TypeError.
        expect(mockLoggerWarn.mock.calls.map((c) => String(c[0])))
            .not.toContain('vendor-assessment-review: reviewed-notify failed');
    });

    it('normalises a non-Error notification rejection before logging it', async () => {
        seedReview();
        mockPrisma.vendorAssessment.findUnique.mockRejectedValue('notify exploded');
        await reviewAssessment(makeCtx(), 'a-1', {});
        const call = mockLoggerWarn.mock.calls.find(
            (c) => String(c[0]).includes('reviewed-notify failed'),
        );
        expect(call).toBeDefined();
        const { err } = call![1] as { err: Error };
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe('notify exploded');
    });

    it('swallows a notification failure, logs it at warn, and still reviews', async () => {
        seedReview();
        seedNotify();
        mockEnqueueEmail.mockRejectedValue(new Error('smtp queue down'));
        const r = await reviewAssessment(makeCtx(), 'a-1', {});
        expect(r.status).toBe('REVIEWED');
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            'vendor-assessment-review: reviewed-notify failed',
            expect.objectContaining({ assessmentId: 'a-1' }),
        );
        expect(mockLoggerError).not.toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════════════════════════════════
// 7. Vendor writeback — the nextReviewAt roll decision
// ═══════════════════════════════════════════════════════════════════

const DAY = 86_400_000;
const vendorUpdateData = () =>
    mockPrisma.vendor.updateMany.mock.calls[0][0] as { data: Record<string, unknown> };

describe('applyAssessmentRiskWriteback — nextReviewAt', () => {
    it('rolls the next review forward a year when nothing is scheduled', async () => {
        seedReview();
        mockPrisma.vendor.findFirst.mockResolvedValue({ nextReviewAt: null });
        await reviewAssessment(makeCtx(), 'a-1', { finalRiskRating: 'MEDIUM' });
        const { data } = vendorUpdateData();
        expect(data.inherentRisk).toBe('MEDIUM');
        expect((data.nextReviewAt as Date).getTime())
            .toBeGreaterThan(Date.now() + 364 * DAY);
    });

    it('rolls forward when the scheduled review is already in the past', async () => {
        seedReview();
        mockPrisma.vendor.findFirst.mockResolvedValue({
            nextReviewAt: new Date(Date.now() - 10 * DAY),
        });
        await reviewAssessment(makeCtx(), 'a-1', { finalRiskRating: 'MEDIUM' });
        const { data } = vendorUpdateData();
        expect((data.nextReviewAt as Date).getTime())
            .toBeGreaterThan(Date.now() + 364 * DAY);
    });

    it('PRESERVES a manually-set future review date by omitting the column', async () => {
        seedReview();
        const manual = new Date(Date.now() + 30 * DAY);
        mockPrisma.vendor.findFirst.mockResolvedValue({ nextReviewAt: manual });
        await reviewAssessment(makeCtx(), 'a-1', { finalRiskRating: 'MEDIUM' });
        const { data } = vendorUpdateData();
        // Absent, not "set to the same value": writing anything here would
        // overwrite the operator's date on the next review.
        expect(Object.keys(data)).not.toContain('nextReviewAt');
        expect(data.inherentRisk).toBe('MEDIUM');
        expect(data.lastAssessmentReviewedAt).toBeInstanceOf(Date);
    });

    it('rolls forward when the vendor row cannot be read back at all', async () => {
        seedReview();
        mockPrisma.vendor.findFirst.mockResolvedValue(null);
        await reviewAssessment(makeCtx(), 'a-1', { finalRiskRating: 'MEDIUM' });
        const { data } = vendorUpdateData();
        expect((data.nextReviewAt as Date).getTime())
            .toBeGreaterThan(Date.now() + 364 * DAY);
    });

    it('scopes the writeback to the tenant as well as the vendor', async () => {
        seedReview();
        await reviewAssessment(makeCtx(), 'a-1', { finalRiskRating: 'MEDIUM' });
        const args = mockPrisma.vendor.updateMany.mock.calls[0][0] as {
            where: Record<string, unknown>;
        };
        expect(args.where).toEqual({ id: 'vendor-1', tenantId: 'tenant-1' });
    });

    it('logs at warn and STILL creates the register risk when the tier writeback throws', async () => {
        seedReview();
        mockPrisma.vendor.findFirst.mockRejectedValue(new Error('vendor read failed'));
        const r = await reviewAssessment(makeCtx(), 'a-1', { finalRiskRating: 'HIGH' });
        expect(mockPrisma.vendor.updateMany).not.toHaveBeenCalled();
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            'vendor-assessment-review: inherent-risk writeback failed',
            expect.objectContaining({ vendorId: 'vendor-1' }),
        );
        // The catch is scoped to step 1 only — step 2 must still run.
        expect(r.autoCreatedRiskId).toBe('risk-1');
    });

    it('normalises a non-Error tier-writeback rejection before logging it', async () => {
        seedReview();
        mockPrisma.vendor.findFirst.mockRejectedValue('vendor read exploded');
        await reviewAssessment(makeCtx(), 'a-1', { finalRiskRating: 'MEDIUM' });
        const call = mockLoggerWarn.mock.calls.find(
            (c) => String(c[0]).includes('inherent-risk writeback failed'),
        );
        expect(call).toBeDefined();
        const { err } = call![1] as { err: Error };
        // A bare string reaching the log fields would serialise as `{}` in the
        // structured logger and lose the reason entirely.
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe('vendor read exploded');
    });

    it('does not touch the vendor row at all when the review landed no rating', async () => {
        seedReview();
        await reviewAssessment(makeCtx(), 'a-1', { finalRiskRating: null });
        expect(mockPrisma.vendor.findFirst).not.toHaveBeenCalled();
        expect(mockPrisma.vendor.updateMany).not.toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════════════════════════════════
// 8. Auto-risk gating + idempotency-marker specificity
// ═══════════════════════════════════════════════════════════════════

describe('applyAssessmentRiskWriteback — auto-risk gating', () => {
    it('materialises a register Risk on HIGH', async () => {
        seedReview({ vendorName: 'Globex' });
        const r = await reviewAssessment(makeCtx(), 'a-1', { finalRiskRating: 'HIGH' });
        expect(r.autoCreatedRiskId).toBe('risk-1');
        expect(mockCreateRisk.mock.calls[0][1]).toMatchObject({
            title: 'Vendor risk: Globex (HIGH) — from assessment',
            category: 'Third-party',
        });
    });

    it('does NOT materialise on MEDIUM, though the tier writeback still runs', async () => {
        seedReview();
        const r = await reviewAssessment(makeCtx(), 'a-1', { finalRiskRating: 'MEDIUM' });
        expect(r.autoCreatedRiskId).toBeNull();
        expect(mockCreateRisk).not.toHaveBeenCalled();
        expect(mockListVendorLinks).not.toHaveBeenCalled();
        // The distinguishing effect: MEDIUM still stamps the vendor tier.
        expect(vendorUpdateData().data.inherentRisk).toBe('MEDIUM');
    });

    it('names an unloadable vendor as the empty string, never "undefined"', async () => {
        seedReview({ vendorName: null });
        await reviewAssessment(makeCtx(), 'a-1', { finalRiskRating: 'CRITICAL' });
        const { title } = mockCreateRisk.mock.calls[0][1] as { title: string };
        expect(title).toBe('Vendor risk:  (CRITICAL) — from assessment');
        expect(title).not.toContain('undefined');
    });

    it('is NOT suppressed by an unrelated RISK link, nor by a non-RISK marker', async () => {
        // The PR-S invariant. Keying on "any RISK link" — or on the relation
        // alone — would swallow this materialisation forever.
        seedReview();
        mockListVendorLinks.mockResolvedValue([
            { entityType: 'RISK', relation: 'RELATED', entityId: 'risk-manual' },
            { entityType: 'CONTROL', relation: 'ASSESSMENT_SOURCED', entityId: 'ctl-1' },
        ]);
        const r = await reviewAssessment(makeCtx(), 'a-1', { finalRiskRating: 'HIGH' });
        expect(mockCreateRisk).toHaveBeenCalledTimes(1);
        expect(r.autoCreatedRiskId).toBe('risk-1');
    });

    it('logs the skip at info when the ASSESSMENT_SOURCED marker is already present', async () => {
        seedReview();
        mockListVendorLinks.mockResolvedValue([
            { entityType: 'RISK', relation: 'ASSESSMENT_SOURCED', entityId: 'risk-prior' },
        ]);
        const r = await reviewAssessment(makeCtx(), 'a-1', { finalRiskRating: 'HIGH' });
        expect(r.autoCreatedRiskId).toBeNull();
        expect(mockLoggerInfo).toHaveBeenCalledWith(
            expect.stringContaining('already exists'),
            expect.objectContaining({ vendorId: 'vendor-1', riskRating: 'HIGH' }),
        );
    });

    it('logs the happy materialisation at info with the new risk id', async () => {
        seedReview();
        await reviewAssessment(makeCtx(), 'a-1', { finalRiskRating: 'CRITICAL' });
        expect(mockLoggerInfo).toHaveBeenCalledWith(
            expect.stringContaining('auto-created register risk'),
            expect.objectContaining({ riskId: 'risk-1', riskRating: 'CRITICAL' }),
        );
    });

    it('normalises a non-Error link rejection into an Error before logging it', async () => {
        seedReview();
        mockAddVendorLink.mockRejectedValue('link exploded');
        const r = await reviewAssessment(makeCtx(), 'a-1', { finalRiskRating: 'HIGH' });
        expect(r.autoCreatedRiskId).toBe('risk-1');
        const fields = mockLoggerError.mock.calls[0][1] as { err: unknown };
        expect(fields.err).toBeInstanceOf(Error);
        expect((fields.err as Error).message).toBe('link exploded');
    });

    it('normalises a non-Error creation rejection too, and reports no risk', async () => {
        seedReview();
        mockCreateRisk.mockRejectedValue('boom');
        const r = await reviewAssessment(makeCtx(), 'a-1', { finalRiskRating: 'HIGH' });
        expect(r.autoCreatedRiskId).toBeNull();
        const warnCall = mockLoggerWarn.mock.calls.find(
            (c) => String(c[0]).includes('auto-risk creation failed'),
        );
        expect(warnCall).toBeDefined();
        expect((warnCall![1] as { err: Error }).err).toBeInstanceOf(Error);
        expect((warnCall![1] as { err: Error }).err.message).toBe('boom');
    });
});

// ═══════════════════════════════════════════════════════════════════
// 9. getReviewView — the context-missing refusal
// ═══════════════════════════════════════════════════════════════════

function seedView(over: { vendor?: unknown; template?: unknown } = {}) {
    mockTx.vendorAssessment.findFirst.mockResolvedValueOnce({
        id: 'a-1',
        status: 'REVIEWED',
        vendorId: 'v-1',
        templateVersionId: 'tv-1',
        submittedAt: new Date('2026-05-01T00:00:00Z'),
        reviewedAt: new Date('2026-05-02T00:00:00Z'),
        reviewedByUserId: 'user-reviewer',
        reviewerNotes: 'stored note',
        riskRating: 'HIGH',
        closedAt: new Date('2026-05-03T00:00:00Z'),
    });
    mockTx.vendor.findUnique.mockResolvedValue(
        'vendor' in over ? over.vendor : { id: 'v-1', name: 'Acme' },
    );
    mockTx.vendorAssessmentTemplate.findUnique.mockResolvedValue(
        'template' in over
            ? over.template
            : {
                id: 'tv-1', key: 'soc2', version: 2, name: 'SOC 2',
                description: null, isPublished: false,
                scoringConfigJson: null, sections: [], questions: [],
            },
    );
    mockTx.vendorAssessmentAnswer.findMany.mockResolvedValue([]);
}

describe('getReviewView — context resolution', () => {
    it('refuses a reader-less caller with ForbiddenError, not a 400', async () => {
        const err = await getReviewView(makeCtx({ canRead: false }), 'a-1')
            .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ForbiddenError);
        expect(err).not.toBeInstanceOf(ValidationError);
    });

    it('404s with a DIFFERENT message when the vendor row is gone', async () => {
        seedView({ vendor: null });
        const err = await getReviewView(makeCtx(), 'a-1').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(NotFoundError);
        expect((err as Error).message).toBe('Assessment context not found');
    });

    it('404s when the template version row is gone', async () => {
        seedView({ template: null });
        const err = await getReviewView(makeCtx(), 'a-1').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(NotFoundError);
        expect((err as Error).message).toBe('Assessment context not found');
    });

    it('serialises a fully-closed assessment’s timestamps rather than nulling them', async () => {
        seedView();
        const view = await getReviewView(makeCtx(), 'a-1');
        expect(view.submittedAt).toBe('2026-05-01T00:00:00.000Z');
        expect(view.reviewedAt).toBe('2026-05-02T00:00:00.000Z');
        expect(view.closedAt).toBe('2026-05-03T00:00:00.000Z');
        expect(view.reviewedByUserId).toBe('user-reviewer');
        expect(view.reviewerNotes).toBe('stored note');
        expect(view.riskRating).toBe('HIGH');
        expect(view.template.isPublished).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════
// 10. closeAssessment
// ═══════════════════════════════════════════════════════════════════

const closeUpdateData = () =>
    mockTx.vendorAssessment.update.mock.calls[0][0].data as Record<string, unknown>;

describe('closeAssessment — notes are optional-three-state and guards are typed', () => {
    it('refuses a non-admin with ForbiddenError before any read', async () => {
        await expect(closeAssessment(makeCtx({ canAdmin: false }), 'a-1'))
            .rejects.toBeInstanceOf(ForbiddenError);
        expect(mockTx.vendorAssessment.findFirst).not.toHaveBeenCalled();
    });

    it('404s on a missing assessment and writes nothing', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValueOnce(null);
        const err = await closeAssessment(makeCtx(), 'gone').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(NotFoundError);
        expect(mockTx.vendorAssessment.update).not.toHaveBeenCalled();
        expect(mockLogEvent).not.toHaveBeenCalled();
    });

    it('400s on a non-REVIEWED assessment, naming the status it found', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValueOnce({ id: 'a-1', status: 'CLOSED' });
        const err = await closeAssessment(makeCtx(), 'a-1').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as Error).message).toContain('status CLOSED');
        expect(mockTx.vendorAssessment.update).not.toHaveBeenCalled();
    });

    it('omits reviewerNotes entirely when no note is passed', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValueOnce({ id: 'a-1', status: 'REVIEWED' });
        mockTx.vendorAssessment.update.mockResolvedValue({});
        await closeAssessment(makeCtx(), 'a-1');
        // Omitted, not undefined-valued: closing must not be able to erase the
        // reviewer's note.
        expect(Object.keys(closeUpdateData())).not.toContain('reviewerNotes');
    });

    it('sanitises a closing note', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValueOnce({ id: 'a-1', status: 'REVIEWED' });
        mockTx.vendorAssessment.update.mockResolvedValue({});
        await closeAssessment(makeCtx(), 'a-1', '<b>done</b>');
        expect(closeUpdateData().reviewerNotes).toBe('CLEAN:<b>done</b>');
    });

    it('clears the note on an explicit null', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValueOnce({ id: 'a-1', status: 'REVIEWED' });
        mockTx.vendorAssessment.update.mockResolvedValue({});
        await closeAssessment(makeCtx(), 'a-1', null);
        const data = closeUpdateData();
        expect(Object.keys(data)).toContain('reviewerNotes');
        expect(data.reviewerNotes).toBeNull();
    });

    it('clears the note on an empty string rather than storing "CLEAN:"', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValueOnce({ id: 'a-1', status: 'REVIEWED' });
        mockTx.vendorAssessment.update.mockResolvedValue({});
        await closeAssessment(makeCtx(), 'a-1', '');
        expect(closeUpdateData().reviewerNotes).toBeNull();
    });

    it('audits the close against the assessment with the same closedAt it returns', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValueOnce({ id: 'a-1', status: 'REVIEWED' });
        mockTx.vendorAssessment.update.mockResolvedValue({});
        const res = await closeAssessment(makeCtx(), 'a-1');
        const ev = mockLogEvent.mock.calls[0][2] as {
            action: string; entityType: string; entityId: string;
            detailsJson: { after: { status: string; closedAt: string } };
        };
        expect(ev.action).toBe('VENDOR_ASSESSMENT_CLOSED');
        expect(ev.entityType).toBe('VendorAssessment');
        expect(ev.entityId).toBe('a-1');
        expect(ev.detailsJson.after.status).toBe('CLOSED');
        expect(ev.detailsJson.after.closedAt).toBe(res.closedAt.toISOString());
        expect(closeUpdateData().closedByUserId).toBe('user-reviewer');
    });
});

// ═══════════════════════════════════════════════════════════════════
// 11. listVendorAssessments — the never-sent row
// ═══════════════════════════════════════════════════════════════════

describe('listVendorAssessments — a DRAFT that was never sent', () => {
    it('reports sentAt as present-and-null rather than omitting the key', async () => {
        // Every fixture in the sibling list file carries a `sentAt`, so the
        // null arm of this serialisation was unexecuted — and the client
        // distinguishes "never sent" from "field missing".
        mockTx.vendorAssessment.findMany.mockResolvedValue([
            {
                id: 'a-draft', status: 'DRAFT', score: null, riskRating: null,
                startedAt: null, sentAt: null, submittedAt: null,
                reviewedAt: null, closedAt: null, respondentEmail: null,
                externalAccessTokenExpiresAt: null, revokedAt: null,
                template: null, templateVersion: null,
            },
        ]);
        const [row] = await listVendorAssessments(makeCtx(), 'v1');
        expect(row).toHaveProperty('sentAt', null);
        expect(row.status).toBe('DRAFT');
    });
});
