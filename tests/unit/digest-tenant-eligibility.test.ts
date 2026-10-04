/**
 * Digest Dispatch — Tenant Notification Eligibility Tests
 *
 * Verifies that:
 * 1. Tenant with isNotificationsEnabled=false does NOT receive digests
 * 2. Tenant with isNotificationsEnabled=true still receives digests
 * 3. Mixed-tenant dispatch only sends for eligible tenants
 * 4. Suppressed items are counted and logged
 * 5. No regression in grouped digest behavior
 */

// ─── Mocks ──────────────────────────────────────────────────────────

const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
};

const mockOutboxCreate = jest.fn();
// Kept wired but no longer driven by any fixture: `resolveRecipients` used to
// resolve owners straight off `User`, with no tenant and no membership check,
// which is how offboarded users kept receiving a tenant's deadline digests.
// Owned recipients now come from `tenantMembership.findMany` below. The stub
// stays so an accidental return to `prisma.user.findMany` resolves to [] and
// fails the assertions loudly rather than throwing "not a function".
const mockUserFindMany = jest.fn().mockResolvedValue([]);
const mockMembershipFindMany = jest.fn().mockResolvedValue([]);
// `resolveLiveTenants` asks for liveness and slug in one query. The default
// echoes every requested id back as LIVE, which is what the pre-existing tests
// assume; the removed-tenant tests below override it.
const mockTenantFindMany = jest.fn(
    (args: { where: { id: { in: string[] } } }) =>
        Promise.resolve(args.where.id.in.map(id => ({ id, slug: 'acme' }))),
);
// Deliberately left wired and unused, like `mockUserFindMany` above: a return to
// the per-tenant `findUnique` slug lookup resolves `undefined`, so the
// `/t/acme/` link assertions fail loudly instead of throwing "not a function".
const mockTenantFindUnique = jest.fn().mockResolvedValue(null);
const mockSettingsFindUnique = jest.fn();

jest.mock('@/lib/observability/logger', () => ({
    logger: mockLogger,
}));

jest.mock('@/lib/prisma', () => ({
    prisma: {
        user: { findMany: (...args: unknown[]) => mockUserFindMany(...args) },
        tenantMembership: { findMany: (...args: unknown[]) => mockMembershipFindMany(...args) },
        tenant: {
            findMany: (...args: unknown[]) =>
                mockTenantFindMany(...(args as [{ where: { id: { in: string[] } } }])),
            findUnique: (...args: unknown[]) => mockTenantFindUnique(...args),
        },
        notificationOutbox: { create: (...args: unknown[]) => mockOutboxCreate(...args) },
        tenantNotificationSettings: {
            findUnique: (...args: unknown[]) => mockSettingsFindUnique(...args),
        },
    },
}));

// ─── Imports ────────────────────────────────────────────────────────

import type { DueItem } from '../../src/app-layer/jobs/types';
import { dispatchDigest } from '../../src/app-layer/notifications/digest-dispatcher';

// ─── Fixtures ───────────────────────────────────────────────────────

function makeDueItem(overrides: Partial<DueItem> = {}): DueItem {
    return {
        entityType: 'CONTROL',
        entityId: 'ctrl-1',
        tenantId: 'tenant-enabled',
        name: 'Firewall Review',
        reason: 'Control testing overdue by 5 day(s)',
        urgency: 'OVERDUE',
        dueDate: '2026-04-12T00:00:00Z',
        daysRemaining: -5,
        ownerUserId: 'user-1',
        ...overrides,
    };
}

// ─── Setup ──────────────────────────────────────────────────────────

beforeEach(() => {
    jest.clearAllMocks();
    mockOutboxCreate.mockResolvedValue({ id: 'outbox-1' });
    mockTenantFindMany.mockImplementation((args: { where: { id: { in: string[] } } }) =>
        Promise.resolve(args.where.id.in.map(id => ({ id, slug: 'acme' }))),
    );

    // Default: notifications enabled (no settings row = enabled by default)
    mockSettingsFindUnique.mockResolvedValue(null);
});

