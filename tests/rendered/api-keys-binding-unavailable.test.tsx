/**
 * The API keys page does not promise an agent binding after creation.
 *
 * When the agent register is refused (no agent register read), the create form
 * cannot list agents and says so. It used to add "Someone with agent register
 * access can bind it after creation" — but nothing can. The key surface is
 * list, create and revoke (`admin/api-keys` GET/POST, `admin/api-keys/[keyId]`
 * DELETE), and `TenantApiKey.agentId` is written only by `createApiKey`'s
 * insert; no route or usecase updates it. So the sentence now says the agent is
 * set at creation only, and who can create a credential bound to one: creating
 * a key takes `admin.manage`, and listing agents to bind takes the register
 * read (`admin.agent_registry_view` or `admin.agent_registry`), so it is
 * someone who holds both.
 *
 * And only a refusal says "you do not have permission". A network error or a
 * failing response used to show that same sentence (or, for a 5xx, an empty
 * picker that read as "no agents"); it now says the register could not be
 * loaded.
 */
import * as React from 'react';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn(), back: jest.fn() }),
    usePathname: () => '/t/acme/admin/api-keys',
    useSearchParams: () => new URLSearchParams(),
}));

import ApiKeysPage from '@/app/t/[tenantSlug]/(app)/admin/api-keys/page';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getPermissionsForRole } from '@/lib/permissions';

type AgentsAnswer = 'refused' | 'network-error' | 'server-error';

function mount(agents: AgentsAnswer = 'refused') {
    global.fetch = jest.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes('/admin/agents')) {
            if (agents === 'network-error') throw new TypeError('Failed to fetch');
            const status = agents === 'refused' ? 403 : 500;
            return {
                ok: false,
                status,
                json: async () => ({ error: { code: status === 403 ? 'FORBIDDEN' : 'INTERNAL', message: 'x' } }),
            } as unknown as Response;
        }
        if (u.endsWith('/admin/api-keys')) return { ok: true, status: 200, json: async () => [] } as unknown as Response;
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    render(
        <TooltipProvider>
            <TenantProvider
                value={{
                    userId: 'admin-1',
                    tenantId: 'tenant-1',
                    tenantSlug: 'acme',
                    tenantName: 'Acme',
                    role: 'ADMIN',
                    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
                    appPermissions: getPermissionsForRole('ADMIN'),
                    modules: { processCanvas: false },
                }}
            >
                <ApiKeysPage />
            </TenantProvider>
        </TooltipProvider>,
    );
}

async function openCreateForm() {
    const create = await waitFor(() => {
        const el = document.getElementById('create-api-key-btn');
        if (!el) throw new Error('page not loaded yet');
        return el;
    });
    await waitFor(() =>
        expect((global.fetch as jest.Mock).mock.calls.some(([u]) => String(u).includes('/admin/agents'))).toBe(true),
    );
    fireEvent.click(create);
}

const shown = (id: string) =>
    waitFor(() => {
        const el = document.getElementById(id);
        if (!el) throw new Error(`#${id} not shown`);
        return el;
    });

describe('API keys page — agent binding when the register is refused', () => {
    it('says the binding is set at creation only, and who can create a bound credential', async () => {
        mount();
        await openCreateForm();

        const notice = await shown('key-binding-unavailable');
        expect(notice).toHaveTextContent(
            "You do not have permission to read the agent register, so this credential cannot be bound to an agent here. " +
                "A credential's agent can be set only when it is created, never afterwards. " +
                'For a credential that acts as an agent, ask someone who can also read the agent register to create it.',
        );
        expect(notice).not.toHaveTextContent(/after creation/i);
        // The register is refused, so there is no agent picker to choose from.
        expect(document.getElementById('key-agent-select')).toBeNull();
        expect(screen.queryByText(/bind it after/i)).toBeNull();
    });

    it.each<AgentsAnswer>(['network-error', 'server-error'])(
        'says the register could not be loaded, not that permission is missing (%s)',
        async (answer) => {
            mount(answer);
            await openCreateForm();

            const notice = await shown('key-binding-load-failed');
            expect(notice).toHaveTextContent(
                'The agent register could not be loaded, so this credential cannot be bound to an agent right now.',
            );
            expect(document.getElementById('key-binding-unavailable')).toBeNull();
            expect(screen.queryByText(/do not have permission/i)).toBeNull();
            // No empty picker either: it would read as "this tenant has no agents".
            expect(document.getElementById('key-agent-select')).toBeNull();
        },
    );
});
