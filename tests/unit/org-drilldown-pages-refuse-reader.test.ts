/**
 * #4845 — each drill-down page answers an organization Reader with the org
 * forbidden page, and never calls its read; an Admin gets the table.
 */
import type { OrgContext } from '@/app-layer/types';
import { getOrgPermissions } from '@/lib/permissions';

let currentCtx: OrgContext;
jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getOrgCtx: async () => currentCtx,
}));

const reads = {
    listNonPerformingControls: jest.fn(async () => ({ rows: [], nextCursor: null })),
    listCriticalRisksAcrossOrg: jest.fn(async () => ({ rows: [], nextCursor: null })),
    listOverdueEvidenceAcrossOrg: jest.fn(async () => ({ rows: [], nextCursor: null })),
};
jest.mock('@/app-layer/usecases/portfolio', () => ({
    __esModule: true,
    listNonPerformingControls: () => reads.listNonPerformingControls(),
    listCriticalRisksAcrossOrg: () => reads.listCriticalRisksAcrossOrg(),
    listOverdueEvidenceAcrossOrg: () => reads.listOverdueEvidenceAcrossOrg(),
}));

jest.mock('next-intl/server', () => ({
    __esModule: true,
    getTranslations: async (ns: string) => (key: string) => `${ns}.${key}`,
}));

// The client tables are not under test; stand-ins keep the import graph small.
jest.mock('@/app/org/[orgSlug]/(app)/controls/ControlsTable', () => ({ ControlsTable: () => null }));
jest.mock('@/app/org/[orgSlug]/(app)/risks/RisksTable', () => ({ RisksTable: () => null }));
jest.mock('@/app/org/[orgSlug]/(app)/evidence/EvidenceTable', () => ({ EvidenceTable: () => null }));

import ControlsPage from '@/app/org/[orgSlug]/(app)/controls/page';
import RisksPage from '@/app/org/[orgSlug]/(app)/risks/page';
import EvidencePage from '@/app/org/[orgSlug]/(app)/evidence/page';
import { OrgForbiddenPage } from '@/app/org/[orgSlug]/(app)/_components/OrgForbiddenPage';

function ctxAs(orgRole: 'ORG_ADMIN' | 'ORG_READER'): OrgContext {
    return {
        requestId: 'r',
        userId: 'u-1',
        organizationId: 'org-1',
        orgSlug: 'acme',
        orgRole,
        permissions: getOrgPermissions(orgRole),
    };
}

const props = { params: Promise.resolve({ orgSlug: 'acme' }), searchParams: Promise.resolve({}) };

const PAGES = [
    ['controls', ControlsPage, 'listNonPerformingControls'],
    ['risks', RisksPage, 'listCriticalRisksAcrossOrg'],
    ['evidence', EvidencePage, 'listOverdueEvidenceAcrossOrg'],
] as const;

beforeEach(() => Object.values(reads).forEach((r) => r.mockClear()));

describe.each(PAGES)('/org/<slug>/%s', (_route, Page, read) => {
    it('gives a Reader the forbidden page and reads nothing', async () => {
        currentCtx = ctxAs('ORG_READER');
        const el = (await Page(props)) as { type: unknown; props: { orgSlug: string; message: string } };
        expect(el.type).toBe(OrgForbiddenPage);
        expect(el.props).toEqual({ orgSlug: 'acme', message: 'org.forbidden.drillDown' });
        expect(reads[read]).not.toHaveBeenCalled();
    });

    it('reads the list for an Admin', async () => {
        currentCtx = ctxAs('ORG_ADMIN');
        const el = (await Page(props)) as { type: unknown };
        expect(el.type).not.toBe(OrgForbiddenPage);
        expect(reads[read]).toHaveBeenCalledTimes(1);
    });
});
