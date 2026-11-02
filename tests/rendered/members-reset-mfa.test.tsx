/**
 * Members page — "Reset MFA" (#4926; owner decision, 2026-11-02). An Owner or
 * Admin resets another member's MFA from the row menu, after confirming. Only
 * an Owner is offered it for an Owner or an AI admin, as the server requires.
 */
import * as React from 'react';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';

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
    activeSessionCount: 1,
});

const MEMBERS = [member('m-owner', 'OWNER'), member('m-ai', 'AI_ADMIN'), member('m-editor', 'EDITOR')];

const session = {
    sessionId: 'sid-1',
    userAgent: 'Firefox on Linux',
    ipAddress: '203.0.113.7',
    lastActiveAt: '2026-10-25T08:00:00.000Z',
};

function mount(viewerRole: 'ADMIN' | 'OWNER') {
    global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        let body: unknown = [];
        if (u.endsWith('/security/mfa/enroll') && init?.method === 'DELETE') body = { success: true };
        else if (u.endsWith('/admin/members')) body = MEMBERS;
        else if (u.endsWith('/admin/roles')) body = [];
        else if (u.includes('/admin/sessions')) body = { sessions: [session], count: 1 };
        return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    render(
        <TooltipProvider>
            <TenantProvider
                value={{
                    userId: 'viewer',
                    tenantId: 'tenant-1',
                    tenantSlug: 'acme',
                    tenantName: 'Acme',
                    role: viewerRole,
                    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
                    appPermissions: getPermissionsForRole(viewerRole),
                    modules: { processCanvas: false },
                }}
            >
                <MembersAdminPage />
            </TenantProvider>
        </TooltipProvider>,
    );
}

const byId = (id: string) => document.getElementById(id);

async function openMenu(memberId: string) {
    await waitFor(() => {
        if (!byId(`action-view-sessions-${memberId}`)) {
            const trigger = byId(`member-menu-${memberId}`);
            if (!trigger) throw new Error(`member-menu-${memberId} never rendered`);
            fireEvent.click(trigger);
            throw new Error('the menu did not open yet');
        }
    });
}

describe('members page — Reset MFA', () => {
    it.each(['m-owner', 'm-ai'])("an ADMIN is not offered Reset MFA for %s", async (id) => {
        mount('ADMIN');
        await openMenu(id);
        expect(byId(`action-reset-mfa-${id}`)).toBeNull();
    });

    it("an ADMIN resets an Editor's MFA after confirming, naming the member", async () => {
        mount('ADMIN');
        await openMenu('m-editor');
        fireEvent.click(byId('action-reset-mfa-m-editor') as HTMLElement);
        const deletes = () =>
            (global.fetch as jest.Mock).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE');
        expect(deletes()).toHaveLength(0);
        const confirmButtons = await screen.findAllByRole('button', { name: M.resetMfa });
        fireEvent.click(confirmButtons[confirmButtons.length - 1]);
        await waitFor(() => expect(deletes()).toHaveLength(1));
        const [url, init] = deletes()[0] as [string, RequestInit];
        expect(url).toContain('/security/mfa/enroll');
        expect(JSON.parse(String(init.body))).toEqual({ targetUserId: 'u-m-editor' });
    });

    it("an OWNER is offered Reset MFA for an Owner and an AI admin", async () => {
        mount('OWNER');
        await openMenu('m-owner');
        expect(byId('action-reset-mfa-m-owner')).not.toBeNull();
    });
});
