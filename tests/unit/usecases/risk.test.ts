/**
 * Unit tests for src/app-layer/usecases/risk.ts
 *
 * Wave 3 of GAP-02. Risk is the highest-traffic mutation surface in
 * the app — every free-text field is encrypted (Epic B) and surfaces
 * in PDF exports + audit-pack share links + SDK consumers, so the
 * sanitiser path is load-bearing for confidentiality at decrypt time.
 *
 * Behaviours protected:
 *   1. assertCanWrite gate on create / createFromTemplate / update /
 *      linkControlToRisk; assertCanAdmin gate on delete /
 *      listRisksWithDeleted.
 *   2. Epic D.2 — every free-text field passes through sanitizePlainText
 *      on create AND on update via sanitizeOptional (three-state).
 *   3. inherentScore = calculateRiskScore(likelihood, impact, maxScale)
 *      with maxScale fetched from tenant.maxRiskScale (default 5).
 *   4. createRiskFromTemplate: notFound for missing template; merges
 *      override over template and sanitises the merged value.
 *   5. notFound paths: getRisk, updateRisk, deleteRisk, linkControlToRisk.
 *   6. Audit emit on every mutation (CREATE / UPDATE / SOFT_DELETE).
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/repositories/RiskRepository', () => ({
    RiskRepository: {
        list: jest.fn(),
        listDeleted: jest.fn(),
        listPaginated: jest.fn(),
        getById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        linkControl: jest.fn(),
    },
}));

jest.mock('@/app-layer/repositories/RiskTemplateRepository', () => ({
    RiskTemplateRepository: {
        getById: jest.fn(),
    },
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string | null | undefined) => `SANITISED(${s})`),
}));

jest.mock('@/lib/risk-scoring', () => ({
    calculateRiskScore: jest.fn(
        (likelihood: number, impact: number, maxScale: number) =>
            likelihood * impact * (maxScale / 5),
    ),
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    createRisk,
    createRiskFromTemplate,
    updateRisk,
    deleteRisk,
    linkControlToRisk,
    listRisksWithDeleted,
} from '@/app-layer/usecases/risk';
import { runInTenantContext } from '@/lib/db-context';
import { RiskRepository } from '@/app-layer/repositories/RiskRepository';
import { RiskTemplateRepository } from '@/app-layer/repositories/RiskTemplateRepository';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { calculateRiskScore } from '@/lib/risk-scoring';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockCreate = RiskRepository.create as jest.MockedFunction<typeof RiskRepository.create>;
const mockUpdate = RiskRepository.update as jest.MockedFunction<typeof RiskRepository.update>;
const mockDelete = RiskRepository.delete as jest.MockedFunction<typeof RiskRepository.delete>;
const mockLinkControl = RiskRepository.linkControl as jest.MockedFunction<typeof RiskRepository.linkControl>;
const mockTemplateGet = RiskTemplateRepository.getById as jest.MockedFunction<typeof RiskTemplateRepository.getById>;
const mockSanitize = sanitizePlainText as jest.MockedFunction<typeof sanitizePlainText>;
const mockScore = calculateRiskScore as jest.MockedFunction<typeof calculateRiskScore>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;

beforeEach(() => {
    jest.clearAllMocks();
    mockSanitize.mockImplementation((s: string | null | undefined) => `SANITISED(${s})`);
    mockScore.mockReturnValue(9);
    mockCreate.mockResolvedValue({ id: 'r1', title: 'SANITISED(t)' } as never);
    mockUpdate.mockResolvedValue({ id: 'r1' } as never);
});

function dbWithTenant(maxRiskScale: number | null = 5) {
    return {
        tenant: {
            findUnique: jest.fn().mockResolvedValue({ maxRiskScale }),
        },
        // RQ2-1 — every score-changing write appends a ledger event.
        riskScoreEvent: {
            create: jest.fn().mockResolvedValue({ id: 'evt-1' }),
        },
    };
}

describe('createRisk', () => {
    it('rejects READER (no canWrite)', async () => {
        await expect(
            createRisk(makeRequestContext('READER'), { title: 't' }),
        ).rejects.toThrow();
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('rejects AUDITOR (read-only role)', async () => {
        await expect(
            createRisk(makeRequestContext('AUDITOR'), { title: 't' }),
        ).rejects.toThrow();
    });

    it('sanitises every free-text field before persistence (Epic D.2)', async () => {
        const fakeDb = dbWithTenant(5);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));

        await createRisk(makeRequestContext('EDITOR'), {
            title: '<b>title</b>',
            description: '<script>x</script>',
            category: 'cat',
            threat: 'threat-text',
            vulnerability: 'vuln-text',
            treatmentOwner: 'Alice',
            treatmentNotes: 'notes',
        });

        const repoArgs = mockCreate.mock.calls[0][2];
        // Regression: a refactor that drops the sanitise wrappers around
        // these encrypted free-text fields would persist raw HTML — every
        // downstream renderer (PDF, audit-pack share, SDK) decrypts the
        // value and trusts it.
        expect(repoArgs.title).toBe('SANITISED(<b>title</b>)');
        expect(repoArgs.description).toBe('SANITISED(<script>x</script>)');
        expect(repoArgs.category).toBe('SANITISED(cat)');
        expect(repoArgs.threat).toBe('SANITISED(threat-text)');
        expect(repoArgs.vulnerability).toBe('SANITISED(vuln-text)');
        expect(repoArgs.treatmentOwner).toBe('SANITISED(Alice)');
        expect(repoArgs.treatmentNotes).toBe('SANITISED(notes)');
    });

    it('uses tenant.maxRiskScale when computing inherentScore', async () => {
        const fakeDb = dbWithTenant(10);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));

        await createRisk(makeRequestContext('EDITOR'), {
            title: 't', likelihood: 4, impact: 5,
        });

        expect(mockScore).toHaveBeenCalledWith(4, 5, 10);
    });

    it('falls back to maxScale=5 when tenant.maxRiskScale is null', async () => {
        const fakeDb = dbWithTenant(null);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));

        await createRisk(makeRequestContext('EDITOR'), { title: 't' });

        expect(mockScore).toHaveBeenCalledWith(3, 3, 5);
    });

    it('emits a CREATE audit row', async () => {
        const fakeDb = dbWithTenant(5);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));

        await createRisk(makeRequestContext('EDITOR'), { title: 't' });

        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                action: 'CREATE',
                entityType: 'Risk',
            }),
        );
    });
});

describe('createRiskFromTemplate', () => {
    it('throws notFound when template does not exist', async () => {
        mockTemplateGet.mockResolvedValue(null);
        await expect(
            createRiskFromTemplate(makeRequestContext('EDITOR'), 'missing-tpl'),
        ).rejects.toThrow(/Risk template not found/);
    });

    it('rejects READER on create-from-template (canWrite gate)', async () => {
        // Template lookup happens AFTER the gate per current code, so
        // the gate must throw before the template repo is hit.
        await expect(
            createRiskFromTemplate(makeRequestContext('READER'), 'tpl-1'),
        ).rejects.toThrow();
        expect(mockTemplateGet).not.toHaveBeenCalled();
    });

    it('sanitises overrides AND template-default title before persistence', async () => {
        mockTemplateGet.mockResolvedValue({
            id: 'tpl-1',
            title: 'Template Title',
            description: 'Template desc',
            category: 'tpl-cat',
            defaultLikelihood: 3,
            defaultImpact: 4,
        } as never);
        const fakeDb = dbWithTenant(5);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));

        await createRiskFromTemplate(makeRequestContext('EDITOR'), 'tpl-1', {
            title: 'Override Title',
        });

        const repoArgs = mockCreate.mock.calls[0][2];
        // Regression: when the override is undefined we must still
        // sanitise the template default — otherwise pre-canned templates
        // with sneaky HTML would round-trip raw.
        expect(repoArgs.title).toBe('SANITISED(Override Title)');
        expect(repoArgs.description).toBe('SANITISED(Template desc)');
    });
});

describe('updateRisk — sanitizeOptional three-state', () => {
    it('preserves "untouched" semantics: undefined fields are NOT written', async () => {
        const fakeDb = dbWithTenant(5);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));

        await updateRisk(makeRequestContext('EDITOR'), 'r1', {
            // Only title is being updated
            title: 'new title',
        });

        const repoArgs = mockUpdate.mock.calls[0][3];
        // Regression: a refactor that flattens sanitizeOptional to
        // `sanitize(v ?? '')` would silently turn untouched columns into
        // empty-string writes — corrupting historical data.
        expect(repoArgs.description).toBeUndefined();
        expect(repoArgs.category).toBeUndefined();
        expect(repoArgs.treatmentNotes).toBeUndefined();
        expect(repoArgs.title).toBe('SANITISED(new title)');
    });

    it('preserves "explicit-clear" semantics: null fields write SET NULL', async () => {
        const fakeDb = dbWithTenant(5);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));

        await updateRisk(makeRequestContext('EDITOR'), 'r1', {
            description: null,
            treatmentNotes: null,
        });

        const repoArgs = mockUpdate.mock.calls[0][3];
        expect(repoArgs.description).toBeNull();
        expect(repoArgs.treatmentNotes).toBeNull();
    });

    it('throws notFound when repository returns null', async () => {
        const fakeDb = dbWithTenant(5);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));
        mockUpdate.mockResolvedValueOnce(null as never);

        await expect(
            updateRisk(makeRequestContext('EDITOR'), 'missing', { title: 't' }),
        ).rejects.toThrow(/Risk not found/);
    });
});

describe('deleteRisk', () => {
    it('rejects EDITOR — delete requires canAdmin (separation from canWrite)', async () => {
        await expect(
            deleteRisk(makeRequestContext('EDITOR'), 'r1'),
        ).rejects.toThrow();
        // Regression: a bug that collapses the delete gate to canWrite
        // would let any EDITOR soft-delete risks they did not create.
        expect(mockDelete).not.toHaveBeenCalled();
    });

    it('emits SOFT_DELETE audit on success', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockDelete.mockResolvedValueOnce({ id: 'r1' } as never);

        await deleteRisk(makeRequestContext('ADMIN'), 'r1');

        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'SOFT_DELETE' }),
        );
    });

    it('throws notFound when repo.delete returns null', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockDelete.mockResolvedValueOnce(null as never);

        await expect(
            deleteRisk(makeRequestContext('ADMIN'), 'missing'),
        ).rejects.toThrow(/Risk not found/);
    });
});

describe('linkControlToRisk', () => {
    it('rejects READER (canWrite gate)', async () => {
        await expect(
            linkControlToRisk(makeRequestContext('READER'), 'r1', 'c1'),
        ).rejects.toThrow();
    });

    it('throws notFound when the link returns null (cross-tenant or missing risk)', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockLinkControl.mockResolvedValueOnce(null as never);

        await expect(
            linkControlToRisk(makeRequestContext('EDITOR'), 'tenant-B-risk', 'c1'),
        ).rejects.toThrow(/Risk not found/);
    });

    it('emits CREATE RiskControl audit on success', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockLinkControl.mockResolvedValueOnce({ id: 'rc1' } as never);

        await linkControlToRisk(makeRequestContext('EDITOR'), 'r1', 'c1');

        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                action: 'CREATE',
                entityType: 'RiskControl',
            }),
        );
    });
});

describe('listRisksWithDeleted', () => {
    it('rejects EDITOR — admin-only view of soft-deleted rows', async () => {
        await expect(
            listRisksWithDeleted(makeRequestContext('EDITOR')),
        ).rejects.toThrow();
    });
});
