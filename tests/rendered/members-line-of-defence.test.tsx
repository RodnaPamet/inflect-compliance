/**
 * The members page and a member's line of defence (#3807, the column for step
 * 3b's `PUT /admin/members/:membershipId/line-of-defence`).
 *
 *   1. AN OWNER SETS IT on any membership but their own, and the page PUTs
 *      exactly `{ lineOfDefence }` — `null` for "not declared".
 *   2. NOBODY ELSE IS OFFERED IT. An ADMIN reads every member's line and gets
 *      no picker, and an OWNER's own row is text: the usecase refuses both.
 *   3. A change that broke an auditor agent's independence says so, because
 *      the server raises a finding rather than refusing.
 *
 * Each "not offered" assertion is paired with an "offered" one on the same
 * render, so a column that rendered nothing at all would fail here.
 */
import type { Role } from '@prisma/client';
import * as React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react';

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

const member = (id: string, role: string, lineOfDefence: string | null, userId = `u-${id}`) => ({
    id,
    userId,
    role,
    customRoleId: null,
    customRole: null,
    status: 'ACTIVE',
    invitedAt: null,
    deactivatedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    user: { id: userId, name: `Person ${id}`, email: `${id}@example.com`, image: null, createdAt: '2026-01-01' },
    invitedBy: null,
    activeSessionCount: 0,
    lineOfDefence,
});

const MEMBERS = [
    member('m-self', 'OWNER', null, 'viewer'),
    member('m-second', 'ADMIN', 'SECOND'),
    member('m-none', 'READER', null),
];

type Call = { url: string; method?: string; body: unknown };

function renderAs(role: Extract<Role, 'OWNER' | 'ADMIN'>, putResponse: Record<string, unknown> = {}) {
    const calls: Call[] = [];
    global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        calls.push({ url: u, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const body =
            init?.method === 'PUT'
                ? { changed: true, independenceFindingIds: [], ...putResponse }
                : u.includes('view=invites')
                  ? []
                  : u.endsWith('/admin/members')
                    ? MEMBERS
                    : [];
        return { ok: true, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    render(
        <TooltipProvider>
            <TenantProvider
                value={{
                    userId: 'viewer',
                    tenantId: 'tenant-1',
                    tenantSlug: 'acme',
                    tenantName: 'Acme',
                    role,
                    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
                    appPermissions: getPermissionsForRole(role),
                    modules: { processCanvas: false },
                }}
            >
                <MembersAdminPage />
            </TenantProvider>
        </TooltipProvider>,
    );
    return calls;
}

const byId = (id: string) => document.getElementById(id);

/** Let the page's fetches land; each re-derives the column defs and remounts cells. */
async function settled() {
    await waitFor(() => expect((global.fetch as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(3));
    await new Promise((r) => setTimeout(r, 50));
}

const rendered = (id: string) =>
    waitFor(() => {
        const el = byId(id);
        if (!el) throw new Error(`${id} never rendered`);
        return el;
    });

/** Open a picker and click one option, re-querying at the moment it acts. */
async function choose(triggerId: string, label: string) {
    await waitFor(() => {
        const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
        if (options().length === 0) {
            const el = byId(triggerId);
            if (!el) throw new Error(`${triggerId} never rendered`);
            fireEvent.click(el);
        }
        const option = options().find((o) => o.textContent?.trim() === label);
        if (!option) throw new Error(`option ${label} not offered`);
        fireEvent.click(option);
    });
}

const puts = (calls: Call[]) => calls.filter((c) => c.method === 'PUT');

describe('an OWNER', () => {
    it('sets another member\'s line, PUTting exactly { lineOfDefence }', async () => {
        const calls = renderAs('OWNER');
        await settled();
        await choose('lod-select-m-none', 'Second line');

        await waitFor(() => expect(puts(calls)).toHaveLength(1));
        expect(puts(calls)[0]).toEqual({
            url: '/api/t/acme/admin/members/m-none/line-of-defence',
            method: 'PUT',
            body: { lineOfDefence: 'SECOND' },
        });
        await waitFor(() => expect(document.body).toHaveTextContent('Line of defence updated for m-none@example.com'));
    });

    it('clears a line to "not declared" with null', async () => {
        const calls = renderAs('OWNER');
        await settled();
        await choose('lod-select-m-second', 'Not declared');
        await waitFor(() => expect(puts(calls)).toHaveLength(1));
        expect(puts(calls)[0].body).toEqual({ lineOfDefence: null });
    });

    it('is offered no picker on their own row', async () => {
        renderAs('OWNER');
        await settled();
        await rendered('lod-select-m-none');
        expect(byId('lod-select-m-self')).toBeNull();
        expect(await rendered('lod-m-self')).toHaveTextContent('Not declared');
    });

    it('is told when the change raised an independence finding', async () => {
        renderAs('OWNER', { independenceFindingIds: ['f-1'] });
        await settled();
        await choose('lod-select-m-second', 'First line');
        await waitFor(() =>
            expect(document.body).toHaveTextContent("It broke an auditor agent's independence, and 1 finding(s) were raised."),
        );
    });
});

it('an ADMIN reads every line and is offered no picker', async () => {
    renderAs('ADMIN');
    await settled();
    expect(await rendered('lod-m-second')).toHaveTextContent('Second line');
    expect(await rendered('lod-m-none')).toHaveTextContent('Not declared');
    expect(byId('lod-select-m-none')).toBeNull();
});
