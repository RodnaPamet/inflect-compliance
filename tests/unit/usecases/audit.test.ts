/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Unit tests for src/app-layer/usecases/audit.ts
 *
 * Wave 3 of GAP-02. Audit lifecycle is the surface auditors actually
 * see — title / scope / criteria / auditors / auditees / departments
 * are encrypted at rest (Epic B) AND surface in PDFs + audit-pack
 * share links + JSON exports. A sanitiser regression here means
 * stored XSS in the very deliverable that compliance teams hand to
 * external auditors.
 *
 * Behaviours protected:
 *   1. assertCanWrite gate on create / update.
 *   2. Sanitisation of title (always) + scope/criteria/auditors/
 *      auditees/departments (when supplied) on create AND update.
 *   3. status='PLANNED' default on create.
 *   4. generateChecklist=true derives items from the audit's selected
 *      framework's requirements; with no framework it falls back to
 *      control-derived items.
 *   5. updateAudit: notFound on missing audit; checklistUpdates
 *      sanitises notes per element (encrypted column).
 *   6. CREATE / UPDATE audit emit.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/repositories/AuditRepository', () => ({
    AuditRepository: {
        list: jest.fn(),
        getById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        createChecklistItem: jest.fn(),
        updateChecklistItem: jest.fn(),
    },
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string | null | undefined) => `SANITISED(${s})`),
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

// feat/audit-cycle-unify — the FAIL → Finding + remediation-Task cascade
// delegates to the canonical createFinding / createTask usecases. Mock
// them so the cascade can be asserted without their full dependency trees.
jest.mock('@/app-layer/usecases/finding', () => ({
    createFinding: jest.fn().mockResolvedValue({ id: 'f1' }),
}));
jest.mock('@/app-layer/usecases/task', () => ({
    createTask: jest.fn().mockResolvedValue({ id: 't1', key: 'TASK-1' }),
}));

import {
    createAudit,
    updateAudit,
} from '@/app-layer/usecases/audit';
import { runInTenantContext } from '@/lib/db-context';
import { AuditRepository } from '@/app-layer/repositories/AuditRepository';
import { createFinding } from '@/app-layer/usecases/finding';
import { createTask } from '@/app-layer/usecases/task';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockCreate = AuditRepository.create as jest.MockedFunction<typeof AuditRepository.create>;
const mockUpdate = AuditRepository.update as jest.MockedFunction<typeof AuditRepository.update>;
const mockCreateItem = AuditRepository.createChecklistItem as jest.MockedFunction<typeof AuditRepository.createChecklistItem>;
const mockUpdateItem = AuditRepository.updateChecklistItem as jest.MockedFunction<typeof AuditRepository.updateChecklistItem>;
const mockCreateFinding = createFinding as jest.MockedFunction<typeof createFinding>;
const mockCreateTask = createTask as jest.MockedFunction<typeof createTask>;
const mockSanitize = sanitizePlainText as jest.MockedFunction<typeof sanitizePlainText>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;

beforeEach(() => {
    jest.clearAllMocks();
    mockSanitize.mockImplementation((s: string | null | undefined) => `SANITISED(${s})`);
    mockCreate.mockResolvedValue({ id: 'a1', title: 'SANITISED(Q4 audit)' } as never);
    mockUpdate.mockResolvedValue({ id: 'a1' } as never);
    mockCreateFinding.mockResolvedValue({ id: 'f1' } as never);
    mockCreateTask.mockResolvedValue({ id: 't1', key: 'TASK-1' } as never);
});

// feat/audit-cycle-unify — update-path fake db carrying the checklist
// prefetch (transition detection) + the finding idempotency lookup.
function fakeUpdateDb(opts: {
    priorItems?: { id: string; prompt: string; result: string; auditId: string }[];
    existingFinding?: { id: string } | null;
} = {}) {
    return {
        auditChecklistItem: {
            findMany: jest.fn().mockResolvedValue(opts.priorItems ?? []),
        },
        finding: {
            findFirst: jest.fn().mockResolvedValue(opts.existingFinding ?? null),
        },
        auditCycle: {
            findFirst: jest.fn().mockResolvedValue({ id: 'cyc1' }),
        },
    };
}

