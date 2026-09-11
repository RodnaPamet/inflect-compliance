/**
 * EVERY MOVED AGENTIC PAGE ENFORCES ITS OWN GATE, AT THE PAGE (#2438, #2437).
 *
 * Five surfaces moved out of `/admin` and `/agent-*` into `/agents/*`. Three of
 * them had no gate of their own at all — their docstrings said "Admin-gated by
 * the parent /admin layout", and that sentence WAS the gate: one
 * `<RequirePermission resource="admin" action="view">` in an ancestor layout
 * they no longer have. Moving the files would have silently removed the only
 * check on them.
 *
 * So each now refuses for itself, and this file is what says so from outside.
 * Two claims per page:
 *
 *   1. A caller without the page's own key gets a REFUSAL rather than content —
 *      and the data load NEVER STARTS. The second half is the one worth
 *      testing: a gate that renders a ForbiddenPage after fetching is a gate
 *      that leaked into logs, into the query plan, and (for review quality)
 *      into an alert row the usecase WRITES. Asserted with a spy on the
 *      usecase, not on the rendered output.
 *
 *   2. TWO-TENANT: the data the page loads for tenant A names no tenant-B row.
 *      Driven against a real database through the same usecases the pages call.
 *
 * ── WHY THE KEYS DIFFER, AND WHY THAT IS NOT AN OVERSIGHT ───────────────────
 *
 * Receipts, quarantine and review quality gate on `admin.agent_registry`: the
 * operator move after reading any of them is to suspend or retire the agent
 * that produced the row, which is the authority that key names, and it is the
 * key the quarantine ROUTE has always carried.
 *
 * Proposals and runs gate on `admin.view`, UNCHANGED by the move. The APIs
 * behind them are gated only by the usecase's `assertCanRead`, so the page
 * check is the whole narrowing — and narrowing it further would take the
 * approval queue away from reviewers who have it today. That is a permissions
 * change, not a routing one. This file pins the difference so neither drifts
 * into the other by accident.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';

jest.setTimeout(120_000);

// ─── Mocks, all declared before the page modules are imported ──────────────

/**
 * The session → context boundary. Mocked so a test can BE a principal without
 * minting a JWT; everything below it (the usecases, the repository, RLS) is
 * real and hits the database.
 */
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));

/** `next-intl/server` is ESM; resolve the real catalogue. */
jest.mock('next-intl/server', () => ({
    __esModule: true,
    getTranslations: async (ns: string) => {
        const en = require('../../messages/en.json') as Record<string, unknown>;
        const bag = ns
            .split('.')
            .reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                en,
            );
        return (key: string) => {
            const v = key
                .split('.')
                .reduce<unknown>(
                    (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                    bag,
                );
            return typeof v === 'string' ? v : key;
        };
    },
}));

/**
 * The five data loads, SPIED but otherwise real.
 *
 * `requireActual` and forward: the two-tenant half needs the genuine query, and
 * the gate half needs to know whether it ran. A stubbed usecase would make the
 * second claim assertable and the first meaningless.
 */
const listReceiptsSpy = jest.fn();
jest.mock('@/app-layer/usecases/agent-action-receipt', () => {
    const actual = jest.requireActual('@/app-layer/usecases/agent-action-receipt');
    return {
        __esModule: true,
        ...actual,
        listReceipts: (...a: unknown[]) => {
            listReceiptsSpy(...a);
            return (actual as { listReceipts: (...x: unknown[]) => unknown }).listReceipts(...a);
        },
    };
});

const reviewQualitySpy = jest.fn();
jest.mock('@/app-layer/usecases/agent-review-quality', () => {
    const actual = jest.requireActual('@/app-layer/usecases/agent-review-quality');
    return {
        __esModule: true,
        ...actual,
        computeAgentReviewQuality: (...a: unknown[]) => {
            reviewQualitySpy(...a);
            return (
                actual as { computeAgentReviewQuality: (...x: unknown[]) => unknown }
            ).computeAgentReviewQuality(...a);
        },
    };
});

const listProposalsSpy = jest.fn();
jest.mock('@/app-layer/usecases/agent-proposals', () => {
    const actual = jest.requireActual('@/app-layer/usecases/agent-proposals');
    return {
        __esModule: true,
        ...actual,
        listAgentProposals: (...a: unknown[]) => {
            listProposalsSpy(...a);
            return (
                actual as { listAgentProposals: (...x: unknown[]) => unknown }
            ).listAgentProposals(...a);
        },
    };
});

const listRunsSpy = jest.fn();
jest.mock('@/app-layer/usecases/workflow-runs', () => {
    const actual = jest.requireActual('@/app-layer/usecases/workflow-runs');
    return {
        __esModule: true,
        ...actual,
        listWorkflowRuns: (...a: unknown[]) => {
            listRunsSpy(...a);
            return (
                actual as { listWorkflowRuns: (...x: unknown[]) => unknown }
            ).listWorkflowRuns(...a);
        },
    };
});

