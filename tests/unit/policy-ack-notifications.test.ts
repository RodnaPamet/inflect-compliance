/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory fakes for Prisma delegates. */
/**
 * Policy acknowledgement notifications across publish and rollback (#4128).
 *
 * Two defects, both invisible from inside the product:
 *
 *   1. The links were `/policies/<id>`, with no `/t/<slug>` prefix, so the
 *      bell sent people to a 404.
 *   2. A rollback re-notified with `POLICY_ACK_REQUIRED:<restoredVersionId>:
 *      <userId>` — the key the restored version's own request (or publish)
 *      had already used. `Notification.dedupeKey` is unique, the insert fell
 *      into a silent `.catch`, and only people new to the campaign were told.
 *
 * The fake below keeps the one property that made (2) silent: a notification
 * store that REFUSES a second row with the same `dedupeKey`, as the unique
 * index does. The sequence is driven through the real usecases — request,
 * publish, roll back — so the keys under test are the ones they really write,
 * not ones restated here.
 */

// ─── In-memory state ────────────────────────────────────────────────

type Version = { id: string; policyId: string; versionNumber: number; changeSummary: string | null };

const VERSIONS: Record<string, Version> = {
    v1: { id: 'v1', policyId: 'p1', versionNumber: 1, changeSummary: null },
    v2: { id: 'v2', policyId: 'p1', versionNumber: 2, changeSummary: 'revised' },
};

interface State {
    policy: {
        id: string;
        tenantId: string;
        title: string;
        status: string;
        currentVersionId: string | null;
        lifecycleVersion: number;
        lifecycleHistoryJson: unknown[];
    };
    /** versionId → userId → assignedById */
    assignments: Map<string, Map<string, string | null>>;
    notifications: Array<{ userId: string; title: string; linkUrl: string | null; dedupeKey: string | null }>;
}

let state: State;

function freshState(): State {
    return {
        policy: {
            id: 'p1',
            tenantId: 'tenant-1',
            title: 'Acceptable Use',
            status: 'DRAFT',
            currentVersionId: 'v1',
            lifecycleVersion: 1,
            lifecycleHistoryJson: [],
        },
        assignments: new Map(),
        notifications: [],
    };
}

function policyView() {
    const p = state.policy;
    const cv = p.currentVersionId ? VERSIONS[p.currentVersionId] : null;
    return { ...p, currentVersion: cv, lifecycleHistoryJson: [...p.lifecycleHistoryJson] };
}

const db: any = {
    policy: {
        update: jest.fn(async ({ data }: any) => {
            if (data.lifecycleVersion !== undefined) state.policy.lifecycleVersion = data.lifecycleVersion;
            if (data.lifecycleHistoryJson !== undefined) state.policy.lifecycleHistoryJson = data.lifecycleHistoryJson;
            return {};
        }),
    },
    policyAcknowledgementAssignment: {
        findMany: jest.fn(async ({ where, take }: any) => {
            const byUser = state.assignments.get(where.policyVersionId) ?? new Map();
            const gt: string | undefined = where.userId?.gt;
            return [...byUser.entries()]
                .filter(([u]) => (gt ? u > gt : true))
                .sort(([a], [b]) => a.localeCompare(b))
                .slice(0, take)
                .map(([userId, assignedById]) => ({ userId, assignedById }));
        }),
        createMany: jest.fn(async ({ data }: any) => {
            let count = 0;
            for (const row of data) {
                const byUser = state.assignments.get(row.policyVersionId) ?? new Map();
                if (!byUser.has(row.userId)) {
                    byUser.set(row.userId, row.assignedById ?? null);
                    count++;
                }
                state.assignments.set(row.policyVersionId, byUser);
            }
            return { count };
        }),
    },
    tenantMembership: { findMany: jest.fn(async () => [{ userId: 'u1' }]) },
    tenant: { findUnique: jest.fn(async () => ({ slug: 'acme' })) },
    notification: {
        // The unique index on `dedupeKey`, which is what made the old rollback
        // key fail silently.
        create: jest.fn(async ({ data }: any) => {
            if (data.dedupeKey && state.notifications.some((n) => n.dedupeKey === data.dedupeKey)) {
                throw Object.assign(new Error('Unique constraint failed on dedupeKey'), { code: 'P2002' });
            }
            state.notifications.push({
                userId: data.userId,
                title: data.title,
                linkUrl: data.linkUrl ?? null,
                dedupeKey: data.dedupeKey ?? null,
            });
            return { id: `n${state.notifications.length}` };
        }),
    },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (tx: any) => any) => fn(db)),
}));