// ═════════════════════════════════════════════════════════════════════
// 1. Tenant with notifications disabled — digest suppressed
// ═════════════════════════════════════════════════════════════════════

describe('Digest dispatch: tenant notification eligibility', () => {
    test('tenant with isNotificationsEnabled=false does NOT receive digest', async () => {
        // Settings row: disabled
        mockSettingsFindUnique.mockResolvedValue({ enabled: false });

        mockMembershipFindMany.mockResolvedValue([
            { tenantId: 'tenant-disabled', user: { id: 'user-1', email: 'alice@acme.com', name: 'Alice' } },
        ]);

        const items: DueItem[] = [
            makeDueItem({ tenantId: 'tenant-disabled', ownerUserId: 'user-1' }),
        ];

        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items,
        });

        // No email enqueued
        expect(result.enqueued).toBe(0);
        // Item was suppressed, not just skipped
        expect(result.suppressed).toBe(1);
        // Outbox never called
        expect(mockOutboxCreate).not.toHaveBeenCalled();
    });

    test('tenant with isNotificationsEnabled=true still receives digest', async () => {
        // Settings row: enabled
        mockSettingsFindUnique.mockResolvedValue({ enabled: true });

        mockMembershipFindMany.mockResolvedValue([
            { tenantId: 'tenant-enabled', user: { id: 'user-1', email: 'alice@acme.com', name: 'Alice' } },
        ]);

        const items: DueItem[] = [
            makeDueItem({ tenantId: 'tenant-enabled', ownerUserId: 'user-1' }),
        ];

        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items,
        });

        expect(result.enqueued).toBe(1);
        expect(result.suppressed).toBe(0);
        expect(mockOutboxCreate).toHaveBeenCalledTimes(1);
    });

    test('tenant with no settings row defaults to enabled', async () => {
        // No settings row = enabled by default
        mockSettingsFindUnique.mockResolvedValue(null);

        mockMembershipFindMany.mockResolvedValue([
            { tenantId: 'tenant-new', user: { id: 'user-1', email: 'alice@acme.com', name: 'Alice' } },
        ]);

        const items: DueItem[] = [
            makeDueItem({ tenantId: 'tenant-new', ownerUserId: 'user-1' }),
        ];

        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items,
        });

        expect(result.enqueued).toBe(1);
        expect(result.suppressed).toBe(0);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. Mixed-tenant: only eligible tenants receive digests
// ═════════════════════════════════════════════════════════════════════

describe('Digest dispatch: mixed-tenant eligibility', () => {
    test('mixed tenants: only eligible tenant receives digest', async () => {
        // Tenant A: enabled, Tenant B: disabled
        mockSettingsFindUnique.mockImplementation((args: { where: { tenantId: string } }) => {
            if (args.where.tenantId === 'tenant-a') return Promise.resolve({ enabled: true });
            if (args.where.tenantId === 'tenant-b') return Promise.resolve({ enabled: false });
            return Promise.resolve(null); // default enabled
        });

        mockMembershipFindMany.mockResolvedValue([
            { tenantId: 'tenant-a', user: { id: 'user-a', email: 'alice@a.com', name: 'Alice' } },
            { tenantId: 'tenant-b', user: { id: 'user-b', email: 'bob@b.com', name: 'Bob' } },
        ]);

        const items: DueItem[] = [
            makeDueItem({ tenantId: 'tenant-a', ownerUserId: 'user-a', entityId: 'ctrl-1' }),
            makeDueItem({ tenantId: 'tenant-a', ownerUserId: 'user-a', entityId: 'ctrl-2' }),
            makeDueItem({ tenantId: 'tenant-b', ownerUserId: 'user-b', entityId: 'ctrl-3' }),
        ];

        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items,
        });

        // Tenant A: 1 digest (2 items grouped)
        expect(result.enqueued).toBe(1);
        // Tenant B: 1 item suppressed
        expect(result.suppressed).toBe(1);

        // Only tenant A's email was enqueued
        expect(mockOutboxCreate).toHaveBeenCalledTimes(1);
        const call = mockOutboxCreate.mock.calls[0][0];
        expect(call.data.toEmail).toBe('alice@a.com');
        expect(call.data.tenantId).toBe('tenant-a');
    });

    test('per-tenant breakdown shows suppressed status', async () => {
        mockSettingsFindUnique.mockImplementation((args: { where: { tenantId: string } }) => {
            if (args.where.tenantId === 'tenant-off') return Promise.resolve({ enabled: false });
            return Promise.resolve(null);
        });

        mockMembershipFindMany.mockResolvedValue([
            { tenantId: 'tenant-on', user: { id: 'user-1', email: 'user@on.com', name: 'User' } },
        ]);

        const items: DueItem[] = [
            makeDueItem({ tenantId: 'tenant-on', ownerUserId: 'user-1' }),
            makeDueItem({ tenantId: 'tenant-off', ownerUserId: 'user-2', entityId: 'ctrl-2' }),
        ];

        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items,
        });

        expect(result.tenants['tenant-off']?.suppressed).toBe(true);
        expect(result.tenants['tenant-on']?.suppressed).toBeUndefined();
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. Unowned items also respect tenant eligibility
// ═════════════════════════════════════════════════════════════════════

