export {};
/**
 * Policy Review Reminder — Tenant Isolation Tests
 *
 * Verifies that:
 * 1. Tenant-scoped calls add tenantId to queries
 * 2. System-wide calls (no tenantId) scan all tenants
 * 3. Cross-tenant leakage is prevented
 * 4. Logging indicates correct scope
 */

const TENANT_A = 'tenant-aaa';
const TENANT_B = 'tenant-bbb';

const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
};

const mockPolicyFindMany = jest.fn().mockResolvedValue([]);
const mockAuditLogCreate = jest.fn().mockResolvedValue({});

const mockPrisma = {
    policy: { findMany: (...args: unknown[]) => mockPolicyFindMany(...args) },
    auditLog: { create: (...args: unknown[]) => mockAuditLogCreate(...args) },
    // TP-5 — processOverdueReminders now materialises review-due signals as
    // Task rows. The batched taskLink lookup returns [] (no existing task),
    // so an overdue policy with an owner mints one task + link.
    taskLink: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({}) },
    task: { create: jest.fn().mockResolvedValue({ id: 'task-x' }) },
} as any; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.mock('@/lib/observability/logger', () => ({ logger: mockLogger }));
    // TP-1 — processOverdueReminders now routes the review-due task through
    // the canonical createTask (its own tenant context), not the injected
    // db. Mock it so these isolation tests exercise the job's QUERY scoping
    // (policy.findMany, auditLog.create) without reaching real prisma.
    jest.mock('@/app-layer/usecases/task', () => ({
        createTask: jest.fn().mockResolvedValue({ id: 'task-x', key: 'TSK-1' }),
        addTaskLink: jest.fn().mockResolvedValue({}),
    }));
    // #4400 — the task is written as the tenant's SYSTEM user, which the job
    // creates on first use. Mocked so this stays a unit test.
    jest.mock('@/app-layer/context-system', () => ({
        ...jest.requireActual('@/app-layer/context-system'),
        buildTenantSystemJobContext: jest.fn(async ({ tenantId }: { tenantId: string }) => ({
            tenantId,
            userId: `sys_${tenantId}`,
        })),
    }));
});

// ═════════════════════════════════════════════════════════════════════
// 1. findOverduePolicies — tenant scoping
// ═════════════════════════════════════════════════════════════════════

describe('findOverduePolicies — tenant isolation', () => {
    test('tenant-scoped call adds tenantId to query where clause', async () => {
        const { findOverduePolicies } = await import(
            '../../src/app-layer/jobs/policyReviewReminder'
        );
        await findOverduePolicies(mockPrisma, { tenantId: TENANT_A });

        expect(mockPolicyFindMany).toHaveBeenCalledTimes(1);
        const call = mockPolicyFindMany.mock.calls[0][0];
        expect(call.where).toHaveProperty('tenantId', TENANT_A);
    });

    test('system-wide call (no tenantId) does NOT add tenantId to query', async () => {
        const { findOverduePolicies } = await import(
            '../../src/app-layer/jobs/policyReviewReminder'
        );
        await findOverduePolicies(mockPrisma);

        expect(mockPolicyFindMany).toHaveBeenCalledTimes(1);
        const call = mockPolicyFindMany.mock.calls[0][0];
        expect(call.where).not.toHaveProperty('tenantId');
    });

    test('tenant A results do not include tenant B policies', async () => {
        const policyA = {
            id: 'p-a1', tenantId: TENANT_A, title: 'Policy A', slug: 'policy-a',
            nextReviewAt: new Date('2020-01-01'), ownerUserId: 'u1',
        };
        const policyB = {
            id: 'p-b1', tenantId: TENANT_B, title: 'Policy B', slug: 'policy-b',
            nextReviewAt: new Date('2020-01-01'), ownerUserId: 'u2',
        };

        mockPolicyFindMany.mockImplementation((args: { where: Record<string, unknown> }) => {
            const all = [policyA, policyB];
            if (args.where.tenantId) {
                return Promise.resolve(all.filter(p => p.tenantId === args.where.tenantId));
            }
            return Promise.resolve(all);
        });

        const { findOverduePolicies } = await import(
            '../../src/app-layer/jobs/policyReviewReminder'
        );
        const results = await findOverduePolicies(mockPrisma, { tenantId: TENANT_A });

        for (const r of results) {
            expect(r.tenantId).toBe(TENANT_A);
        }
        expect(results.find(r => r.tenantId === TENANT_B)).toBeUndefined();
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. processOverdueReminders — tenant scoping
// ═════════════════════════════════════════════════════════════════════

describe('processOverdueReminders — tenant isolation', () => {
    test('tenant-scoped call passes tenantId through to query', async () => {
        const { processOverdueReminders } = await import(
            '../../src/app-layer/jobs/policyReviewReminder'
        );
        await processOverdueReminders(mockPrisma, { tenantId: TENANT_A });

        const call = mockPolicyFindMany.mock.calls[0][0];
        expect(call.where.tenantId).toBe(TENANT_A);
    });

    test('audit log entries are created per-policy with correct tenantId', async () => {
        const policyA = {
            id: 'p-a1', tenantId: TENANT_A, title: 'Policy A', slug: 'policy-a',
            nextReviewAt: new Date('2020-01-01'), ownerUserId: 'u1',
        };
        mockPolicyFindMany.mockResolvedValue([policyA]);

        const { processOverdueReminders } = await import(
            '../../src/app-layer/jobs/policyReviewReminder'
        );
        await processOverdueReminders(mockPrisma, { tenantId: TENANT_A });

        expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
        const createCall = mockAuditLogCreate.mock.calls[0][0];
        expect(createCall.data.tenantId).toBe(TENANT_A);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. Logging — scope visibility
// ═════════════════════════════════════════════════════════════════════

describe('policyReviewReminder — logging scope', () => {
    test('tenant-scoped logging indicates scope and tenantId', async () => {
        const { findOverduePolicies } = await import(
            '../../src/app-layer/jobs/policyReviewReminder'
        );
        await findOverduePolicies(mockPrisma, { tenantId: TENANT_A });

        const startLog = mockLogger.info.mock.calls.find(
            (c: string[]) => c[0] === 'policy review scan starting'
        );
        expect(startLog).toBeDefined();
        expect(startLog[1]).toMatchObject({
            scope: 'tenant-scoped',
            tenantId: TENANT_A,
        });
    });

    test('system-wide logging indicates scope without tenantId', async () => {
        const { findOverduePolicies } = await import(
            '../../src/app-layer/jobs/policyReviewReminder'
        );
        await findOverduePolicies(mockPrisma);

        const startLog = mockLogger.info.mock.calls.find(
            (c: string[]) => c[0] === 'policy review scan starting'
        );
        expect(startLog).toBeDefined();
        expect(startLog[1]).toMatchObject({ scope: 'system-wide' });
        expect(startLog[1]).not.toHaveProperty('tenantId');
    });
});