function fakeDbWithControls(controls: { id: string; name: string; annexId?: string }[] = []) {
    return {
        control: { findMany: jest.fn().mockResolvedValue(controls) },
    };
}

// For the framework-derived checklist path: the audit has a frameworkKey, so
// createAudit resolves the Framework then reads its FrameworkRequirement rows.
function fakeDbWithFramework(requirements: { code: string; title: string | null }[]) {
    return {
        framework: { findFirst: jest.fn().mockResolvedValue({ id: 'fw1' }) },
        frameworkRequirement: { findMany: jest.fn().mockResolvedValue(requirements) },
        control: { findMany: jest.fn().mockResolvedValue([]) },
    };
}

describe('createAudit', () => {
    it('rejects READER (canWrite gate)', async () => {
        await expect(
            createAudit(makeRequestContext('READER'), { title: 'Q4' }),
        ).rejects.toThrow();
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('rejects AUDITOR — auditors view but cannot create audits', async () => {
        await expect(
            createAudit(makeRequestContext('AUDITOR'), { title: 'Q4' }),
        ).rejects.toThrow();
    });

    it('sanitises title + every encrypted free-text field', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDbWithControls() as never));

        await createAudit(makeRequestContext('EDITOR'), {
            title: '<b>Q4</b>',
            scope: '<script>alert(1)</script>',
            criteria: 'criteria-text',
            auditors: 'Alice;Bob',
            auditees: 'Carol',
            departments: 'Eng;Ops',
        });

        const repoArgs = mockCreate.mock.calls[0][2];
        // Regression: a refactor that drops sanitiser wrappers around
        // these encrypted columns would persist raw HTML — surfacing
        // as stored XSS in the PDF / audit-pack that external auditors
        // open.
        expect(repoArgs.title).toBe('SANITISED(<b>Q4</b>)');
        expect(repoArgs.auditScope).toBe('SANITISED(<script>alert(1)</script>)');
        expect(repoArgs.criteria).toBe('SANITISED(criteria-text)');
        expect(repoArgs.auditors).toBe('SANITISED(Alice;Bob)');
        expect(repoArgs.auditees).toBe('SANITISED(Carol)');
        expect(repoArgs.departments).toBe('SANITISED(Eng;Ops)');
    });

    it('persists status=PLANNED by default', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDbWithControls() as never));

        await createAudit(makeRequestContext('EDITOR'), { title: 'Q4' });

        expect(mockCreate.mock.calls[0][2].status).toBe('PLANNED');
    });

    it('generateChecklist=true with a framework derives items from that framework\'s requirements', async () => {
        const requirements = Array.from({ length: 8 }, (_, i) => ({
            code: `R.${i}`, title: `Req ${i}`,
        }));
        // The created audit carries the selected frameworkKey.
        mockCreate.mockResolvedValueOnce({ id: 'a1', title: 'SANITISED(Q4)', frameworkKey: 'OWASP' } as never);
        const db = fakeDbWithFramework(requirements);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await createAudit(makeRequestContext('EDITOR'), {
            title: 'Q4',
            frameworkKey: 'OWASP',
            generateChecklist: true,
        });

        // One checklist item per framework requirement — NOT a hardcoded
        // ISO 27001 list. The control fallback is not used when the framework
        // yields requirements.
        expect(mockCreateItem).toHaveBeenCalledTimes(8);
        expect(db.frameworkRequirement.findMany).toHaveBeenCalled();
        expect(db.control.findMany).not.toHaveBeenCalled();
    });

    it('generateChecklist=true with NO framework falls back to control-derived items', async () => {
        const controls = Array.from({ length: 5 }, (_, i) => ({
            id: `c${i}`, name: `Control ${i}`, annexId: `A.${i}`,
        }));
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn(fakeDbWithControls(controls) as never),
        );

        await createAudit(makeRequestContext('EDITOR'), {
            title: 'Q4',
            generateChecklist: true,
        });

        // No framework → fallback seeds up to 15 items from the tenant's
        // controls (5 here).
        expect(mockCreateItem).toHaveBeenCalledTimes(5);
    });

    it('generateChecklist=false (default) creates NO checklist items', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDbWithControls() as never));

        await createAudit(makeRequestContext('EDITOR'), { title: 'Q4' });

        expect(mockCreateItem).not.toHaveBeenCalled();
    });

    it('emits CREATE Audit audit', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDbWithControls() as never));

        await createAudit(makeRequestContext('EDITOR'), { title: 'Q4' });

        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                action: 'CREATE',
                entityType: 'Audit',
            }),
        );
    });
});

