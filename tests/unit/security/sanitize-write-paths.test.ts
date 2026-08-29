/**
 * Write-path integration tests for the server-side sanitiser layer
 * (Epic C.5 + Epic D.2).
 *
 * Drives every known sanitised usecase with a hostile payload and
 * asserts the value handed to the repository is already clean. The
 * sanitiser internals are covered exhaustively in
 * `tests/unit/security/sanitize.test.ts`; here we prove the WIRING is
 * intact at every call site so a refactor that drops the sanitiser
 * call shows up here with `file:line`.
 *
 * Coverage map (kept in sync with
 * `tests/guardrails/sanitize-rich-text-coverage.test.ts::RICH_TEXT_USECASES`):
 *
 *   Epic C.5 — first wave (rich-text editor + comment surfaces)
 *     · createPolicyVersion         (HTML / MARKDOWN / EXTERNAL_LINK)
 *     · addTaskComment              (plain-text body)
 *     · addIssueComment             (covered transitively — same repo)
 *
 *   Epic D.2 — encrypted-field write paths
 *     · finding.createFinding / updateFinding
 *     · risk.createRisk / createRiskFromTemplate / updateRisk
 *     · vendor.createVendor / updateVendor / addVendorDocument
 *     · audit.createAudit / updateAudit (incl. checklist notes)
 *     · controlTest.createTestPlan / updateTestPlan / completeTestRun
 *
 * Adding a new sanitised write path: append a `describe(...)` block
 * below AND extend the static guardrail's `RICH_TEXT_USECASES` table.
 * The guardrail's `>= 8 entries` ratchet keeps this list from quietly
 * shrinking.
 */

// ─── Mocks ─────────────────────────────────────────────────────────

// Policy + task (Epic C.5 surfaces)
const mockPolicyGetById = jest.fn();
const mockPolicyVersionCreate = jest.fn();
const mockPolicySetCurrentVersion = jest.fn();
const mockPolicyUpdateStatus = jest.fn();
const mockTaskCommentAdd = jest.fn();

// Epic D.2 surfaces
const mockFindingCreate = jest.fn();
const mockFindingUpdate = jest.fn();
const mockFindingGetById = jest.fn();

const mockRiskCreate = jest.fn();
const mockRiskUpdate = jest.fn();
// updateRisk reads the prior owner via getById before writing (to fire
// the assignment notification only on an actual change). Returns
// undefined by default → previousOwnerId resolves to null.
const mockRiskGetById = jest.fn();
const mockRiskTemplateGet = jest.fn();
const mockTenantFindUnique = jest.fn();

const mockVendorCreate = jest.fn();
const mockVendorUpdate = jest.fn();
const mockVendorGetById = jest.fn();
const mockVendorDocCreate = jest.fn();

const mockAuditCreate = jest.fn();
const mockAuditUpdate = jest.fn();
const mockAuditChecklistUpdate = jest.fn();

const mockTestPlanCreate = jest.fn();
const mockTestPlanUpdate = jest.fn();
const mockTestPlanUpdateNextDueAt = jest.fn();
const mockTestPlanGetById = jest.fn();
const mockTestRunComplete = jest.fn();
const mockTestRunGetById = jest.fn();

// Epic D.2 tail — the last two KNOWN_UNCOVERED entries
const mockEvidenceGetById = jest.fn();
const mockEvidenceUpdate = jest.fn();
const mockEvidenceAddReview = jest.fn();
const mockEvidenceGetLatestSubmitters = jest.fn();
const mockNotificationCreate = jest.fn();
const mockNis2UpsertAnswer = jest.fn();
const mockNis2AssignmentFindFirst = jest.fn();

jest.mock('@/app-layer/repositories/PolicyRepository', () => ({
    PolicyRepository: {
        getById: (...args: unknown[]) => mockPolicyGetById(...args),
        setCurrentVersion: (...args: unknown[]) => mockPolicySetCurrentVersion(...args),
        updateStatus: (...args: unknown[]) => mockPolicyUpdateStatus(...args),
    },
}));

jest.mock('@/app-layer/repositories/PolicyVersionRepository', () => ({
    PolicyVersionRepository: {
        create: (...args: unknown[]) => mockPolicyVersionCreate(...args),
    },
}));

