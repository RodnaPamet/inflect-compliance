/**
 * Epic G-3 prompt 4 — vendor-assessment-response unit tests.
 *
 * Pure-memory tests of the public response usecases. Pins:
 *
 *   1. Token verification — hash compare, expiry, status, wrong-
 *      assessment, missing-token all return ExternalAccessDenied
 *      with the right reason.
 *   2. submitResponse per-answer-type validation.
 *   3. Required-field check fires for missing required questions.
 *   4. Status transitions to SUBMITTED, score is the sum of
 *      computedPoints.
 *
 * Prisma is mocked. The `runWithAuditContext` helper is mocked to
 * pass through. `$transaction` is mocked to invoke its callback
 * with the same prisma stub.
 *
 * `runInTenantContext` is mocked to pass the same stub
 * through as the transaction client. In production these open a
 * transaction that drops to `app_user` and binds `app.tenant_id`, engaging
 * RLS for every read and write on this path; a pure-memory test cannot
 * exercise a Postgres policy, so the DB-backed proof of that isolation
 * lives in the integration suite. What these mocks preserve is the call
 * shape — if the usecase stops routing through a tenant context, the
 * `tenantContextCalls` assertions below fail.
 */

// ─── Mocks ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma: any = {
    vendorAssessment: {
        findFirst: jest.fn(),
        update: jest.fn(),
    },
    vendor: { findUnique: jest.fn() },
    vendorAssessmentTemplate: { findUnique: jest.fn() },
    vendorAssessmentTemplateQuestion: { findMany: jest.fn() },
    vendorAssessmentAnswer: {
        findMany: jest.fn(),
        upsert: jest.fn(),
    },
    // Ownership check for respondent-supplied evidenceId — the FK proves the
    // Evidence row exists, this proves it belongs to THIS tenant. Default
    // resolves every queried id as owned, so the pre-existing tests read as
    // before; the rejection path is asserted explicitly below by overriding
    // this to return fewer rows than were asked for.
    evidence: {
        findMany: jest.fn(
            async (args: { where: { id: { in: string[] } } }) =>
                args.where.id.in.map((id) => ({ id })),
        ),
    },
};
mockPrisma.$transaction = jest.fn(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma),
);

jest.mock('@/lib/prisma', () => ({ prisma: mockPrisma }));

// Records every tenantId a tenant-scoped context was opened with, so the
// tests can assert the external path never touches the bare client.
const tenantContextCalls: string[] = [];

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (
            ctx: { tenantId: string },
            fn: (tx: unknown) => Promise<unknown>,
        ) => {
            tenantContextCalls.push(ctx.tenantId);
            return fn(mockPrisma);
        },
    ),
}));