describe('Digest dispatch: unowned items respect tenant eligibility', () => {
    test('unowned items for disabled tenant are suppressed', async () => {
        mockSettingsFindUnique.mockResolvedValue({ enabled: false });

        const items: DueItem[] = [
            makeDueItem({ tenantId: 'tenant-off', ownerUserId: undefined }),
        ];

        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items,
        });

        expect(result.enqueued).toBe(0);
        expect(result.suppressed).toBe(1);
        // Admin resolution should not happen — skipped before that
        expect(mockMembershipFindMany).not.toHaveBeenCalled();
    });

    test('unowned items for enabled tenant still go to admins', async () => {
        mockSettingsFindUnique.mockResolvedValue({ enabled: true });

        mockMembershipFindMany.mockResolvedValue([
            { user: { id: 'admin-1', email: 'admin@acme.com', name: 'Admin' } },
        ]);

        const items: DueItem[] = [
            makeDueItem({ tenantId: 'tenant-on', ownerUserId: undefined }),
        ];

        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items,
        });

        expect(result.enqueued).toBe(1);
        expect(result.suppressed).toBe(0);
        expect(mockOutboxCreate).toHaveBeenCalledTimes(1);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. Structured logging for suppressed digests
// ═════════════════════════════════════════════════════════════════════

describe('Digest dispatch: suppression logging', () => {
    test('logs suppression event with tenant and item count', async () => {
        mockSettingsFindUnique.mockResolvedValue({ enabled: false });

        const items: DueItem[] = [
            makeDueItem({ tenantId: 'tenant-muted', entityId: 'c1' }),
            makeDueItem({ tenantId: 'tenant-muted', entityId: 'c2' }),
        ];

        await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items,
        });

        const suppressionLogs = mockLogger.info.mock.calls.filter(
            c => c[0]?.includes?.('suppressed') || c[0]?.includes?.('disabled'),
        );

        expect(suppressionLogs.length).toBeGreaterThanOrEqual(1);
        const logMeta = suppressionLogs[0][1];
        expect(logMeta.tenantId).toBe('tenant-muted');
        expect(logMeta.itemCount).toBe(2);
    });

    test('final dispatch log includes suppressed count', async () => {
        mockSettingsFindUnique.mockResolvedValue({ enabled: false });

        await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items: [makeDueItem({ tenantId: 'tenant-x' })],
        });

        const completedLogs = mockLogger.info.mock.calls.filter(
            c => c[0]?.includes?.('completed'),
        );

        expect(completedLogs.length).toBeGreaterThanOrEqual(1);
        const logMeta = completedLogs[0][1];
        expect(logMeta.suppressed).toBe(1);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 5. Structural: digest-dispatcher imports isNotificationsEnabled