jest.mock('@/app-layer/repositories/TaskRepository', () => ({
    TaskCommentRepository: {
        add: (...args: unknown[]) => mockTaskCommentAdd(...args),
    },
    // Re-export the rest as no-op stubs the usecases pull in via the
    // same barrel.
    TaskRepository: {},
    TaskLinkRepository: {},
    TaskWatcherRepository: {},
}));

jest.mock('@/app-layer/repositories/FindingRepository', () => ({
    FindingRepository: {
        create: (...a: unknown[]) => mockFindingCreate(...a),
        update: (...a: unknown[]) => mockFindingUpdate(...a),
        getById: (...a: unknown[]) => mockFindingGetById(...a),
    },
}));

jest.mock('@/app-layer/repositories/RiskRepository', () => ({
    RiskRepository: {
        create: (...a: unknown[]) => mockRiskCreate(...a),
        update: (...a: unknown[]) => mockRiskUpdate(...a),
        getById: (...a: unknown[]) => mockRiskGetById(...a),
    },
}));

jest.mock('@/app-layer/repositories/RiskTemplateRepository', () => ({
    RiskTemplateRepository: {
        getById: (...a: unknown[]) => mockRiskTemplateGet(...a),
    },
}));

jest.mock('@/app-layer/repositories/VendorRepository', () => ({
    VendorRepository: {
        create: (...a: unknown[]) => mockVendorCreate(...a),
        update: (...a: unknown[]) => mockVendorUpdate(...a),
        getById: (...a: unknown[]) => mockVendorGetById(...a),
    },
    VendorDocumentRepository: {
        create: (...a: unknown[]) => mockVendorDocCreate(...a),
    },
    VendorLinkRepository: {},
}));

jest.mock('@/app-layer/repositories/AssessmentRepository', () => ({
    QuestionnaireRepository: {},
    VendorAssessmentRepository: {},
    VendorAnswerRepository: {},
}));

jest.mock('@/app-layer/repositories/AuditRepository', () => ({
    AuditRepository: {
        create: (...a: unknown[]) => mockAuditCreate(...a),
        update: (...a: unknown[]) => mockAuditUpdate(...a),
        updateChecklistItem: (...a: unknown[]) => mockAuditChecklistUpdate(...a),
    },
}));

jest.mock('@/app-layer/repositories/TestPlanRepository', () => ({
    TestPlanRepository: {
        create: (...a: unknown[]) => mockTestPlanCreate(...a),
        update: (...a: unknown[]) => mockTestPlanUpdate(...a),
        updateNextDueAt: (...a: unknown[]) => mockTestPlanUpdateNextDueAt(...a),
        getById: (...a: unknown[]) => mockTestPlanGetById(...a),
    },
}));

jest.mock('@/app-layer/repositories/TestRunRepository', () => ({
    TestRunRepository: {
        complete: (...a: unknown[]) => mockTestRunComplete(...a),
        getById: (...a: unknown[]) => mockTestRunGetById(...a),
    },
}));

jest.mock('@/app-layer/repositories/TestEvidenceRepository', () => ({
    TestEvidenceRepository: {},
}));

jest.mock('@/app-layer/repositories/EvidenceRepository', () => ({
    EvidenceRepository: {
        getById: (...a: unknown[]) => mockEvidenceGetById(...a),
        update: (...a: unknown[]) => mockEvidenceUpdate(...a),
        addReview: (...a: unknown[]) => mockEvidenceAddReview(...a),
        getLatestSubmitters: (...a: unknown[]) => mockEvidenceGetLatestSubmitters(...a),
    },
}));

jest.mock('@/app-layer/repositories/Nis2GapAssessmentRepository', () => ({
    Nis2GapAssessmentRepository: {
        upsertAnswer: (...a: unknown[]) => mockNis2UpsertAnswer(...a),
    },
}));

jest.mock('@/app-layer/policies/evidence.policies', () => ({
    assertCanReadEvidence: jest.fn(),
    assertCanEditEvidence: jest.fn(),
    assertCanUploadEvidence: jest.fn(),
}));

jest.mock('@/lib/cache/list-cache', () => ({
    cachedListRead: jest.fn(async (_k: unknown, fn: () => unknown) => fn()),
    bumpEntityCacheVersion: jest.fn(async () => undefined),
}));