describe('updateAudit', () => {
    it('throws notFound on missing audit (cross-tenant id)', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockUpdate.mockResolvedValueOnce(null as never);

        await expect(
            updateAudit(makeRequestContext('EDITOR'), 'missing', { title: 'x' }),
        ).rejects.toThrow(/Audit not found/);
    });

    it('rejects READER on update (canWrite)', async () => {
        await expect(
            updateAudit(makeRequestContext('READER'), 'a1', { title: 'x' }),
        ).rejects.toThrow();
    });

    it('preserves "untouched" semantics on undefined fields (no SET on update)', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));

        await updateAudit(makeRequestContext('EDITOR'), 'a1', { title: 'new' });

        const repoArgs = mockUpdate.mock.calls[0][3];
        // Regression: a flatten that turned `sanitizeOptional` into
        // `sanitize(v ?? '')` would silently SET '' on every column — a
        // single-field PATCH would wipe encrypted state across the row.
        expect(repoArgs.title).toBe('SANITISED(new)');
        expect(repoArgs.auditScope).toBeUndefined();
        expect(repoArgs.criteria).toBeUndefined();
        expect(repoArgs.auditors).toBeUndefined();
    });

    it('sanitises notes per checklistUpdates element (encrypted column)', async () => {
        // Prior state: neither item was FAIL, and i2's FAIL transition
        // finds no existing finding — but we only assert sanitisation here.
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn(fakeUpdateDb({
                priorItems: [
                    { id: 'i1', prompt: 'P1', result: 'NOT_TESTED', auditId: 'a1' },
                    { id: 'i2', prompt: 'P2', result: 'NOT_TESTED', auditId: 'a1' },
                ],
            }) as never),
        );

        await updateAudit(makeRequestContext('EDITOR'), 'a1', {
            title: 'x',
            checklistUpdates: [
                { id: 'i1', result: 'PASS', notes: '<script>x</script>' },
                { id: 'i2', result: 'FAIL', notes: 'plain note' },
            ],
        });

        // Each item gets sanitised individually — the per-element
        // wrapper protects evidence trails on PDF export. The data arg is
        // the 5th positional (auditId was inserted at index [3]).
        expect(mockUpdateItem).toHaveBeenCalledTimes(2);
        const firstNoteArg = (mockUpdateItem.mock.calls[0] as any[])[4];
        expect(firstNoteArg.notes).toBe('SANITISED(<script>x</script>)');
        const secondNoteArg = (mockUpdateItem.mock.calls[1] as any[])[4];
        expect(secondNoteArg.notes).toBe('SANITISED(plain note)');
        // result is enum-shaped — must NOT be sanitised (would mangle the value).
        expect(firstNoteArg.result).toBe('PASS');
    });

    it('emits UPDATE Audit audit', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));

        await updateAudit(makeRequestContext('EDITOR'), 'a1', { title: 'x' });

        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                action: 'UPDATE',
                entityType: 'Audit',
            }),
        );
    });

    // ── feat/audit-cycle-unify — checklist FAIL → Finding + Task cascade ──
    describe('checklist FAIL cascade', () => {
        it('a NOT_TESTED → FAIL transition spawns one Finding + one remediation Task', async () => {
            mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
                fn(fakeUpdateDb({
                    priorItems: [{ id: 'i1', prompt: 'Verify A.5.1 access policy', result: 'NOT_TESTED', auditId: 'a1' }],
                    existingFinding: null,
                }) as never),
            );

            await updateAudit(makeRequestContext('EDITOR'), 'a1', {
                checklistUpdates: [{ id: 'i1', result: 'FAIL', notes: 'no policy on file' }],
            });

            expect(mockCreateFinding).toHaveBeenCalledTimes(1);
            const findingArg = mockCreateFinding.mock.calls[0][1];
            expect(findingArg).toMatchObject({
                auditId: 'a1',
                type: 'NONCONFORMITY',
                severity: 'MEDIUM',
                sourceKind: 'AUDIT_CHECKLIST',
                sourceRef: 'i1',
            });

            expect(mockCreateTask).toHaveBeenCalledTimes(1);
            const taskArg = mockCreateTask.mock.calls[0][1];
            expect(taskArg).toMatchObject({ type: 'AUDIT_FINDING' });
            expect((taskArg.metadataJson as Record<string, unknown>).findingId).toBe('f1');
        });

        it('is idempotent — no duplicate Finding when one already exists for the item (PASS→FAIL re-toggle)', async () => {
            mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
                fn(fakeUpdateDb({
                    priorItems: [{ id: 'i1', prompt: 'P', result: 'PASS', auditId: 'a1' }],
                    existingFinding: { id: 'existing-f' },
                }) as never),
            );

            await updateAudit(makeRequestContext('EDITOR'), 'a1', {
                checklistUpdates: [{ id: 'i1', result: 'FAIL' }],
            });

            expect(mockCreateFinding).not.toHaveBeenCalled();
            expect(mockCreateTask).not.toHaveBeenCalled();
        });

        it('does NOT cascade when the item was already FAIL (no real transition)', async () => {
            mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
                fn(fakeUpdateDb({
                    priorItems: [{ id: 'i1', prompt: 'P', result: 'FAIL', auditId: 'a1' }],
                    existingFinding: null,
                }) as never),
            );

            await updateAudit(makeRequestContext('EDITOR'), 'a1', {
                checklistUpdates: [{ id: 'i1', result: 'FAIL', notes: 're-saved' }],
            });

            expect(mockCreateFinding).not.toHaveBeenCalled();
            expect(mockCreateTask).not.toHaveBeenCalled();
        });
    });
});

// ── feat/audit-cycle-unify — createAudit accepts an optional AuditCycle ──
describe('createAudit — auditCycleId association', () => {
    it('rejects an auditCycleId that does not belong to the tenant', async () => {
        const db = {
            ...fakeDbWithControls(),
            auditCycle: { findFirst: jest.fn().mockResolvedValue(null) },
        };
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await expect(
            createAudit(makeRequestContext('EDITOR'), { title: 'Q4', auditCycleId: 'foreign-cycle' }),
        ).rejects.toThrow();
        // The cycle miss short-circuits before the create write.
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('persists a valid auditCycleId', async () => {
        const db = {
            ...fakeDbWithControls(),
            auditCycle: { findFirst: jest.fn().mockResolvedValue({ id: 'cyc1' }) },
        };
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await createAudit(makeRequestContext('EDITOR'), { title: 'Q4', auditCycleId: 'cyc1' });

        expect(mockCreate.mock.calls[0][2].auditCycleId).toBe('cyc1');
    });

    it('defaults auditCycleId to null for a standalone audit', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDbWithControls() as never));

        await createAudit(makeRequestContext('EDITOR'), { title: 'Q4' });

        expect(mockCreate.mock.calls[0][2].auditCycleId).toBeNull();
    });
});
