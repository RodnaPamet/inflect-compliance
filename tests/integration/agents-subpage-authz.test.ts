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

/**
 * The runs page reads the session's own role and `memberships[]` claim to ask
 * the edge whether its caller may load the discovered-agent picker (#4472).
 * `getServerSession` needs a request scope a test does not have, so it answers
 * "no session": the page then offers no picker, which none of these tests is
 * about. Everything else in `next-auth` stays real.
 */
jest.mock('next-auth', () => ({
    __esModule: true,
    ...jest.requireActual('next-auth'),
    getServerSession: jest.fn(async () => null),
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

const packSpy = jest.fn();
jest.mock('@/app-layer/usecases/agent-governance-reports', () => {
    const actual = jest.requireActual('@/app-layer/usecases/agent-governance-reports');
    return {
        __esModule: true,
        ...actual,
        buildAgentGovernancePack: (...a: unknown[]) => {
            packSpy(...a);
            return (
                actual as { buildAgentGovernancePack: (...x: unknown[]) => unknown }
            ).buildAgentGovernancePack(...a);
        },
    };
});

const harnessSpy = jest.fn();
const keysSpy = jest.fn();
jest.mock('@/app-layer/usecases/agent-harness-matrix', () => {
    const actual = jest.requireActual('@/app-layer/usecases/agent-harness-matrix') as Record<
        'getHarnessMatrix' | 'getHarnessScannerKeysView',
        (...x: unknown[]) => unknown
    >;
    return {
        __esModule: true,
        ...actual,
        getHarnessMatrix: (...a: unknown[]) => {
            harnessSpy(...a);
            return actual.getHarnessMatrix(...a);
        },
        getHarnessScannerKeysView: (...a: unknown[]) => {
            keysSpy(...a);
            return actual.getHarnessScannerKeysView(...a);
        },
    };
});

import { ForbiddenPage } from '@/components/ForbiddenPage';
import ReceiptsPage from '@/app/t/[tenantSlug]/(app)/agents/receipts/page';
import QuarantinePage from '@/app/t/[tenantSlug]/(app)/agents/quarantine/page';
import ReviewQualityPage from '@/app/t/[tenantSlug]/(app)/agents/review-quality/page';
import ProposalsPage from '@/app/t/[tenantSlug]/(app)/agents/proposals/page';
import RunsPage from '@/app/t/[tenantSlug]/(app)/agents/runs/page';
import ReportsPage from '@/app/t/[tenantSlug]/(app)/agents/reports/page';
import { listReceipts } from '@/app-layer/usecases/agent-action-receipt';
import { listAgentProposals } from '@/app-layer/usecases/agent-proposals';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

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

type AdminKey = 'agent_registry' | 'agent_registry_view' | 'view';

/**
 * The same principal with the named keys turned off, built from the real ADMIN
 * set. A page whose gate admits EITHER of two keys (#3710) is refused only with
 * both off, so each page lists every key its gate reads.
 */
const withoutKeys = (tenantId: string, keys: readonly AdminKey[]): RequestContext => {
    const admin = getPermissionsForRole('ADMIN');
    const off = Object.fromEntries(keys.map((k) => [k, false]));
    return makeRequestContext('ADMIN', {
        tenantId,
        tenantSlug: tenantId,
        userId: seeded[tenantId].ownerUserId,
        appPermissions: {
            ...admin,
            admin: { ...admin.admin, view: true, agent_registry: true, agent_registry_view: true, ...off },
        },
    });
};

/** A built-in role, as `getTenantCtx` would resolve it. */
const asRole = (tenantId: string, role: 'AUDITOR' | 'AI_ADMIN'): RequestContext =>
    makeRequestContext(role, { tenantId, tenantSlug: tenantId, userId: seeded[tenantId].ownerUserId });

/** Call a page the way Next does, and hand back the element it returned. */
type PageFn = (args: {
    params: Promise<{ tenantSlug: string }>;
}) => Promise<{ type: unknown }>;

async function renderPage(page: unknown, tenantSlug: string) {
    return (page as PageFn)({ params: Promise.resolve({ tenantSlug }) });
}

/** The same call with the query string Next passes as `searchParams`. */
type TabbedPageFn = (args: {
    params: Promise<{ tenantSlug: string }>;
    searchParams: Promise<{ tab?: string | string[] }>;
}) => Promise<{ type: unknown; props: Record<string, unknown> }>;

async function renderPageWithQuery(page: unknown, tenantSlug: string, query: { tab?: string | string[] }) {
    return (page as TabbedPageFn)({ params: Promise.resolve({ tenantSlug }), searchParams: Promise.resolve(query) });
}

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.agentActionReceipt.deleteMany({ where: t }).catch(() => undefined);
    await prisma.agentProposal.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, [T1, T2]);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
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
    packSpy.mockClear();
    harnessSpy.mockClear();
    keysSpy.mockClear();
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
        keys: ['agent_registry'] as const,
        spy: listReceiptsSpy,
    },
    {
        name: 'quarantine',
        page: QuarantinePage,
        keys: ['agent_registry'] as const,
        spy: null,
    },
    {
        name: 'review-quality',
        page: ReviewQualityPage,
        keys: ['agent_registry'] as const,
        spy: reviewQualitySpy,
    },
    {
        name: 'proposals',
        page: ProposalsPage,
        // `admin.view` OR the inventory view key (#3710).
        keys: ['view', 'agent_registry_view'] as const,
        spy: listProposalsSpy,
    },
    { name: 'runs', page: RunsPage, keys: ['view', 'agent_registry_view'] as const, spy: listRunsSpy },
    {
        // AGENTIC UI 4/4. The pack NAMES PEOPLE — who approved what, who owns
        // which agent — so it sits on the register key rather than the narrower
        // tool-exposure key an operations team routinely holds. And the spy
        // matters more here than on any other row: this page's load is five
        // reports over the whole register, so a gate that refused only after
        // loading would have run the most expensive read in the subsystem on
        // behalf of somebody it then refused.
        name: 'reports',
        page: ReportsPage,
        // The inventory read (#3710): the view key OR the register key.
        keys: ['agent_registry_view', 'agent_registry'] as const,
        spy: packSpy,
    },
];