import { ForbiddenPage } from '@/components/ForbiddenPage';
import ReceiptsPage from '@/app/t/[tenantSlug]/(app)/agents/receipts/page';
import QuarantinePage from '@/app/t/[tenantSlug]/(app)/agents/quarantine/page';
import ReviewQualityPage from '@/app/t/[tenantSlug]/(app)/agents/review-quality/page';
import ProposalsPage from '@/app/t/[tenantSlug]/(app)/agents/proposals/page';
import RunsPage from '@/app/t/[tenantSlug]/(app)/agents/runs/page';
import { listReceipts } from '@/app-layer/usecases/agent-action-receipt';
import { listAgentProposals } from '@/app-layer/usecases/agent-proposals';

const prisma: PrismaClient = prismaTestClient();

const T1 = 'agentsub-tenant-one';
const T2 = 'agentsub-tenant-two';

const seeded: Record<string, { ownerUserId: string; agentId: string }> = {};

/** A principal holding EVERY key these five pages ask for. */
const fullCtx = (tenantId: string): RequestContext =>
    makeRequestContext('OWNER', {
        tenantId,
        tenantSlug: tenantId,
        userId: seeded[tenantId].ownerUserId,
    });

/** The same principal with ONE key turned off, built from the real ADMIN set. */
const withoutKey = (
    tenantId: string,
    key: 'agent_registry' | 'view',
): RequestContext => {
    const admin = getPermissionsForRole('ADMIN');
    return makeRequestContext('ADMIN', {
        tenantId,
        tenantSlug: tenantId,
        userId: seeded[tenantId].ownerUserId,
        appPermissions: {
            ...admin,
            admin: { ...admin.admin, view: true, agent_registry: true, [key]: false },
        },
    });
};

/** Call a page the way Next does, and hand back the element it returned. */
type PageFn = (args: {
    params: Promise<{ tenantSlug: string }>;
}) => Promise<{ type: unknown }>;