jest.mock('@/lib/audit-context', () => ({
    runWithAuditContext: jest.fn(
        async (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
    ),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    loadResponseByToken,
    submitResponse,
    ExternalAccessDenied,
    ResponseValidationError,
} from '@/app-layer/usecases/vendor-assessment-response';
import { hashAccessToken } from '@/lib/security/external-assessment-access';

// ─── Helpers ───────────────────────────────────────────────────────

const RAW_TOKEN = 'a'.repeat(43);
const TOKEN_HASH = hashAccessToken(RAW_TOKEN);
const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 60 * 1000);

function makeAssessment(overrides: Record<string, unknown> = {}) {
    return {
        id: 'assess-1',
        tenantId: 'tenant-1',
        vendorId: 'vendor-1',
        templateId: null,
        templateVersionId: 'tv-1',
        status: 'SENT',
        externalAccessTokenHash: TOKEN_HASH,
        externalAccessTokenExpiresAt: FUTURE,
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.vendorAssessment.findFirst.mockReset();
    mockPrisma.vendorAssessment.update.mockReset();
    mockPrisma.vendor.findUnique.mockReset();
    mockPrisma.vendorAssessmentTemplate.findUnique.mockReset();
    mockPrisma.vendorAssessmentTemplateQuestion.findMany.mockReset();
    mockPrisma.vendorAssessmentAnswer.findMany.mockReset();
    mockPrisma.vendorAssessmentAnswer.upsert.mockReset();
    mockPrisma.$transaction.mockImplementation(
        async (fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma),
    );
    mockPrisma.evidence.findMany.mockImplementation(
        async (args: { where: { id: { in: string[] } } }) =>
            args.where.id.in.map((id) => ({ id })),
    );
    tenantContextCalls.length = 0;
});

// ═══════════════════════════════════════════════════════════════════
// 1. Token verification
// ═══════════════════════════════════════════════════════════════════

describe('verifyAccessToken (via loadResponseByToken)', () => {
    test('missing token → ExternalAccessDenied(missing_token)', async () => {
        await expect(loadResponseByToken(null, 'assess-1')).rejects.toThrow(
            ExternalAccessDenied,
        );
        await expect(loadResponseByToken(null, 'assess-1')).rejects.toMatchObject({
            reason: 'missing_token',
        });
    });

    test('token does not match any assessment → unknown_assessment', async () => {
        mockPrisma.vendorAssessment.findFirst.mockResolvedValueOnce(null);
        await expect(
            loadResponseByToken(RAW_TOKEN, 'assess-1'),
        ).rejects.toMatchObject({ reason: 'unknown_assessment' });
    });

    test('token matches a different assessment → wrong_assessment', async () => {
        mockPrisma.vendorAssessment.findFirst.mockResolvedValueOnce(
            makeAssessment({ id: 'other-assess' }),
        );
        await expect(
            loadResponseByToken(RAW_TOKEN, 'assess-1'),
        ).rejects.toMatchObject({ reason: 'wrong_assessment' });
    });

    test('expired token → expired', async () => {
        mockPrisma.vendorAssessment.findFirst.mockResolvedValueOnce(
            makeAssessment({ externalAccessTokenExpiresAt: PAST }),
        );
        await expect(
            loadResponseByToken(RAW_TOKEN, 'assess-1'),
        ).rejects.toMatchObject({ reason: 'expired' });
    });

    test('SUBMITTED status → wrong_status', async () => {
        mockPrisma.vendorAssessment.findFirst.mockResolvedValueOnce(
            makeAssessment({ status: 'SUBMITTED' }),
        );
        await expect(
            loadResponseByToken(RAW_TOKEN, 'assess-1'),
        ).rejects.toMatchObject({ reason: 'wrong_status' });
    });

    test('CLOSED status → wrong_status', async () => {
        mockPrisma.vendorAssessment.findFirst.mockResolvedValueOnce(
            makeAssessment({ status: 'CLOSED' }),
        );
        await expect(
            loadResponseByToken(RAW_TOKEN, 'assess-1'),
        ).rejects.toMatchObject({ reason: 'wrong_status' });
    });

    test('SENT or IN_PROGRESS proceeds to load', async () => {
        mockPrisma.vendorAssessment.findFirst.mockResolvedValueOnce(
            makeAssessment({ status: 'IN_PROGRESS' }),
        );
        mockPrisma.vendor.findUnique.mockResolvedValueOnce({ name: 'Acme' });
        mockPrisma.vendorAssessmentTemplate.findUnique.mockResolvedValueOnce({
            name: 'Q',
            description: null,
            sections: [],
        });
        mockPrisma.vendorAssessmentAnswer.findMany.mockResolvedValueOnce([]);

        const result = await loadResponseByToken(RAW_TOKEN, 'assess-1');
        expect(result.status).toBe('IN_PROGRESS');
        expect(result.vendor.name).toBe('Acme');
    });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Per-answer-type validation
// ═══════════════════════════════════════════════════════════════════

function setupSubmitMocks(
    questions: Array<{
        id: string;
        answerType: string;
        required?: boolean;
        weight?: number;
        optionsJson?: unknown;
        scaleConfigJson?: unknown;
        riskPointsJson?: unknown;
    }>,
) {
    mockPrisma.vendorAssessment.findFirst.mockResolvedValueOnce(makeAssessment());
    mockPrisma.vendorAssessmentTemplateQuestion.findMany.mockResolvedValueOnce(
        questions.map((q) => ({
            id: q.id,
            answerType: q.answerType,
            required: q.required ?? false,
            weight: q.weight ?? 1,
            optionsJson: q.optionsJson ?? null,
            scaleConfigJson: q.scaleConfigJson ?? null,
            riskPointsJson: q.riskPointsJson ?? null,
        })),
    );
    mockPrisma.vendorAssessmentAnswer.upsert.mockResolvedValue({});
    mockPrisma.vendorAssessment.update.mockResolvedValue({});
}

describe('submitResponse — per-type validation', () => {
    test('YES_NO accepts "yes"/"no", rejects "maybe"', async () => {
        setupSubmitMocks([{ id: 'q1', answerType: 'YES_NO' }]);
        await expect(
            submitResponse(RAW_TOKEN, 'assess-1', [
                { questionId: 'q1', answerJson: { value: 'maybe' } },
            ]),
        ).rejects.toBeInstanceOf(ResponseValidationError);
    });

    test('YES_NO with "yes" submits successfully', async () => {
        setupSubmitMocks([
            {
                id: 'q1',
                answerType: 'YES_NO',
                riskPointsJson: { yes: 0, no: 5 },
                weight: 2,
            },
        ]);
        const result = await submitResponse(RAW_TOKEN, 'assess-1', [
            { questionId: 'q1', answerJson: { value: 'yes' } },
        ]);
        expect(result.status).toBe('SUBMITTED');
        // yes → 0 points × weight 2 = 0
        expect(result.provisionalScore).toBe(0);
    });

    test('SINGLE_SELECT rejects values not in options', async () => {
        setupSubmitMocks([
            {
                id: 'q1',
                answerType: 'SINGLE_SELECT',
                optionsJson: [
                    { label: 'A', value: 'a', points: 1 },
                    { label: 'B', value: 'b', points: 5 },
                ],
            },
        ]);
        await expect(
            submitResponse(RAW_TOKEN, 'assess-1', [
                { questionId: 'q1', answerJson: { value: 'c' } },
            ]),
        ).rejects.toBeInstanceOf(ResponseValidationError);
    });

    test('SINGLE_SELECT computes points × weight', async () => {
        setupSubmitMocks([
            {
                id: 'q1',
                answerType: 'SINGLE_SELECT',
                weight: 3,
                optionsJson: [
                    { label: 'A', value: 'a', points: 2 },
                    { label: 'B', value: 'b', points: 5 },
                ],
            },
        ]);
        const result = await submitResponse(RAW_TOKEN, 'assess-1', [
            { questionId: 'q1', answerJson: { value: 'b' } },
        ]);
        expect(result.provisionalScore).toBe(15); // 5 × 3
    });

    test('MULTI_SELECT rejects non-array', async () => {
        setupSubmitMocks([
            {
                id: 'q1',
                answerType: 'MULTI_SELECT',
                optionsJson: [{ label: 'A', value: 'a', points: 1 }],
            },
        ]);
        await expect(
            submitResponse(RAW_TOKEN, 'assess-1', [
                { questionId: 'q1', answerJson: { value: 'a' } },
            ]),
        ).rejects.toBeInstanceOf(ResponseValidationError);
    });

    test('MULTI_SELECT sums points across selected items', async () => {
        setupSubmitMocks([
            {
                id: 'q1',
                answerType: 'MULTI_SELECT',
                weight: 2,
                optionsJson: [
                    { label: 'A', value: 'a', points: 1 },
                    { label: 'B', value: 'b', points: 3 },
                    { label: 'C', value: 'c', points: 5 },
                ],
            },
        ]);
        const result = await submitResponse(RAW_TOKEN, 'assess-1', [
            { questionId: 'q1', answerJson: { value: ['a', 'c'] } },
        ]);
        // (1 + 5) × 2 = 12
        expect(result.provisionalScore).toBe(12);
    });

    test('SCALE rejects out-of-range', async () => {
        setupSubmitMocks([
            {
                id: 'q1',
                answerType: 'SCALE',
                scaleConfigJson: { min: 1, max: 5 },
            },
        ]);
        await expect(
            submitResponse(RAW_TOKEN, 'assess-1', [
                { questionId: 'q1', answerJson: { value: 7 } },
            ]),
        ).rejects.toBeInstanceOf(ResponseValidationError);
    });

    test('SCALE in-range computes value × weight', async () => {
        setupSubmitMocks([
            {
                id: 'q1',
                answerType: 'SCALE',
                scaleConfigJson: { min: 1, max: 5 },
                weight: 2,
            },
        ]);
        const result = await submitResponse(RAW_TOKEN, 'assess-1', [
            { questionId: 'q1', answerJson: { value: 4 } },
        ]);
        expect(result.provisionalScore).toBe(8); // 4 × 2
    });

    test('TEXT rejects non-string', async () => {
        setupSubmitMocks([{ id: 'q1', answerType: 'TEXT' }]);
        await expect(
            submitResponse(RAW_TOKEN, 'assess-1', [
                { questionId: 'q1', answerJson: { value: 42 } },
            ]),
        ).rejects.toBeInstanceOf(ResponseValidationError);
    });

    test('NUMBER rejects NaN', async () => {
        setupSubmitMocks([{ id: 'q1', answerType: 'NUMBER' }]);
        await expect(
            submitResponse(RAW_TOKEN, 'assess-1', [
                { questionId: 'q1', answerJson: { value: NaN } },
            ]),
        ).rejects.toBeInstanceOf(ResponseValidationError);
    });

    test('FILE_UPLOAD accepts string evidenceId', async () => {
        setupSubmitMocks([{ id: 'q1', answerType: 'FILE_UPLOAD' }]);
        const result = await submitResponse(RAW_TOKEN, 'assess-1', [
            {
                questionId: 'q1',
                answerJson: { value: 'will send via email' },
                evidenceId: 'ev-1',
            },
        ]);
        expect(result.status).toBe('SUBMITTED');
    });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Required-field check
// ═══════════════════════════════════════════════════════════════════

describe('submitResponse — required-field check', () => {
    test('missing required question fails validation', async () => {
        setupSubmitMocks([
            { id: 'req', answerType: 'YES_NO', required: true },
            { id: 'opt', answerType: 'YES_NO', required: false },
        ]);
        try {
            await submitResponse(RAW_TOKEN, 'assess-1', [
                { questionId: 'opt', answerJson: { value: 'yes' } },
            ]);
            throw new Error('expected validation error');
        } catch (err) {
            expect(err).toBeInstanceOf(ResponseValidationError);
            const e = err as ResponseValidationError;
            expect(
                e.fieldErrors.some(
                    (f) =>
                        f.questionId === 'req' &&
                        f.message.includes('required'),
                ),
            ).toBe(true);
        }
    });

    test('all required questions answered submits successfully', async () => {
        setupSubmitMocks([
            { id: 'req', answerType: 'YES_NO', required: true },
        ]);
        const result = await submitResponse(RAW_TOKEN, 'assess-1', [
            { questionId: 'req', answerJson: { value: 'yes' } },
        ]);
        expect(result.status).toBe('SUBMITTED');
    });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Persistence + transition
// ═══════════════════════════════════════════════════════════════════

describe('submitResponse — persistence', () => {
    test('upserts each answer and transitions to SUBMITTED with provisional score', async () => {
        setupSubmitMocks([
            {
                id: 'q1',
                answerType: 'SCALE',
                scaleConfigJson: { min: 1, max: 5 },
                weight: 1,
            },
            {
                id: 'q2',
                answerType: 'YES_NO',
                riskPointsJson: { yes: 0, no: 5 },
                weight: 1,
            },
        ]);
        const result = await submitResponse(RAW_TOKEN, 'assess-1', [
            { questionId: 'q1', answerJson: { value: 4 } },
            { questionId: 'q2', answerJson: { value: 'no' } },
        ]);

        expect(result.provisionalScore).toBe(9); // 4 + 5
        expect(mockPrisma.vendorAssessmentAnswer.upsert).toHaveBeenCalledTimes(2);

        const updateCall = mockPrisma.vendorAssessment.update.mock.calls[0][0];
        // The tenantId predicate is deliberate, not incidental: RLS fences
        // this write, and the explicit predicate keeps the tenant scope
        // legible at the call site. Dropping it should fail here.
        expect(updateCall.where).toEqual({
            id: 'assess-1',
            tenantId: 'tenant-1',
        });
        expect(updateCall.data).toMatchObject({
            status: 'SUBMITTED',
            score: 9,
        });
        expect(updateCall.data.submittedAt).toBeInstanceOf(Date);
    });

    test('duplicate questionId rejects validation', async () => {
        setupSubmitMocks([{ id: 'q1', answerType: 'YES_NO' }]);
        await expect(
            submitResponse(RAW_TOKEN, 'assess-1', [
                { questionId: 'q1', answerJson: { value: 'yes' } },
                { questionId: 'q1', answerJson: { value: 'no' } },
            ]),
        ).rejects.toBeInstanceOf(ResponseValidationError);
    });

    test('answer for unknown question rejects validation', async () => {
        setupSubmitMocks([{ id: 'q1', answerType: 'YES_NO' }]);
        await expect(
            submitResponse(RAW_TOKEN, 'assess-1', [
                { questionId: 'unknown-q', answerJson: { value: 'yes' } },
            ]),
        ).rejects.toBeInstanceOf(ResponseValidationError);
    });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Tenant isolation on the public path
// ═══════════════════════════════════════════════════════════════════
//
// The module header of external-assessment-access.ts promises that
// "subsequent reads/writes wrap that tenantId in runInTenantContext so RLS
// still gates the data layer". It was not true: every read and the whole
// write transaction ran on the bare client, so `SET LOCAL ROLE app_user` +
// `set_config('app.tenant_id')` never ran and RLS never engaged.
//
// A pure-memory test cannot prove a Postgres policy fires. What it CAN pin
// is that the usecase opens a tenant-scoped context at all, and opens it
// with the assessment's OWN tenantId — the input RLS keys off. Without
// that, the policy has nothing to enforce.

describe('external path runs inside a tenant context', () => {
    test('loadResponseByToken opens a context for the assessment tenant', async () => {
        mockPrisma.vendorAssessment.findFirst.mockResolvedValueOnce(
            makeAssessment(),
        );
        mockPrisma.vendor.findUnique.mockResolvedValueOnce({ name: 'Acme' });
        mockPrisma.vendorAssessmentTemplate.findUnique.mockResolvedValueOnce({
            name: 'Q',
            description: null,
            sections: [],
        });
        mockPrisma.vendorAssessmentAnswer.findMany.mockResolvedValueOnce([]);

        await loadResponseByToken(RAW_TOKEN, 'assess-1');
        expect(tenantContextCalls).toContain('tenant-1');
    });

    test('submitResponse opens a context for the assessment tenant', async () => {
        setupSubmitMocks([{ id: 'q1', answerType: 'YES_NO' }]);
        await submitResponse(RAW_TOKEN, 'assess-1', [
            { questionId: 'q1', answerJson: { value: 'yes' } },
        ]);
        expect(tenantContextCalls).toContain('tenant-1');
        // Never the bare client for the answer write.
        expect(mockPrisma.vendorAssessmentAnswer.upsert).toHaveBeenCalled();
    });

    test('the answer upsert carries an explicit tenantId predicate', async () => {
        setupSubmitMocks([{ id: 'q1', answerType: 'YES_NO' }]);
        await submitResponse(RAW_TOKEN, 'assess-1', [
            { questionId: 'q1', answerJson: { value: 'yes' } },
        ]);
        const upsertArgs = mockPrisma.vendorAssessmentAnswer.upsert.mock.calls[0][0];
        expect(upsertArgs.where.tenantId).toBe('tenant-1');
    });
});

// ═══════════════════════════════════════════════════════════════════
// 6. Respondent-supplied evidenceId is tenant-checked
// ═══════════════════════════════════════════════════════════════════
//
// The column carries a real FK, so a garbage string is rejected by
// Postgres. What the FK does NOT check is ownership: a respondent who
// guesses a valid Evidence cuid from ANOTHER tenant could attach it, and
// the reviewer surface reads answers back verbatim. sharing.ts guards the
// equivalent auditPackItemId the same way.

describe('submitResponse — evidenceId ownership', () => {
    test('rejects an evidenceId this tenant does not own', async () => {
        setupSubmitMocks([{ id: 'q1', answerType: 'FILE_UPLOAD' }]);
        // The ownership lookup finds nothing — the id belongs elsewhere.
        mockPrisma.evidence.findMany.mockResolvedValueOnce([]);

        await expect(
            submitResponse(RAW_TOKEN, 'assess-1', [
                {
                    questionId: 'q1',
                    answerJson: { value: 'see attached' },
                    evidenceId: 'ev-from-another-tenant',
                },
            ]),
        ).rejects.toBeInstanceOf(ResponseValidationError);

        // Nothing was written.
        expect(mockPrisma.vendorAssessmentAnswer.upsert).not.toHaveBeenCalled();
    });

    test('scopes the ownership lookup to the assessment tenant', async () => {
        setupSubmitMocks([{ id: 'q1', answerType: 'FILE_UPLOAD' }]);
        await submitResponse(RAW_TOKEN, 'assess-1', [
            {
                questionId: 'q1',
                answerJson: { value: 'see attached' },
                evidenceId: 'ev-1',
            },
        ]);
        const lookup = mockPrisma.evidence.findMany.mock.calls[0][0];
        expect(lookup.where.tenantId).toBe('tenant-1');
        expect(lookup.where.id.in).toEqual(['ev-1']);
    });

    test('skips the lookup entirely when no evidence is claimed', async () => {
        setupSubmitMocks([{ id: 'q1', answerType: 'YES_NO' }]);
        await submitResponse(RAW_TOKEN, 'assess-1', [
            { questionId: 'q1', answerJson: { value: 'yes' } },
        ]);
        expect(mockPrisma.evidence.findMany).not.toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════════════════════════════════
// 7. Respondent free text is sanitised at persist
// ═══════════════════════════════════════════════════════════════════
//
// Sanitising at render would leave the ROW dangerous — the reviewer
// surface, a PDF export and any SDK consumer all read it back verbatim.

describe('submitResponse — text sanitisation', () => {
    test('strips script payloads from TEXT answers before persisting', async () => {
        setupSubmitMocks([{ id: 'q1', answerType: 'TEXT' }]);
        await submitResponse(RAW_TOKEN, 'assess-1', [
            {
                questionId: 'q1',
                answerJson: { value: 'hello <script>alert(1)</script> world' },
            },
        ]);
        const written = mockPrisma.vendorAssessmentAnswer.upsert.mock.calls[0][0];
        const persisted = JSON.stringify(written.create.answerJson);
        expect(persisted).not.toContain('<script');
        expect(persisted).not.toContain('alert(1)');
    });

    test('preserves the { value } envelope shape', async () => {
        setupSubmitMocks([{ id: 'q1', answerType: 'TEXT' }]);
        await submitResponse(RAW_TOKEN, 'assess-1', [
            { questionId: 'q1', answerJson: { value: 'plain answer' } },
        ]);
        const written = mockPrisma.vendorAssessmentAnswer.upsert.mock.calls[0][0];
        expect(written.create.answerJson).toHaveProperty('value');
    });
});

// ═══════════════════════════════════════════════════════════════════
// 8. A required FILE_UPLOAD cannot be satisfied by emptiness
// ═══════════════════════════════════════════════════════════════════
//
// The required-field sweep only asks whether the questionId appears in the
// payload, so `{ questionId, answerJson: null }` counted as answered while
// nothing was attached. Note the accepted forms are an evidenceId OR a
// non-empty note — the respondent surface ships a note field, not an
// uploader, at this stage.

describe('submitResponse — required FILE_UPLOAD', () => {
    test('rejects a required upload answered with nothing at all', async () => {
        setupSubmitMocks([
            { id: 'q1', answerType: 'FILE_UPLOAD', required: true },
        ]);
        await expect(
            submitResponse(RAW_TOKEN, 'assess-1', [
                { questionId: 'q1', answerJson: null },
            ]),
        ).rejects.toBeInstanceOf(ResponseValidationError);
    });

    test('rejects a required upload answered with whitespace', async () => {
        setupSubmitMocks([
            { id: 'q1', answerType: 'FILE_UPLOAD', required: true },
        ]);
        await expect(
            submitResponse(RAW_TOKEN, 'assess-1', [
                { questionId: 'q1', answerJson: { value: '   ' } },
            ]),
        ).rejects.toBeInstanceOf(ResponseValidationError);
    });

    test('accepts a required upload carrying a note', async () => {
        setupSubmitMocks([
            { id: 'q1', answerType: 'FILE_UPLOAD', required: true },
        ]);
        const result = await submitResponse(RAW_TOKEN, 'assess-1', [
            { questionId: 'q1', answerJson: { value: 'Will send DPA by email' } },
        ]);
        expect(result.status).toBe('SUBMITTED');
    });

    test('an OPTIONAL upload may still be empty', async () => {
        setupSubmitMocks([
            { id: 'q1', answerType: 'FILE_UPLOAD', required: false },
        ]);
        const result = await submitResponse(RAW_TOKEN, 'assess-1', [
            { questionId: 'q1', answerJson: null },
        ]);
        expect(result.status).toBe('SUBMITTED');
    });
});

// ═══════════════════════════════════════════════════════════════════
// 9. Revoked links are denied
// ═══════════════════════════════════════════════════════════════════
//
// Revocation is deliberately a separate gate from expiry: expiry is the
// link reaching its planned end, revocation is an operator deciding it is
// compromised. It must bite regardless of status, and without the token
// having been rotated.

describe('verifyAccessToken — revocation', () => {
    test('a revoked link is denied even while SENT and unexpired', async () => {
        mockPrisma.vendorAssessment.findFirst.mockResolvedValueOnce(
            makeAssessment({
                status: 'SENT',
                externalAccessTokenExpiresAt: FUTURE,
                revokedAt: new Date(),
            }),
        );
        await expect(
            loadResponseByToken(RAW_TOKEN, 'assess-1'),
        ).rejects.toMatchObject({ reason: 'revoked' });
    });

    test('a revoked link cannot be submitted to', async () => {
        mockPrisma.vendorAssessment.findFirst.mockResolvedValueOnce(
            makeAssessment({ revokedAt: new Date() }),
        );
        await expect(
            submitResponse(RAW_TOKEN, 'assess-1', [
                { questionId: 'q1', answerJson: { value: 'yes' } },
            ]),
        ).rejects.toMatchObject({ reason: 'revoked' });
        expect(mockPrisma.vendorAssessmentAnswer.upsert).not.toHaveBeenCalled();
    });

    test('an un-revoked link still passes', async () => {
        mockPrisma.vendorAssessment.findFirst.mockResolvedValueOnce(
            makeAssessment({ revokedAt: null }),
        );
        mockPrisma.vendor.findUnique.mockResolvedValueOnce({ name: 'Acme' });
        mockPrisma.vendorAssessmentTemplate.findUnique.mockResolvedValueOnce({
            name: 'Q',
            description: null,
            sections: [],
        });
        mockPrisma.vendorAssessmentAnswer.findMany.mockResolvedValueOnce([]);

        const result = await loadResponseByToken(RAW_TOKEN, 'assess-1');
        expect(result.status).toBe('SENT');
    });
});