jest.mock('@/app-layer/usecases/nis2-readiness', () => ({
    snapshotNis2Readiness: jest.fn(async () => undefined),
}));

// `runInTenantContext` returns a stub Prisma tx. Risk usecase uses
// `tenant.findUnique` against it for maxScale lookup.
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx, fn) =>
        fn({
            tenant: { findUnique: (...a: unknown[]) => mockTenantFindUnique(...a) },
            // Task child-row writes (comment/watcher/link) now pre-check that
            // the parent task belongs to the tenant before inserting, so the
            // stub tx needs a resolvable task row.
            task: { findFirst: async () => ({ id: 't1' }) },
            // Vendor owner assignment resolves an ACTIVE membership in this
            // tenant before the write — ownerUserId is caller-supplied and
            // was previously stored verbatim.
            tenantMembership: { findFirst: async () => ({ id: 'mem-1' }) },
            // RQ2-1 — score writes append a ledger event on the same tx.
            riskScoreEvent: { create: async () => ({ id: 'evt-1' }) },
            // R2-P2 — completeTestRun attests the control on completion.
            control: {
                findFirst: async () => ({ id: 'c1', frequency: 'MONTHLY', applicability: 'APPLICABLE' }),
                update: async () => ({ id: 'c1' }),
            },
            // feat/audit-cycle-unify — updateAudit reads prior checklist
            // results to detect a genuine transition INTO FAIL. Return
            // ci-2 as already FAIL so the incidental FAIL in the
            // sanitisation test does NOT trigger the finding cascade
            // (the cascade is covered by audit.test.ts + readiness-finding-fold).
            auditChecklistItem: {
                findMany: async () => [
                    { id: 'ci-1', prompt: 'Item 1', result: 'PASS', auditId: 'a1' },
                    { id: 'ci-2', prompt: 'Item 2', result: 'FAIL', auditId: 'a1' },
                ],
            },
            // Defensive stub for the FAIL-cascade idempotency read.
            finding: { findFirst: async () => null, count: async () => 0 },
            // reviewEvidence notifies the evidence owner; the notification
            // body carries the reviewer comment, so it is a second renderer
            // of the same free text and is asserted clean below.
            notification: { create: (...a: unknown[]) => mockNotificationCreate(...a) },
            // NIS2 delegated submit reads its assignment row then marks it
            // SUBMITTED.
            nis2GapAssignment: {
                findFirst: (...a: unknown[]) => mockNis2AssignmentFindFirst(...a),
                updateMany: async () => ({ count: 1 }),
            },
        }),
    ),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(async () => undefined),
}));

jest.mock('@/app-layer/events/test.events', () => ({
    emitTestPlanCreated: jest.fn(async () => undefined),
    emitTestPlanUpdated: jest.fn(async () => undefined),
    emitTestPlanStatusChanged: jest.fn(async () => undefined),
    emitTestRunCreated: jest.fn(async () => undefined),
    emitTestRunCompleted: jest.fn(async () => undefined),
    emitTestRunFailed: jest.fn(async () => undefined),
    emitTestEvidenceLinked: jest.fn(async () => undefined),
    emitTestEvidenceUnlinked: jest.fn(async () => undefined),
}));

jest.mock('@/app-layer/policies/common', () => ({
    assertCanRead: jest.fn(),
    assertCanWrite: jest.fn(),
    assertCanAdmin: jest.fn(),
}));

jest.mock('@/app-layer/policies/task.policies', () => ({
    assertCanReadTasks: jest.fn(),
    assertCanWriteTasks: jest.fn(),
    assertCanCommentOnTasks: jest.fn(),
}));

jest.mock('@/app-layer/policies/vendor.policies', () => ({
    assertCanReadVendors: jest.fn(),
    assertCanManageVendors: jest.fn(),
    assertCanManageVendorDocs: jest.fn(),
    assertCanRunAssessment: jest.fn(),
    assertCanApproveAssessment: jest.fn(),
}));

jest.mock('@/app-layer/policies/test.policies', () => ({
    assertCanReadTests: jest.fn(),
    assertCanManageTestPlans: jest.fn(),
    assertCanExecuteTests: jest.fn(),
    assertCanLinkTestEvidence: jest.fn(),
}));

jest.mock('@/app-layer/notifications/enqueue', () => ({
    enqueueEmail: jest.fn(),
}));

