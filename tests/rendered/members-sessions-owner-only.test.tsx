/**
 * The members page's Sessions modal offers to revoke an Owner's or an AI
 * admin's sessions only to an Owner (owner decision, 2026-10-25). The server
 * refuses the same DELETE (`assertMayRevokeSessionsOfUser`); the modal must not
 * offer a button that can only fail, and says who can.
 *
 * `next-intl` is the repo's manual mock with ONE `t` per namespace, as in
 * `members-page-states.test.tsx`: a new function per render would re-create the
 * page's fetch callbacks and refetch in a loop.
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
    global.fetch = jest.fn(async (url: unknown) => {
        const u = String(url);
        let body: unknown = [];
        if (u.endsWith('/admin/members')) body = MEMBERS;
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

async function byIdEventually(id: string): Promise<HTMLElement> {
    let el: HTMLElement | null = null;
    await waitFor(() => {
        el = document.getElementById(id);
        expect(el).not.toBeNull();
    });
    return el as unknown as HTMLElement;
}

async function openSessionsOf(memberId: string) {
    fireEvent.click(await byIdEventually(`sessions-count-${memberId}`));
    return byIdEventually('sessions-list');
}

describe("members page — revoking an Owner's or an AI admin's sessions is an Owner's act", () => {
    it.each(['m-owner', 'm-ai'])('an ADMIN sees %s\'s sessions with no Revoke button, and is told why', async (id) => {
        mount('ADMIN');
        await openSessionsOf(id);
        expect(screen.getByText(session.userAgent)).toBeInTheDocument();
        expect(document.getElementById('revoke-session-sid-1')).toBeNull();
        expect(document.getElementById('sessions-owner-only')).toHaveTextContent(M.sessionsOwnerOnly);
    });

    it("an ADMIN can still revoke an Editor's session", async () => {
        mount('ADMIN');
        await openSessionsOf('m-editor');
        expect(document.getElementById('revoke-session-sid-1')).not.toBeNull();
        expect(document.getElementById('sessions-owner-only')).toBeNull();
    });

    it("an OWNER can revoke an Owner's session", async () => {
        mount('OWNER');
        await openSessionsOf('m-owner');
        expect(document.getElementById('revoke-session-sid-1')).not.toBeNull();
        expect(document.getElementById('sessions-owner-only')).toBeNull();
    });
});