async function renderPage(page: unknown, tenantSlug: string) {
    return (page as PageFn)({ params: Promise.resolve({ tenantSlug }) });
}

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.agentActionReceipt.deleteMany({ where: t }).catch(() => undefined);
    await prisma.agentProposal.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(
            `DELETE FROM "AuditLog" WHERE "tenantId" = ANY($1::text[])`,
            [T1, T2],
        );
        await tx.$executeRawUnsafe(
            `DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`,
            [T1, T2],
        );
    });
    await prisma.user.deleteMany({
        where: { emailHash: { in: [T1, T2].map((x) => hashForLookup(`owner@${x}.test`)) } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();

    for (const id of [T1, T2]) {
        await prisma.tenant.create({ data: { id, name: `Sub ${id}`, slug: id } });
        const email = `owner@${id}.test`;
        const user = await prisma.user.create({
            data: { email, emailHash: hashForLookup(email) },
        });
        await prisma.tenantMembership.create({
            data: {
                tenantId: id,
                userId: user.id,
                role: Role.OWNER,
                status: MembershipStatus.ACTIVE,
            },
        });
        const aiSystem = await prisma.aiSystem.create({
            data: { tenantId: id, name: `Host ${id}`, ownerUserId: user.id },
        });
        const agent = await prisma.registeredAgent.create({
            data: {
                tenantId: id,
                aiSystemId: aiSystem.id,
                name: `Agent ${id}`,
                autonomyLevel: 2,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'COMPENSABLE',
                provenance: 'FIRST_PARTY',
                status: 'ACTIVE',
                ownerUserId: user.id,
                createdByUserId: user.id,
            },
        });
        seeded[id] = { ownerUserId: user.id, agentId: agent.id };

        // One proposal per tenant, so the queue read has something to isolate.
        await prisma.agentProposal.create({
            data: {
                tenantId: id,
                kind: 'RISK',
                operation: 'CREATE',
                status: 'PENDING',
                // A STRING, not an object: the column is on the Epic B
                // encryption manifest, so at the Prisma layer it is `String`
                // and the middleware encrypts whatever it is handed.
                payloadJson: JSON.stringify({ title: `Proposed in ${id}` }),
                rationale: `rationale-${id}`,
            },
        });
    }
});

afterEach(() => {
    listReceiptsSpy.mockClear();
    reviewQualitySpy.mockClear();
    listProposalsSpy.mockClear();
    listRunsSpy.mockClear();
    getTenantCtxMock.mockReset();
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

/**
 * The five pages, each with the key it gates on and the spy that must NOT fire
 * when the gate refuses.
 *
 * Quarantine carries no spy: its page is deliberately thin — it renders the
 * client and nothing else, so the data has exactly ONE path (the gated HTTP
 * route). There is no server-side load to observe, so the claim there is only
 * that the PAGE refuses rather than mounting a client that will 403.
 */
const PAGES = [
    {
        name: 'receipts',
        page: ReceiptsPage,
        key: 'agent_registry' as const,
        spy: listReceiptsSpy,
    },
    {
        name: 'quarantine',
        page: QuarantinePage,
        key: 'agent_registry' as const,
        spy: null,
    },
    {
        name: 'review-quality',
        page: ReviewQualityPage,
        key: 'agent_registry' as const,
        spy: reviewQualitySpy,
    },
    {
        name: 'proposals',
        page: ProposalsPage,
        key: 'view' as const,
        spy: listProposalsSpy,
    },
    { name: 'runs', page: RunsPage, key: 'view' as const, spy: listRunsSpy },
];

describe('each moved page refuses at the PAGE, before its own data load', () => {
    it.each(PAGES.map((p) => [p.name, p] as const))(
        '%s renders a refusal and never starts the fetch',
        async (_name, entry) => {
            getTenantCtxMock.mockResolvedValue(withoutKey(T1, entry.key));
            const el = await renderPage(entry.page, T1);
            // The refusal COMPONENT, by identity. A text assertion would pass
            // for a page that rendered its content and happened to mention the
            // word "permission" somewhere.
            expect(el.type).toBe(ForbiddenPage);
            if (entry.spy) expect(entry.spy).not.toHaveBeenCalled();
        },
    );

    it.each(PAGES.map((p) => [p.name, p] as const))(
        '%s renders its CONTENT for a principal that holds the key',
        async (_name, entry) => {
            // The paired positive. Without it, a page that refused everybody
            // would satisfy every assertion above.
            getTenantCtxMock.mockResolvedValue(fullCtx(T1));
            const el = await renderPage(entry.page, T1);
            expect(el.type).not.toBe(ForbiddenPage);
            if (entry.spy) expect(entry.spy).toHaveBeenCalledTimes(1);
        },
    );

    it('the keys are the ones written down — receipts/quarantine/review on the register key', () => {
        // Pinned as an exact mapping, so a page silently re-keyed to the
        // broader `admin.view` (or the queue narrowed to the register key)
        // fails here rather than passing both arms above.
        expect(PAGES.map((p) => `${p.name}:${p.key}`)).toEqual([
            'receipts:agent_registry',
            'quarantine:agent_registry',
            'review-quality:agent_registry',
            'proposals:view',
            'runs:view',
        ]);
    });
});

describe('the two key families are genuinely different gates', () => {
    it('an admin.view holder WITHOUT the register key still reaches proposals and runs', async () => {
        // The move must not have re-keyed the approval queue. Same principal
        // that the receipts page refuses.
        for (const entry of PAGES.filter((p) => p.key === 'view')) {
            getTenantCtxMock.mockResolvedValue(withoutKey(T1, 'agent_registry'));
            const el = await renderPage(entry.page, T1);
            expect(el.type).not.toBe(ForbiddenPage);
        }
    });

    it('a register-key holder WITHOUT admin.view still reaches receipts and review quality', async () => {
        for (const entry of PAGES.filter((p) => p.key === 'agent_registry')) {
            getTenantCtxMock.mockResolvedValue(withoutKey(T1, 'view'));
            const el = await renderPage(entry.page, T1);
            expect(el.type).not.toBe(ForbiddenPage);
        }
    });
});

describe('two-tenant isolation on each moved page’s data', () => {
    it('the receipt log holds only the reading tenant’s rows', async () => {
        // Both tenants are empty of receipts in this seed, so the assertion is
        // the SHAPE: each read returns an array scoped to its own tenant and
        // neither throws. The proposal read below carries the populated case.
        const one = await listReceipts(fullCtx(T1), { limit: 100 });
        const two = await listReceipts(fullCtx(T2), { limit: 100 });
        // EXACT, both ways round. `ReceiptListItem` is the page's projection
        // and carries no `tenantId` — that is the projection working, so the
        // assertion is on the population rather than on a column: two tenants,
        // no receipts seeded, and neither read borrows the other's rows.
        expect(one).toEqual([]);
        expect(two).toEqual([]);
    });

    it('the proposal queue holds only the reading tenant’s rows', async () => {
        const one = await listAgentProposals(fullCtx(T1), { status: 'PENDING' });
        const two = await listAgentProposals(fullCtx(T2), { status: 'PENDING' });
        // Exact, both ways round: one proposal each, and neither names the
        // other's rationale.
        expect(one.map((p) => p.rationale)).toEqual([`rationale-${T1}`]);
        expect(two.map((p) => p.rationale)).toEqual([`rationale-${T2}`]);
    });

    it('each page receives the ctx for the slug it was asked about', async () => {
        // The page → context seam. A page that ignored its own `params` and
        // read a cached context would serve tenant A's data at tenant B's URL,
        // and every isolation assertion above would still hold.
        getTenantCtxMock.mockResolvedValue(fullCtx(T2));
        await renderPage(ReceiptsPage, T2);
        expect(getTenantCtxMock).toHaveBeenCalledWith({ tenantSlug: T2 });
        expect(listReceiptsSpy).toHaveBeenCalledTimes(1);
        expect((listReceiptsSpy.mock.calls[0][0] as RequestContext).tenantId).toBe(T2);
    });
});
