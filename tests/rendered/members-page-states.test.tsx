/**
 * The members page in the states its help guide describes (#4118):
 *
 *   - a FAILED load shows an error state with the server's reason, never
 *     "No members yet" — an empty table under a failed load reads as "this
 *     workspace has no members";
 *   - the back link and breadcrumb render once the page has loaded, not only
 *     while it loads;
 *   - the bulk Deactivate confirmation describes deactivating, not the bar's
 *     default "removes the selected members";
 *   - a refused role save re-reads the members, so a row never shows a state
 *     the server does not hold.
 *
 * `next-intl` is the repo's manual mock with ONE `t` per namespace, as the real
 * library returns: the manual mock mints a new function per render, which
 * re-creates the page's fetch callback and refetches on every render, and a
 * test counting requests would be counting that loop.
 */
import * as React from 'react';
import { render, fireEvent, screen, waitFor, within } from '@testing-library/react';

jest.mock('next-intl', () => {
    const manual = jest.requireActual('../../__mocks__/next-intl.js');
    const cache = new Map<string, unknown>();
    return {
        ...manual,
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) cache.set(ns, manual.useTranslations(ns));
            return cache.get(ns);
        },
    };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/members',
    useSearchParams: () => new URLSearchParams(),
}));

import MembersAdminPage from '@/app/t/[tenantSlug]/(app)/admin/members/page';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getPermissionsForRole } from '@/lib/permissions';

const en = require('../../messages/en.json');
const M = en.admin.members;

const member = (id: string, role: string) => ({
    id,
    userId: `u-${id}`,
    role,
    customRoleId: null,
    customRole: null,
    status: 'ACTIVE',
    invitedAt: null,
    deactivatedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    user: { id: `u-${id}`, name: `Person ${id}`, email: `${id}@example.com`, image: null, createdAt: '2026-01-01' },
    invitedBy: null,
    activeSessionCount: 0,
});

const MEMBERS = [member('m-reader', 'READER'), member('m-editor', 'EDITOR')];

type Answer = { ok: boolean; status: number; body: unknown };
const ok = (body: unknown): Answer => ({ ok: true, status: 200, body });

function mount(answers: { members?: Answer | 'network-error'; patch?: Answer } = {}) {
    global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        let a: Answer = ok([]);
        if (init?.method === 'PATCH') a = answers.patch ?? ok({});
        else if (u.endsWith('/admin/roles')) a = ok([{ id: 'cr-1', name: 'Reviewers', baseRole: 'READER', isActive: true }]);
        else if (u.endsWith('/admin/members')) {
            if (answers.members === 'network-error') throw new TypeError('Failed to fetch');
            a = answers.members ?? ok(MEMBERS);
        }
        return { ok: a.ok, status: a.status, json: async () => a.body } as unknown as Response;
    }) as unknown as typeof fetch;
    render(
        <TooltipProvider>
            <TenantProvider
                value={{
                    userId: 'viewer',
                    tenantId: 'tenant-1',
                    tenantSlug: 'acme',
                    tenantName: 'Acme',
                    role: 'ADMIN',
                    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
                    appPermissions: getPermissionsForRole('ADMIN'),
                    modules: { processCanvas: false },
                }}
            >
                <MembersAdminPage />
            </TenantProvider>
        </TooltipProvider>,
    );
}

const byId = (id: string) => document.getElementById(id);
const memberListReads = () =>
    (global.fetch as jest.Mock).mock.calls.filter(
        ([u, init]) => String(u).endsWith('/admin/members') && !(init as RequestInit | undefined)?.method,
    ).length;