jest.mock('@/app-layer/repositories/PolicyRepository', () => ({
    PolicyRepository: {
        getById: jest.fn(async () => policyView()),
        setCurrentVersion: jest.fn(async (_db: any, _ctx: any, _id: string, versionId: string) => {
            state.policy.currentVersionId = versionId;
        }),
        updateStatus: jest.fn(async (_db: any, _ctx: any, _id: string, status: string) => {
            state.policy.status = status;
        }),
    },
}));

jest.mock('@/app-layer/repositories/PolicyVersionRepository', () => ({
    PolicyVersionRepository: { getById: jest.fn(async (_db: any, id: string) => VERSIONS[id] ?? null) },
}));

jest.mock('@/app-layer/repositories/PolicyApprovalRepository', () => ({
    PolicyApprovalRepository: {
        latestApproved: jest.fn(async () => null),
        supersedePending: jest.fn(async () => ({ count: 0 })),
    },
}));

jest.mock('@/app-layer/repositories/PolicyTemplateRepository', () => ({ PolicyTemplateRepository: {} }));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/app-layer/notifications/enqueue', () => ({ enqueueEmail: jest.fn() }));
jest.mock('@/app-layer/usecases/policy-sharepoint-sync', () => ({ pushPolicyToSharePoint: jest.fn() }));
jest.mock('@/lib/observability/business-metrics', () => ({ recordPolicyPublished: jest.fn() }));
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { publishPolicy, rollbackPolicy } from '@/app-layer/usecases/policy';
import { requirePolicyAcknowledgement } from '@/app-layer/usecases/policy-attestation';
import { makeRequestContext } from '../helpers/make-context';

const admin = makeRequestContext('ADMIN');
const BYPASS = { bypassApprovalReason: 'test' };

/** v1 live, u1 asked to acknowledge it, then v2 published over it. */
async function requestThenRevise() {
    await publishPolicy(admin, 'p1', 'v1', BYPASS);
    await requirePolicyAcknowledgement(admin, 'p1', { audience: { type: 'all' } });
    await publishPolicy(admin, 'p1', 'v2', BYPASS);
}

const forU1 = () => state.notifications.filter((n) => n.userId === 'u1');

beforeEach(() => {
    jest.clearAllMocks();
    state = freshState();
});

describe('rolling back re-notifies the people asked before', () => {
    it('notifies a person who was already notified about the restored version', async () => {
        await requestThenRevise();
        // Asked for v1, then asked again for v2.
        expect(forU1()).toHaveLength(2);

        await rollbackPolicy(admin, 'p1');

        expect(state.policy.currentVersionId).toBe('v1');
        // The rollback is a new request: u1 is told, although the original
        // request for v1 already notified them about this same version.
        expect(forU1()).toHaveLength(3);
        expect(forU1()[2].title).toBe('Re-acknowledgement required: "Acceptable Use"');
    });

    it('a second rollback notifies again', async () => {
        await requestThenRevise();
        await rollbackPolicy(admin, 'p1'); // v2 → v1
        await rollbackPolicy(admin, 'p1'); // v1 → v2 again (the rollback is reversible)

        expect(state.policy.currentVersionId).toBe('v2');
        expect(forU1()).toHaveLength(4);
    });

    it('replaying the SAME rollback does not notify twice', async () => {
        await requestThenRevise();
        const before = JSON.parse(JSON.stringify(state.policy));
        const assignments = new Map([...state.assignments].map(([k, v]) => [k, new Map(v)]));

        await rollbackPolicy(admin, 'p1');
        expect(forU1()).toHaveLength(3);

        // Replay the identical rollback: same policy, same starting state,
        // so the same lifecycle step. The notification store is kept.
        state.policy = before;
        state.assignments = assignments;
        await rollbackPolicy(admin, 'p1');

        expect(forU1()).toHaveLength(3);
    });
});

describe('acknowledgement notifications link to the policy inside the workspace', () => {
    it('request, publish and rollback all link to /t/<slug>/policies/<id>', async () => {
        await requestThenRevise();
        await rollbackPolicy(admin, 'p1');

        expect(forU1()).toHaveLength(3);
        for (const n of forU1()) expect(n.linkUrl).toBe('/t/acme/policies/p1');
        expect(db.tenant.findUnique).not.toHaveBeenCalled();
    });

    it('looks the slug up when the context carries none', async () => {
        const noSlug = makeRequestContext('ADMIN', { tenantSlug: undefined });
        await publishPolicy(noSlug, 'p1', 'v1', BYPASS);
        await requirePolicyAcknowledgement(noSlug, 'p1', { audience: { type: 'all' } });

        expect(db.tenant.findUnique).toHaveBeenCalledWith({ where: { id: 'tenant-1' }, select: { slug: true } });
        expect(forU1()[0].linkUrl).toBe('/t/acme/policies/p1');
    });
});
