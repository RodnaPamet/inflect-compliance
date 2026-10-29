/**
 * The dashboard server page's per-viewer gates (#4458).
 *
 *   - Recent Activity is the audit log's head, so it is shown only to a role
 *     that can read the audit log — Owner, Admin, Auditor (owner decision,
 *     2026-10-29). For any other role the page renders no card, so its rows
 *     are never fetched: the card is the only caller of the read.
 *   - The "Quick add" links are offered only to a viewer the create routes
 *     would accept.
 *
 * The page is an async server component; it is called directly and the
 * element tree it returns is inspected, which is exactly what reaches the
 * client.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

import type { RequestContext } from '@/app-layer/types';
import { makeRequestContext } from '../helpers/make-context';

const mockRecentActivity = jest.fn<Promise<unknown[]>, [RequestContext]>(async () => []);
jest.mock('@/app-layer/usecases/dashboard', () => ({
    getExecutiveDashboard: jest.fn(async () => ({ stub: 'exec' })),
    getDashboardRecentActivity: (ctx: RequestContext) => mockRecentActivity(ctx),
}));

let mockCtx: RequestContext;
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: jest.fn(async () => mockCtx),
}));
jest.mock('@/lib/cache/ssr-cache', () => ({
    cachedSsrPayload: async ({ compute }: { compute: () => Promise<unknown> }) => compute(),
}));
jest.mock('@/app-layer/usecases/compliance-trends', () => ({
    getComplianceTrends: jest.fn(async () => null),
}));
jest.mock('@/app-layer/usecases/compliance-posture', () => ({
    getLatestPostureSummary: jest.fn(async () => null),
    toPostureDto: () => null,
}));
jest.mock('next-intl/server', () => ({
    getTranslations: async () => (key: string) => key,
}));
jest.mock('@/app/t/[tenantSlug]/(app)/dashboard/DashboardClient', () => ({
    __esModule: true,
    default: function DashboardClient() {
        return null;
    },
}));
jest.mock('@/app/t/[tenantSlug]/(app)/dashboard/AgenticGovernanceCard', () => ({
    __esModule: true,
    default: function AgenticGovernanceCard() {
        return null;
    },
}));

import DashboardPage from '@/app/t/[tenantSlug]/(app)/dashboard/page';
import RecentActivityCard from '@/app/t/[tenantSlug]/(app)/dashboard/RecentActivityCard';

type AnyElement = React.ReactElement<Record<string, unknown>>;

/** Every element of `type` anywhere under `node`, through `children`. */
function findAll(node: unknown, type: unknown): AnyElement[] {
    if (!React.isValidElement(node)) {
        return Array.isArray(node) ? node.flatMap((n) => findAll(n, type)) : [];
    }
    const el = node as AnyElement;
    const here = el.type === type ? [el] : [];
    return [...here, ...findAll(el.props.children, type)];
}

async function renderPageFor(role: string): Promise<AnyElement> {
    mockCtx = makeRequestContext(role, { tenantSlug: 'acme' });
    return (await DashboardPage({
        params: Promise.resolve({ tenantSlug: 'acme' }),
    })) as AnyElement;
}

beforeEach(() => {
    mockRecentActivity.mockClear();
});

describe('Recent Activity is shown only to roles that can read the audit log', () => {
    it('an Auditor gets the card, and the card reads the feed', async () => {
        const page = await renderPageFor('AUDITOR');
        const cards = findAll(page, RecentActivityCard);
        expect(cards).toHaveLength(1);

        // Evaluate the card as the server would: it reads through the
        // audit-gated usecase, with the viewer's own context.
        const card = await (RecentActivityCard as unknown as (p: unknown) => Promise<React.ReactElement>)(
            cards[0].props,
        );
        expect(mockRecentActivity).toHaveBeenCalledTimes(1);
        expect(mockRecentActivity).toHaveBeenCalledWith(
            expect.objectContaining({ role: 'AUDITOR' }),
        );

        // The card is an Auditor's way to the full log: the sidebar gear and
        // the Admin landing page both need `admin.view`, which they lack.
        render(card);
        expect(screen.getByRole('link', { name: 'viewAuditLog' }).getAttribute('href')).toBe(
            `/t/${cards[0].props.tenantSlug as string}/admin/audit-log`,
        );
    });

    it('a Reader gets no card, so nothing reads the feed', async () => {
        const page = await renderPageFor('READER');
        expect(findAll(page, RecentActivityCard)).toHaveLength(0);
        expect(page.props.children ?? null).toBeNull();
        expect(mockRecentActivity).not.toHaveBeenCalled();
    });

    it.each(['OWNER', 'ADMIN'])('%s gets the card', async (role) => {
        expect(findAll(await renderPageFor(role), RecentActivityCard)).toHaveLength(1);
    });

    it.each(['EDITOR', 'AI_ADMIN'])('%s gets no card', async (role) => {
        expect(findAll(await renderPageFor(role), RecentActivityCard)).toHaveLength(0);
    });
});

describe('Quick-add links follow the create routes', () => {
    it('an Editor may add a risk, evidence and a policy', async () => {
        const page = await renderPageFor('EDITOR');
        expect(page.props.quickAdds).toEqual({ risk: true, evidence: true, policy: true });
    });

    it.each(['READER', 'AUDITOR', 'AI_ADMIN'])('%s is offered none', async (role) => {
        const page = await renderPageFor(role);
        expect(page.props.quickAdds).toEqual({ risk: false, evidence: false, policy: false });
    });
});