// `task.createTask` is invoked from completeTestRun on FAIL; stub so
// we don't recursively pull in the task usecase + its repo.
jest.mock('@/app-layer/usecases/task', () => ({
    createTask: jest.fn(async () => ({ id: 'task-x' })),
    addTaskComment: jest.requireActual('@/app-layer/usecases/task').addTaskComment,
}));

import { createPolicyVersion } from '@/app-layer/usecases/policy';
import { addTaskComment } from '@/app-layer/usecases/task';
import { createFinding, updateFinding } from '@/app-layer/usecases/finding';
import { createRisk, updateRisk, createRiskFromTemplate } from '@/app-layer/usecases/risk';
import {
    createVendor,
    updateVendor,
    addVendorDocument,
} from '@/app-layer/usecases/vendor';
import { createAudit, updateAudit } from '@/app-layer/usecases/audit';
import {
    createTestPlan,
    updateTestPlan,
    completeTestRun,
} from '@/app-layer/usecases/control';
import { reviewEvidence } from '@/app-layer/usecases/evidence';
import { submitAssignmentAnswers } from '@/app-layer/usecases/gap-assessment-assignment';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');
const XSS = '<script>alert(1)</script>';

beforeEach(() => {
    [
        mockPolicyGetById, mockPolicyVersionCreate, mockPolicySetCurrentVersion,
        mockPolicyUpdateStatus, mockTaskCommentAdd,
        mockFindingCreate, mockFindingUpdate, mockFindingGetById,
        mockRiskCreate, mockRiskUpdate, mockRiskTemplateGet, mockTenantFindUnique,
        mockVendorCreate, mockVendorUpdate, mockVendorGetById,
        mockVendorDocCreate,
        mockAuditCreate, mockAuditUpdate, mockAuditChecklistUpdate,
        mockTestPlanCreate, mockTestPlanUpdate, mockTestPlanUpdateNextDueAt,
        mockTestPlanGetById, mockTestRunComplete, mockTestRunGetById,
        mockEvidenceGetById, mockEvidenceUpdate, mockEvidenceAddReview,
        mockEvidenceGetLatestSubmitters, mockNotificationCreate,
        mockNis2UpsertAnswer, mockNis2AssignmentFindFirst,
    ].forEach((m) => m.mockReset());

    mockPolicyGetById.mockResolvedValue({ id: 'p1', status: 'DRAFT' });
    mockPolicyVersionCreate.mockResolvedValue({ id: 'v1', versionNumber: 1 });
    mockTenantFindUnique.mockResolvedValue({ id: 'tenant-1', maxRiskScale: 5 });
    // No prior SUBMITTED review ⇒ segregation-of-duties falls back to
    // `ownerUserId` ('owner-2'), which is not ctx.userId ('user-1').
    mockEvidenceGetLatestSubmitters.mockResolvedValue(new Map());
    mockEvidenceGetById.mockResolvedValue({
        id: 'ev-1', status: 'SUBMITTED', title: 'Q3 access review export',
        ownerUserId: 'owner-2',
    });
    mockEvidenceUpdate.mockResolvedValue({ id: 'ev-1' });
    mockEvidenceAddReview.mockResolvedValue({ id: 'rev-1' });
    mockNotificationCreate.mockResolvedValue({ id: 'n-1' });
    mockNis2AssignmentFindFirst.mockResolvedValue({
        id: 'asg-1', assessmentId: 'ass-1', assigneeUserId: 'user-1',
        questionIds: ['q-1', 'q-2'],
    });
    mockNis2UpsertAnswer.mockResolvedValue({ id: 'ans-1' });
});

// ═══════════════════════════════════════════════════════════════════
// Epic C.5 — first-wave surfaces
// ═══════════════════════════════════════════════════════════════════