describe('members page — a failed load', () => {
    it("shows an error state with the server's reason, and never \"No members yet\"", async () => {
        mount({
            members: {
                ok: false,
                status: 503,
                body: { error: { code: 'SERVICE_UNAVAILABLE', message: 'The database is not answering.' } },
            },
        });
        const state = await screen.findByTestId('members-load-error');
        expect(state).toHaveTextContent(M.failedLoadMembers);
        expect(state).toHaveTextContent('The database is not answering.');
        expect(screen.queryByText(M.noMembersTitle)).toBeNull();
        // No "0 active members" over a list that did not load.
        expect(screen.queryByText(/active member/i)).toBeNull();
    });

    it('a network failure shows the same state, with the page fallback', async () => {
        mount({ members: 'network-error' });
        const state = await screen.findByTestId('members-load-error');
        expect(state).toHaveTextContent(M.failedLoadMembers);
        expect(screen.queryByText(M.noMembersTitle)).toBeNull();
    });

    it('Try again reloads, and a successful reload shows the table', async () => {
        mount({ members: { ok: false, status: 500, body: { error: { code: 'INTERNAL', message: 'Boom.' } } } });
        const state = await screen.findByTestId('members-load-error');
        const fetchMock = global.fetch as jest.Mock;
        const failing = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) =>
            String(url).endsWith('/admin/members') && !init?.method
                ? ({ ok: true, status: 200, json: async () => MEMBERS } as unknown as Response)
                : failing(url, init),
        );
        fireEvent.click(within(state).getByRole('button', { name: en.common.error.tryAgain }));
        await waitFor(() => expect(byId('role-badge-m-reader')).not.toBeNull());
        expect(screen.queryByTestId('members-load-error')).toBeNull();
    });
});

describe('members page — the back link and breadcrumb', () => {
    it('render once the members have loaded', async () => {
        mount();
        await waitFor(() => expect(byId('role-badge-m-reader')).not.toBeNull());
        expect(screen.getByTestId('page-header-back')).toBeInTheDocument();
        const crumbs = screen.getByRole('navigation', { name: en.common.ui.breadcrumb });
        expect(crumbs).toHaveTextContent(M.crumbSelf);
    });

    it('render over a failed load too', async () => {
        mount({ members: { ok: false, status: 500, body: {} } });
        await screen.findByTestId('members-load-error');
        expect(screen.getByTestId('page-header-back')).toBeInTheDocument();
        expect(screen.getByRole('navigation', { name: en.common.ui.breadcrumb })).toHaveTextContent(M.crumbSelf);
    });
});

describe('members page — the bulk Deactivate confirmation', () => {
    it('says deactivating ends access and keeps the record — not that the members are removed', async () => {
        mount();
        await waitFor(() => expect(byId('role-badge-m-reader')).not.toBeNull());
        const boxes = screen.getAllByRole('checkbox', { name: en.common.table.selectRow });
        fireEvent.click(boxes[0]);
        const select = await waitFor(() => {
            const el = byId('bulk-action-select');
            if (!el) throw new Error('no bulk bar yet');
            return el;
        });
        fireEvent.click(select);
        const listbox = await screen.findByRole('listbox');
        fireEvent.click(within(listbox).getByRole('option', { name: M.deactivate }));
        fireEvent.click(byId('bulk-apply-btn')!);

        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent(M.bulkDeactivateDescription);
        expect(dialog).not.toHaveTextContent(/removes the selected/i);
    });
});

describe('members page — a refused role save', () => {
    it('shows the server\'s reason and re-reads the members', async () => {
        mount({
            patch: {
                ok: false,
                status: 403,
                body: {
                    error: {
                        code: 'FORBIDDEN',
                        message: 'Cannot grant permissions you do not hold: admin.tenant_lifecycle.',
                    },
                },
            },
        });
        await waitFor(() => expect(byId('role-badge-m-reader')).not.toBeNull());
        fireEvent.click(byId('role-badge-m-reader')!);
        const customSelect = await waitFor(() => {
            const el = byId('custom-role-select-m-reader');
            if (!el) throw new Error('the editor did not open');
            return el;
        });
        fireEvent.click(customSelect);
        fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Reviewers' }));

        const readsBeforeSave = memberListReads();
        fireEvent.click(byId('role-save-m-reader')!);

        const notice = await waitFor(() => {
            const el = byId('members-error');
            if (!el) throw new Error('no error notice yet');
            return el;
        });
        expect(notice).toHaveTextContent('Cannot grant permissions you do not hold: admin.tenant_lifecycle.');
        await waitFor(() => expect(memberListReads()).toBeGreaterThan(readsBeforeSave));
    });
});