// ═════════════════════════════════════════════════════════════════════

describe('Structural: digest-dispatcher uses notification settings', () => {
    const { readFileSync } = require('fs');
    const { resolve } = require('path');

    test('digest-dispatcher imports isNotificationsEnabled', () => {
        const source = readFileSync(
            resolve(__dirname, '../../src/app-layer/notifications/digest-dispatcher.ts'),
            'utf8',
        );
        expect(source).toContain("import { isNotificationsEnabled } from './settings'");
    });

    test('digest-dispatcher calls isNotificationsEnabled before dispatch', () => {
        const source = readFileSync(
            resolve(__dirname, '../../src/app-layer/notifications/digest-dispatcher.ts'),
            'utf8',
        );
        expect(source).toContain('isNotificationsEnabled(prisma, tenantId)');
    });

    test('both owned and unowned loops check eligibility', () => {
        const source = readFileSync(
            resolve(__dirname, '../../src/app-layer/notifications/digest-dispatcher.ts'),
            'utf8',
        );
        const eligibleChecks = (source.match(/eligibleTenants\.has\(tenantId\)/g) || []).length;
        expect(eligibleChecks).toBeGreaterThanOrEqual(2); // owned + unowned loops
    });
});

// ═════════════════════════════════════════════════════════════════════
// 6. #3165 — the unowned fallback is its own digest, not folded into
//    an admin's personal one
// ═════════════════════════════════════════════════════════════════════

describe('Digest dispatch: unowned items are a separate digest', () => {
    /**
     * Both membership reads go through the same mock, so answer by shape:
     * `resolveTenantAdmins` is the one that filters on `role`.
     */
    function wireAdminWhoAlsoOwns() {
        mockMembershipFindMany.mockImplementation(
            (args: { where: { role?: unknown } }) =>
                args.where.role !== undefined
                    ? Promise.resolve([
                          { user: { id: 'admin-1', email: 'admin@acme.com', name: 'Admin' } },
                      ])
                    : Promise.resolve([
                          {
                              tenantId: 'tenant-on',
                              user: { id: 'admin-1', email: 'admin@acme.com', name: 'Admin' },
                          },
                      ]),
        );
    }

    /**
     * THE REGRESSION. Both sends used the key `…:{email}:digest:{date}`, so for
     * an admin who also owns something the second `create` hit the unique
     * constraint, was swallowed as P2002, and the unowned list vanished —
     * counted as `skipped`, which reads identically to "already sent today".
     *
     * The admin here owns ctrl-1 and the tenant has an unowned ctrl-2. Two
     * distinct outbox rows must exist, and this fails with one before the fix.
     */
    test('an admin who also owns items receives BOTH digests, on distinct keys', async () => {
        wireAdminWhoAlsoOwns();
        const created: Array<{ dedupeKey: string; subject: string }> = [];
        mockOutboxCreate.mockImplementation((args: { data: { dedupeKey: string; subject: string } }) => {
            if (created.some(c => c.dedupeKey === args.data.dedupeKey)) {
                // What the real unique constraint does.
                return Promise.reject(Object.assign(new Error('Unique constraint'), { code: 'P2002' }));
            }
            created.push({ dedupeKey: args.data.dedupeKey, subject: args.data.subject });
            return Promise.resolve({ id: `outbox-${created.length}` });
        });

        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items: [
                makeDueItem({ tenantId: 'tenant-on', entityId: 'ctrl-1', ownerUserId: 'admin-1' }),
                makeDueItem({ tenantId: 'tenant-on', entityId: 'ctrl-2', ownerUserId: undefined }),
            ],
        });

        expect(result.enqueued).toBe(2);
        expect(result.skipped).toBe(0);
        expect(created).toHaveLength(2);

        const scopes = created.map(c => c.dedupeKey.split(':')[3]).sort();
        expect(scopes).toEqual(['digest', 'unowned']);
    });

    test('the unowned digest says the items have no owner; the personal one does not', async () => {
        wireAdminWhoAlsoOwns();
        const created: Array<{ dedupeKey: string; subject: string; bodyText: string }> = [];
        mockOutboxCreate.mockImplementation((args: { data: typeof created[number] }) => {
            created.push(args.data);
            return Promise.resolve({ id: `outbox-${created.length}` });
        });

        await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items: [
                makeDueItem({ tenantId: 'tenant-on', entityId: 'ctrl-1', ownerUserId: 'admin-1' }),
                makeDueItem({ tenantId: 'tenant-on', entityId: 'ctrl-2', ownerUserId: undefined }),
            ],
        });

        const unowned = created.find(c => c.dedupeKey.includes(':unowned:'))!;
        const personal = created.find(c => c.dedupeKey.includes(':digest:'))!;

        expect(unowned.subject).toContain('need an owner');
        expect(unowned.bodyText).toContain('no owner assigned');
        expect(unowned.bodyText).not.toContain('You have');

        expect(personal.subject).toContain('Compliance Deadline Digest');
        expect(personal.bodyText).toContain('You have');
        expect(personal.bodyText).not.toContain('no owner assigned');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 7. A removed tenant is not mailed at all