describe('createPolicyVersion sanitises HTML content before persisting', () => {
    it('strips <script> from the contentText handed to the repository', async () => {
        await createPolicyVersion(ctx, 'p1', {
            contentType: 'HTML',
            contentText:
                '<h1>Policy</h1><script>alert("XSS")</script><p>OK</p>',
            changeSummary: 'init',
        });
        const data = mockPolicyVersionCreate.mock.calls[0][3];
        expect(data.contentText).toContain('<h1>Policy</h1>');
        expect(data.contentText).toContain('<p>OK</p>');
        expect(data.contentText).not.toMatch(/<script/i);
        expect(data.contentText).not.toMatch(/alert\(/);
    });

    it('strips event handlers (onerror) from HTML before persisting', async () => {
        await createPolicyVersion(ctx, 'p1', {
            contentType: 'HTML',
            contentText: '<img src="x" onerror="alert(1)" />',
            changeSummary: '',
        });
        const data = mockPolicyVersionCreate.mock.calls[0][3];
        expect(data.contentText).not.toMatch(/onerror=/i);
    });

    it('plain-text-strips MARKDOWN content (defence against embedded raw HTML)', async () => {
        await createPolicyVersion(ctx, 'p1', {
            contentType: 'MARKDOWN',
            contentText: '# Heading\n\n<script>alert(1)</script>',
            changeSummary: '',
        });
        const data = mockPolicyVersionCreate.mock.calls[0][3];
        expect(data.contentText).not.toMatch(/<script/i);
        expect(data.contentText).toContain('# Heading');
    });

    it('keeps EXTERNAL_LINK + null contentText untouched (no contentText on the wire)', async () => {
        await createPolicyVersion(ctx, 'p1', {
            contentType: 'EXTERNAL_LINK',
            externalUrl: 'https://example.com',
            changeSummary: '',
        });
        const data = mockPolicyVersionCreate.mock.calls[0][3];
        // No contentText to sanitise — passthrough.
        expect(data.contentText).toBeUndefined();
        expect(data.externalUrl).toBe('https://example.com');
    });
});

describe('addTaskComment sanitises the body before persisting', () => {
    it('strips <script> entirely', async () => {
        mockTaskCommentAdd.mockResolvedValue({ id: 'c1' });
        await addTaskComment(ctx, 'task-1', 'hi<script>alert(1)</script>tail');
        const body = mockTaskCommentAdd.mock.calls[0][3];
        expect(body).not.toMatch(/<script/i);
        expect(body).not.toMatch(/alert/);
        expect(body).toContain('hi');
        expect(body).toContain('tail');
    });

    it('an entity-encoded `&lt;script&gt;` is stripped, not reconstituted (double-unescape XSS)', async () => {
        mockTaskCommentAdd.mockResolvedValue({ id: 'c1' });
        await addTaskComment(ctx, 'task-1', '&lt;script&gt;x&lt;/script&gt;');
        const body = mockTaskCommentAdd.mock.calls[0][3];
        // The sanitiser decodes BEFORE stripping, so a pre-encoded payload is
        // removed exactly like a raw `<script>` — the stored value can never
        // roundtrip back into a live script for any downstream renderer.
        expect(body).not.toMatch(/<script/i);
    });
});

// ═══════════════════════════════════════════════════════════════════
// Epic D.2 — encrypted-field write paths
// ═══════════════════════════════════════════════════════════════════

// ── finding.ts ────────────────────────────────────────────────────

describe('finding.createFinding sanitises every free-text column', () => {
    it('strips <script> from title, description, rootCause, correctiveAction, owner', async () => {
        mockFindingCreate.mockResolvedValue({ id: 'f1', title: 'X', status: 'OPEN' });
        await createFinding(ctx, {
            severity: 'HIGH',
            type: 'NONCONFORMITY',
            title: `Title ${XSS}`,
            description: `Desc ${XSS}`,
            rootCause: `Root ${XSS}`,
            correctiveAction: `Fix ${XSS}`,
            owner: `Alice ${XSS}`,
        });
        const data = mockFindingCreate.mock.calls[0][2];
        for (const k of ['title', 'description', 'rootCause', 'correctiveAction', 'owner']) {
            expect(data[k]).not.toMatch(/<script/);
        }
        // Sanity — clean text survives.
        expect(data.title).toContain('Title');
    });
});

describe('finding.updateFinding sanitises only fields actually being written', () => {
    it('sanitises verificationNotes when provided; leaves omitted fields as undefined', async () => {
        mockFindingGetById.mockResolvedValue({ id: 'f1', status: 'OPEN' });
        mockFindingUpdate.mockResolvedValue({ id: 'f1', status: 'OPEN' });
        await updateFinding(ctx, 'f1', { verificationNotes: `V ${XSS}` });
        const data = mockFindingUpdate.mock.calls[0][3];
        expect(data.verificationNotes).not.toMatch(/<script/);
        expect(data.title).toBeUndefined();
        expect(data.description).toBeUndefined();
    });
});

// ── risk.ts ───────────────────────────────────────────────────────

describe('risk.createRisk sanitises every encrypted + free-text column', () => {
    it('strips <script> from title, threat, vulnerability, treatmentNotes, treatmentOwner, description, category', async () => {
        mockRiskCreate.mockResolvedValue({ id: 'r1', title: 'X' });
        await createRisk(ctx, {
            title: `T ${XSS}`,
            description: `D ${XSS}`,
            category: `Cat ${XSS}`,
            threat: `Threat ${XSS}`,
            vulnerability: `Vuln ${XSS}`,
            treatmentOwner: `Owner ${XSS}`,
            treatmentNotes: `Notes ${XSS}`,
        });
        const data = mockRiskCreate.mock.calls[0][2];
        for (const k of [
            'title',
            'description',
            'category',
            'threat',
            'vulnerability',
            'treatmentOwner',
            'treatmentNotes',
        ]) {
            expect(data[k]).not.toMatch(/<script/);
        }
    });
});

describe('risk.createRiskFromTemplate sanitises the merged value', () => {
    it('sanitises overrides + the template fallback path', async () => {
        mockRiskTemplateGet.mockResolvedValue({
            id: 'tpl-1',
            title: `Template ${XSS}`,
            description: 'pristine',
            category: 'Ops',
            defaultLikelihood: 3,
            defaultImpact: 3,
        });
        mockRiskCreate.mockResolvedValue({ id: 'r1', title: 'X' });
        await createRiskFromTemplate(ctx, 'tpl-1', { description: `Custom ${XSS}` });
        const data = mockRiskCreate.mock.calls[0][2];
        expect(data.title).not.toMatch(/<script/); // from template
        expect(data.description).not.toMatch(/<script/); // from override
    });
});

describe('risk.updateRisk sanitises optional fields only when provided', () => {
    it('sanitises threat when provided; leaves untouched columns undefined', async () => {
        mockRiskUpdate.mockResolvedValue({ id: 'r1' });
        await updateRisk(ctx, 'r1', { threat: `bad ${XSS}` });
        const data = mockRiskUpdate.mock.calls[0][3];
        expect(data.threat).not.toMatch(/<script/);
        expect(data.title).toBeUndefined();
    });
});

// ── vendor.ts ─────────────────────────────────────────────────────

describe('vendor.createVendor sanitises every free-text column + tags', () => {
    it('strips <script> from name, description, country, tags[]', async () => {
        mockVendorCreate.mockResolvedValue({
            id: 'v1', name: 'X', status: 'ACTIVE', criticality: 'LOW',
        });
        await createVendor(ctx, {
            name: `Acme ${XSS}`,
            description: `desc ${XSS}`,
            country: `US ${XSS}`,
            tags: [`prod ${XSS}`, 'safe-tag'],
        });
        const data = mockVendorCreate.mock.calls[0][2];
        expect(data.name).not.toMatch(/<script/);
        expect(data.description).not.toMatch(/<script/);
        expect(data.country).not.toMatch(/<script/);
        expect(data.tags[0]).not.toMatch(/<script/);
        expect(data.tags[1]).toBe('safe-tag');
    });
});

describe('vendor.updateVendor sanitises known free-text patch keys', () => {
    it('strips <script> from description; enums and ids pass through untouched', async () => {
        mockVendorUpdate.mockResolvedValue({ id: 'v1', name: 'X' });
        mockVendorGetById.mockResolvedValue({ status: 'ACTIVE' });
        await updateVendor(ctx, 'v1', {
            description: `bad ${XSS}`,
            criticality: 'HIGH', // enum — must NOT be sanitised
            ownerUserId: 'user-9', // FK id — must NOT be sanitised
            tags: ['t1', `t2 ${XSS}`],
        });
        const data = mockVendorUpdate.mock.calls[0][3];
        expect(data.description).not.toMatch(/<script/);
        expect(data.criticality).toBe('HIGH');
        expect(data.ownerUserId).toBe('user-9');
        expect(data.tags[1]).not.toMatch(/<script/);
    });
});

describe('vendor.addVendorDocument sanitises title, externalUrl, notes', () => {
    it('strips <script> from notes (encrypted) and title', async () => {
        mockVendorDocCreate.mockResolvedValue({
            id: 'd1', vendorId: 'v1', type: 'POLICY', title: 'X',
        });
        await addVendorDocument(ctx, 'v1', {
            type: 'POLICY',
            title: `T ${XSS}`,
            notes: `Notes ${XSS}`,
            externalUrl: 'https://example.com',
        });
        const data = mockVendorDocCreate.mock.calls[0][3];
        expect(data.title).not.toMatch(/<script/);
        expect(data.notes).not.toMatch(/<script/);
    });
});

// ── audit.ts ──────────────────────────────────────────────────────

describe('audit.createAudit sanitises every encrypted free-text column', () => {
    it('strips <script> from title, scope, criteria, auditors, auditees, departments', async () => {
        mockAuditCreate.mockResolvedValue({ id: 'a1', title: 'X' });
        await createAudit(ctx, {
            title: `T ${XSS}`,
            scope: `S ${XSS}`,
            criteria: `C ${XSS}`,
            auditors: `Alice ${XSS}`,
            auditees: `Bob ${XSS}`,
            departments: `IT ${XSS}`,
        });
        const data = mockAuditCreate.mock.calls[0][2];
        for (const k of [
            'title',
            'auditScope',
            'criteria',
            'auditors',
            'auditees',
            'departments',
        ]) {
            expect(data[k]).not.toMatch(/<script/);
        }
    });
});

describe('audit.updateAudit sanitises top-level fields and per-checklist notes', () => {
    it('strips <script> from updated criteria + checklist notes; enum result untouched', async () => {
        mockAuditUpdate.mockResolvedValue({ id: 'a1' });
        mockAuditChecklistUpdate.mockResolvedValue({ id: 'ci-1' });
        await updateAudit(ctx, 'a1', {
            criteria: `C ${XSS}`,
            checklistUpdates: [
                { id: 'ci-1', result: 'PASS', notes: `Item ${XSS}` },
                { id: 'ci-2', result: 'FAIL' }, // no notes → no sanitisation
            ],
        });
        const top = mockAuditUpdate.mock.calls[0][3];
        expect(top.criteria).not.toMatch(/<script/);
        // updateChecklistItem gained an `auditId` 4th positional arg, so the
        // data payload is now the 5th (index [4]).
        const item = mockAuditChecklistUpdate.mock.calls[0][4];
        expect(item.notes).not.toMatch(/<script/);
        expect(item.result).toBe('PASS');
        const item2 = mockAuditChecklistUpdate.mock.calls[1][4];
        expect(item2.notes).toBeUndefined();
        expect(item2.result).toBe('FAIL');
    });
});

// ── control-test.ts ───────────────────────────────────────────────

describe('controlTest.createTestPlan sanitises name, description, and steps[]', () => {
    it('strips <script> from name + description + every step instruction/expectedOutput', async () => {
        mockTestPlanCreate.mockResolvedValue({
            id: 'plan-1', name: 'X', controlId: 'c1',
        });
        mockTestPlanUpdateNextDueAt.mockResolvedValue(undefined);
        await createTestPlan(ctx, 'c1', {
            name: `Plan ${XSS}`,
            description: `Desc ${XSS}`,
            // PR-CC — `method` is no longer a create input; it's derived from
            // automationType. Dropped here, not replaced.
            frequency: 'MONTHLY',
            steps: [
                { instruction: `do thing ${XSS}`, expectedOutput: `output ${XSS}` },
                { instruction: 'safe', expectedOutput: null },
            ],
        });
        const data = mockTestPlanCreate.mock.calls[0][3];
        expect(data.name).not.toMatch(/<script/);
        expect(data.description).not.toMatch(/<script/);
        expect(data.steps[0].instruction).not.toMatch(/<script/);
        expect(data.steps[0].expectedOutput).not.toMatch(/<script/);
        expect(data.steps[1].expectedOutput).toBeNull();
    });
});

describe('controlTest.updateTestPlan sanitises only the provided fields', () => {
    it('sanitises description on update; leaves untouched columns undefined', async () => {
        mockTestPlanGetById.mockResolvedValue({
            id: 'plan-1', status: 'ACTIVE', frequency: 'MONTHLY',
        });
        mockTestPlanUpdate.mockResolvedValue({ id: 'plan-1' });
        await updateTestPlan(ctx, 'plan-1', { description: `bad ${XSS}` });
        const patch = mockTestPlanUpdate.mock.calls[0][3];
        expect(patch.description).not.toMatch(/<script/);
        expect(patch.name).toBeUndefined();
    });
});

describe('controlTest.completeTestRun sanitises notes + findingSummary', () => {
    it('strips <script> from both encrypted columns', async () => {
        mockTestRunGetById.mockResolvedValue({
            id: 'run-1', status: 'IN_PROGRESS', testPlanId: 'plan-1', controlId: 'c1',
            testPlan: {
                id: 'plan-1', name: 'plan', frequency: 'MONTHLY', ownerUserId: null,
            },
        });
        mockTestRunComplete.mockResolvedValue({ id: 'run-1' });
        mockTestPlanUpdateNextDueAt.mockResolvedValue(undefined);
        await completeTestRun(ctx, 'run-1', {
            result: 'PASS',
            notes: `notes ${XSS}`,
            findingSummary: `summary ${XSS}`,
        });
        const data = mockTestRunComplete.mock.calls[0][3];
        expect(data.notes).not.toMatch(/<script/);
        expect(data.findingSummary).not.toMatch(/<script/);
    });
});

// ── evidence.ts — EvidenceReview.comment (Epic D.2 tail) ──────────

describe('evidence.reviewEvidence sanitises the reviewer comment', () => {
    it('strips <script> from the comment persisted to the encrypted EvidenceReview column', async () => {
        await reviewEvidence(ctx, 'ev-1', {
            action: 'REJECTED',
            comment: `Screenshot is illegible ${XSS}`,
        });
        // addReview(db, ctx, evidenceId, action, comment) — 5th arg.
        const comment = mockEvidenceAddReview.mock.calls[0][4];
        expect(comment).not.toMatch(/<script/);
        expect(comment).toContain('Screenshot is illegible');
    });

    it('strips <script> from the owner notification built from the same comment', async () => {
        await reviewEvidence(ctx, 'ev-1', {
            action: 'REJECTED',
            comment: `Redo this ${XSS}`,
        });
        const data = mockNotificationCreate.mock.calls[0][0].data;
        expect(data.message).not.toMatch(/<script/);
    });

    it('rejects a rejection reason that is nothing but markup', async () => {
        // The reason is required; sanitising BEFORE the emptiness check is what
        // stops a pure-markup string from satisfying it and landing as ''.
        await expect(
            reviewEvidence(ctx, 'ev-1', { action: 'REJECTED', comment: XSS }),
        ).rejects.toThrow(/rejection reason is required/i);
        expect(mockEvidenceAddReview).not.toHaveBeenCalled();
    });

    it('preserves the three-state contract — an omitted comment stays undefined', async () => {
        await reviewEvidence(ctx, 'ev-1', { action: 'APPROVED' });
        expect(mockEvidenceAddReview.mock.calls[0][4]).toBeUndefined();
    });
});

// ── gap-assessment-assignment.ts — Nis2SelfAssessmentAnswer.note ──

describe('nis2.submitAssignmentAnswers sanitises the answer note', () => {
    it('strips <script> from every note handed to the repository', async () => {
        await submitAssignmentAnswers(ctx, 'asg-1', [
            { questionId: 'q-1', answer: 'PARTIALLY', note: `MFA on admins only ${XSS}` },
            { questionId: 'q-2', answer: 'YES', note: `Signed off ${XSS}` },
        ]);
        const first = mockNis2UpsertAnswer.mock.calls[0][2];
        const second = mockNis2UpsertAnswer.mock.calls[1][2];
        expect(first.note).not.toMatch(/<script/);
        expect(first.note).toContain('MFA on admins only');
        expect(second.note).not.toMatch(/<script/);
    });

    it('normalises an absent or blank note to null (no empty-string rows)', async () => {
        await submitAssignmentAnswers(ctx, 'asg-1', [
            { questionId: 'q-1', answer: 'NA' },
            { questionId: 'q-2', answer: 'NO', note: '   ' },
        ]);
        expect(mockNis2UpsertAnswer.mock.calls[0][2].note).toBeNull();
        expect(mockNis2UpsertAnswer.mock.calls[1][2].note).toBeNull();
    });
});