describe('each moved page refuses at the PAGE, before its own data load', () => {
    it.each(PAGES.map((p) => [p.name, p] as const))(
        '%s renders a refusal and never starts the fetch',
        async (_name, entry) => {
            getTenantCtxMock.mockResolvedValue(withoutKeys(T1, entry.keys));
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
        expect(PAGES.map((p) => `${p.name}:${p.keys.join('|')}`)).toEqual([
            'receipts:agent_registry',
            'quarantine:agent_registry',
            'review-quality:agent_registry',
            'proposals:view|agent_registry_view',
            'runs:view|agent_registry_view',
            'reports:agent_registry_view|agent_registry',
        ]);
    });
});

describe('the reports page’s export offer is a SEPARATE grant (#2467)', () => {
    /**
     * Holding the page is not holding the button. Filing the pack writes into
     * the evidence library, which is the library's grant to give — so an
     * assessor-facing reader can legitimately read every figure here and still
     * be unable to file them.
     *
     * Asserted on the PROP rather than on rendered text: the button's label is
     * translated copy that will change, and the question is which permission
     * the server decided on.
     */
    const withEvidenceEdit = (tenantId: string, edit: boolean): RequestContext => {
        const admin = getPermissionsForRole('ADMIN');
        return makeRequestContext('ADMIN', {
            tenantId,
            tenantSlug: tenantId,
            userId: seeded[tenantId].ownerUserId,
            appPermissions: {
                ...admin,
                evidence: { ...admin.evidence, edit },
            },
        });
    };

    it('offers the export to a principal holding evidence.edit', async () => {
        getTenantCtxMock.mockResolvedValue(withEvidenceEdit(T1, true));
        const el = await renderPage(ReportsPage, T1);
        expect(el.type).not.toBe(ForbiddenPage);
        expect((el as unknown as { props: { canExport: boolean } }).props.canExport).toBe(true);
    });

    it('withholds it from a principal who may read the pack but not write evidence', async () => {
        getTenantCtxMock.mockResolvedValue(withEvidenceEdit(T1, false));
        const el = await renderPage(ReportsPage, T1);
        // Still the PAGE, not a refusal: losing the evidence key must not cost
        // them the report. Hidden rather than shown-and-refused, because an
        // action that always 403s is a defect report waiting to be filed
        // against a working permission model.
        expect(el.type).not.toBe(ForbiddenPage);
        expect((el as unknown as { props: { canExport: boolean } }).props.canExport).toBe(false);
    });
});

describe('the reports page’s harness tab sits behind the SAME gate, and reads only itself (#3687)', () => {
    it('a refused caller asking for the harness tab gets the refusal, and neither read starts', async () => {
        getTenantCtxMock.mockResolvedValue(withoutKeys(T1, ['agent_registry', 'agent_registry_view']));
        const el = await renderPageWithQuery(ReportsPage, T1, { tab: 'harness' });
        expect(el.type).toBe(ForbiddenPage);
        expect(harnessSpy).not.toHaveBeenCalled();
        expect(keysSpy).not.toHaveBeenCalled();
        expect(packSpy).not.toHaveBeenCalled();
    });

    it('?tab=harness renders the harness tab, reads the matrix once, and never builds the pack', async () => {
        getTenantCtxMock.mockResolvedValue(fullCtx(T1));
        const el = await renderPageWithQuery(ReportsPage, T1, { tab: 'harness' });
        expect(el.type).not.toBe(ForbiddenPage);
        expect(el.props.tab).toBe('harness');
        expect(harnessSpy).toHaveBeenCalledTimes(1);
        expect((harnessSpy.mock.calls[0][0] as RequestContext).tenantId).toBe(T1);
        // The key register travels with the tab, read for the same tenant.
        expect(keysSpy).toHaveBeenCalledTimes(1);
        expect((keysSpy.mock.calls[0][0] as RequestContext).tenantId).toBe(T1);
        expect(el.props.scannerKeys).toEqual(expect.objectContaining({ keys: expect.any(Object) }));
        expect(packSpy).not.toHaveBeenCalled();
        // The same header grants travel with either tab.
        expect(el.props.canInvestigate).toBe(true);
    });

    it.each([
        ['no query at all', {}],
        ['an unknown tab', { tab: 'nonsense' }],
        ['the pack tab by name', { tab: 'pack' }],
    ])('%s is the pack, and never reads a scan', async (_label, query) => {
        getTenantCtxMock.mockResolvedValue(fullCtx(T1));
        const el = await renderPageWithQuery(ReportsPage, T1, query);
        expect(el.props.tab).toBeUndefined();
        expect(packSpy).toHaveBeenCalledTimes(1);
        expect(harnessSpy).not.toHaveBeenCalled();
        expect(keysSpy).not.toHaveBeenCalled();
    });
});