// ═════════════════════════════════════════════════════════════════════

describe('Digest dispatch: soft-deleted tenants', () => {
    test('items for a removed tenant are counted separately and never enqueued', async () => {
        // `deletedAt: null` in the query means a removed tenant simply is not
        // returned — the mock models that by omitting it.
        mockTenantFindMany.mockImplementation((args: { where: { id: { in: string[] } } }) =>
            Promise.resolve(
                args.where.id.in
                    .filter(id => id !== 'tenant-removed')
                    .map(id => ({ id, slug: 'acme' })),
            ),
        );
        mockMembershipFindMany.mockResolvedValue([
            { tenantId: 'tenant-on', user: { id: 'user-1', email: 'alice@acme.com', name: 'Alice' } },
        ]);

        const result = await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items: [
                makeDueItem({ tenantId: 'tenant-removed', entityId: 'c1' }),
                makeDueItem({ tenantId: 'tenant-removed', entityId: 'c2' }),
                makeDueItem({ tenantId: 'tenant-on', entityId: 'c3', ownerUserId: 'user-1' }),
            ],
        });

        expect(result.removedTenantItems).toBe(2);
        expect(result.suppressed).toBe(0); // NOT conflated with notifications-disabled
        expect(result.enqueued).toBe(1);
        expect(result.tenants['tenant-removed']).toEqual({ enqueued: 0, skipped: 0, removed: true });

        // Nothing addressed to the removed tenant reached the outbox.
        const tenantIds = mockOutboxCreate.mock.calls.map(c => c[0].data.tenantId);
        expect(tenantIds).toEqual(['tenant-on']);
    });

    /**
     * The mock models liveness by OMITTING the tenant from its result, so it
     * cannot tell whether the query actually asked for `deletedAt: null` — drop
     * the predicate and every assertion above still passes. This asserts the
     * predicate itself, at the call site, which is the only thing a mocked
     * client can say about it.
     */
    test('the liveness query filters on deletedAt, not just on id', async () => {
        await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items: [makeDueItem({ tenantId: 'tenant-on', ownerUserId: undefined })],
        });

        expect(mockTenantFindMany).toHaveBeenCalledWith({
            where: { id: { in: ['tenant-on'] }, deletedAt: null },
            select: { id: true, slug: true },
        });
    });

    test('a removed tenant is not even asked whether notifications are enabled', async () => {
        mockTenantFindMany.mockResolvedValue([]); // every tenant removed
        await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items: [makeDueItem({ tenantId: 'tenant-removed' })],
        });
        expect(mockSettingsFindUnique).not.toHaveBeenCalled();
        expect(mockMembershipFindMany).not.toHaveBeenCalled();
    });
});
