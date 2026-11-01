/**
 * #4849 — the org audit page tells a Reader who reads the log, with the org
 * forbidden page, instead of throwing into the root error boundary. An admin
 * gets the table and the first page of entries.
 */
import type { OrgContext } from '@/app-layer/types';
import { getOrgPermissions } from '@/lib/permissions';

let currentCtx: OrgContext;
jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getOrgCtx: async () => currentCtx,
}));

const listOrgAudit = jest.fn(async () => ({ rows: [], nextCursor: null }));
jest.mock('@/app-layer/usecases/org-audit', () => ({
    __esModule: true,
    listOrgAudit: (...a: unknown[]) => listOrgAudit(...(a as [])),
}));

jest.mock('next-intl/server', () => ({
    __esModule: true,
    getTranslations: async (ns: string) => (key: string) => `${ns}.${key}`,
}));

jest.mock('@/app/org/[orgSlug]/(app)/audit/AuditLogTable', () => ({ AuditLogTable: () => null }));

import OrgAuditPage from '@/app/org/[orgSlug]/(app)/audit/page';
import { OrgForbiddenPage } from '@/app/org/[orgSlug]/(app)/_components/OrgForbiddenPage';
import { AuditLogTable } from '@/app/org/[orgSlug]/(app)/audit/AuditLogTable';

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

const props = { params: Promise.resolve({ orgSlug: 'acme' }) };

beforeEach(() => listOrgAudit.mockClear());

it('a Reader is told who reads the log, and nothing is read', async () => {
    currentCtx = ctxAs('ORG_READER');
    const el = (await OrgAuditPage(props)) as { type: unknown; props: { orgSlug: string; message: string } };
    expect(el.type).toBe(OrgForbiddenPage);
    expect(el.props).toEqual({ orgSlug: 'acme', message: 'org.audit.forbiddenMessage' });
    expect(listOrgAudit).not.toHaveBeenCalled();
});

it('an admin gets the log', async () => {
    currentCtx = ctxAs('ORG_ADMIN');
    const el = (await OrgAuditPage(props)) as { type: unknown };
    expect(el.type).toBe(AuditLogTable);
    expect(listOrgAudit).toHaveBeenCalledTimes(1);
});