/** Whether a page's key list names `key` (the lists are const tuples of different members). */
const names = (keys: readonly string[], key: string): boolean => keys.includes(key);

describe('the two key families are genuinely different gates', () => {
    it('an admin.view holder WITHOUT either inventory key still reaches proposals and runs', async () => {
        // The move must not have re-keyed the approval queue. Same principal
        // that the receipts page refuses.
        for (const entry of PAGES.filter((p) => names(p.keys, 'view'))) {
            getTenantCtxMock.mockResolvedValue(withoutKeys(T1, ['agent_registry', 'agent_registry_view']));
            const el = await renderPage(entry.page, T1);
            expect(el.type).not.toBe(ForbiddenPage);
        }
    });

    it('a register-key holder WITHOUT admin.view still reaches receipts, review quality and the pack', async () => {
        for (const entry of PAGES.filter((p) => names(p.keys, 'agent_registry'))) {
            getTenantCtxMock.mockResolvedValue(withoutKeys(T1, ['view', 'agent_registry_view']));
            const el = await renderPage(entry.page, T1);
            expect(el.type).not.toBe(ForbiddenPage);
        }
    });
});

describe('the inventory view key opens runs, proposals and the pack, read-only (#3710)', () => {
    const OPENS = ['proposals', 'runs', 'reports'];

    it.each(['AUDITOR', 'AI_ADMIN'] as const)('%s reaches proposals, runs and the pack', async (role) => {
        for (const entry of PAGES.filter((p) => OPENS.includes(p.name))) {
            getTenantCtxMock.mockResolvedValue(asRole(T1, role));
            const el = await renderPage(entry.page, T1);
            expect({ page: entry.name, refused: el.type === ForbiddenPage }).toEqual({ page: entry.name, refused: false });
        }
    });

    it('AUDITOR is refused the register-key surfaces it does not hold', async () => {
        for (const entry of PAGES.filter((p) => !OPENS.includes(p.name))) {
            getTenantCtxMock.mockResolvedValue(asRole(T1, 'AUDITOR'));
            const el = await renderPage(entry.page, T1);
            expect({ page: entry.name, refused: el.type === ForbiddenPage }).toEqual({ page: entry.name, refused: true });
        }
    });

    it.each(['AUDITOR', 'AI_ADMIN'] as const)('%s is offered no write on any of them', async (role) => {
        for (const page of [ProposalsPage, RunsPage]) {
            getTenantCtxMock.mockResolvedValue(asRole(T1, role));
            const el = (await renderPage(page, T1)) as unknown as { props: Record<string, unknown> };
            // Approve, reject, start, resume and abort all ask this.
            expect(el.props.canOperate).toBe(false);
            // The compose link asks `admin.view`, which neither holds.
            expect(el.props.canCompose).toBe(false);
        }
        getTenantCtxMock.mockResolvedValue(asRole(T1, role));
        const pack = (await renderPage(ReportsPage, T1)) as unknown as { props: Record<string, unknown> };
        expect(pack.props.canExport).toBe(false);
    });

    it('the menus a view-key reader sees do not link it to a page that would refuse it', async () => {
        getTenantCtxMock.mockResolvedValue(asRole(T1, 'AUDITOR'));
        const el = (await renderPage(ProposalsPage, T1)) as unknown as { props: Record<string, unknown> };
        expect(el.props.canInvestigate).toBe(false);
        expect(el.props.canReadReports).toBe(true);
    });

    it('an AUDITOR on the harness tab gets the matrix and not the scanner-key register', async () => {
        getTenantCtxMock.mockResolvedValue(asRole(T1, 'AUDITOR'));
        const el = await renderPageWithQuery(ReportsPage, T1, { tab: 'harness' });
        expect(el.type).not.toBe(ForbiddenPage);
        expect(harnessSpy).toHaveBeenCalledTimes(1);
        expect(keysSpy).not.toHaveBeenCalled();
        expect(el.props.scannerKeys).toBeNull();
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
