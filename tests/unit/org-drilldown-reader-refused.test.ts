/**
 * #4845 — an organization Reader holds the portfolio summary only. The three
 * cross-workspace lists (Non-Performing Controls, Critical Risks, Overdue
 * Evidence) name items inside the workspaces, so a Reader is refused them:
 * by the usecase, before any workspace is read, and by each page, which
 * answers with the org forbidden page instead of calling the read at all.
 *
 * The usecase is the gate that matters. `withTenantDb` binds the workspace id
 * and nothing else, so row-level security would admit the Reader.
 */
const getOrgTenantIdsMock = jest.fn();
const withTenantDbMock = jest.fn();

jest.mock('@/app-layer/repositories/PortfolioRepository', () => ({
    __esModule: true,
    PortfolioRepository: { getOrgTenantIds: (...a: unknown[]) => getOrgTenantIdsMock(...a) },
}));
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    withTenantDb: (...a: unknown[]) => withTenantDbMock(...a),
}));

import {
    listNonPerformingControls,
    listCriticalRisksAcrossOrg,
    listOverdueEvidenceAcrossOrg,
} from '@/app-layer/usecases/portfolio';
import { getOrgPermissions } from '@/lib/permissions';
import type { OrgContext } from '@/app-layer/types';

function ctxAs(orgRole: 'ORG_OWNER' | 'ORG_ADMIN' | 'ORG_READER'): OrgContext {
    return {
        requestId: 'req-test',
        userId: 'caller-1',
        organizationId: 'org-1',
        orgSlug: 'acme-org',
        orgRole,
        permissions: getOrgPermissions(orgRole),
    };
}

beforeEach(() => {
    getOrgTenantIdsMock.mockReset().mockResolvedValue([]);
    withTenantDbMock.mockReset();
});

describe.each([
    ['listNonPerformingControls', listNonPerformingControls],
    ['listCriticalRisksAcrossOrg', listCriticalRisksAcrossOrg],
    ['listOverdueEvidenceAcrossOrg', listOverdueEvidenceAcrossOrg],
])('%s', (_name, read) => {
    it('refuses a Reader before reading any workspace', async () => {
        await expect(read(ctxAs('ORG_READER'))).rejects.toThrow(/owners and admins/);
        expect(getOrgTenantIdsMock).not.toHaveBeenCalled();
        expect(withTenantDbMock).not.toHaveBeenCalled();
    });

    it.each(['ORG_ADMIN', 'ORG_OWNER'] as const)('serves an %s', async (role) => {
        await expect(read(ctxAs(role))).resolves.toEqual({ rows: [], nextCursor: null });
    });
});
