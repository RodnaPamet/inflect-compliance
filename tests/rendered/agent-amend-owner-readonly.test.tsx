/**
 * The amend modal SHOWS the accountable owner and does not edit it (#3698).
 *
 * Since #3698 an agent's owner moves only by a two-step transfer — proposed by
 * one holder of the tenant lifecycle permission, accepted by the person it
 * names — and the register's PATCH refuses `ownerUserId` by name. A picker left
 * in this modal would offer a change whose every use is a 400; worse, a modal
 * that still put `ownerUserId` into its patch would turn an unrelated rename
 * into a refused request. So: the owner renders read-only with the sentence
 * saying how it does change, and the PATCH carries only what was edited.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
        );
    const cache = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            return v as string;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/agents/agent-1',
    useSearchParams: () => new URLSearchParams(),
}));

import { AgentAmendModal } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentAmendModal';
import type { AgentSummary } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentDetailClient';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';

const AMEND = (
    require('../../messages/en.json') as {
        admin: { agentDetail: { amend: Record<string, string> } };
    }
).admin.agentDetail.amend;

const TENANT_CTX = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    tenantName: 'Acme',
    role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
    modules: { processCanvas: false },
};

const AGENT: AgentSummary = {
    id: 'agent-1',
    name: 'Reconciler',
    status: 'ACTIVE',
    autonomyLevel: 2,
    dataAccessScope: 'READ_TENANT_DATA',
    reversibility: 'REVERSIBLE',
    provenance: 'FIRST_PARTY',
    riskTier: 'LOW',
    aiActRiskTier: 'MINIMAL',
    description: null,
    modelRef: null,
    ownerUserId: 'owner-1',
    vendorId: null,
    registrationEnforced: true,
};

const OWNERS = [
    { id: 'owner-1', label: 'Alice Owner' },
    { id: 'owner-2', label: 'Bob Second' },
];

let fetchMock: jest.Mock;
beforeEach(() => {
    // jsdom has no `Response`; the modal reads only `ok` and `json()`.
    fetchMock = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 'agent-1', updated: true }) }));
    global.fetch = fetchMock as unknown as typeof fetch;
});

function renderModal() {
    return render(
        <TenantProvider value={TENANT_CTX}>
            <AgentAmendModal agent={AGENT} owners={OWNERS} vendors={[]} onClose={() => {}} onAmended={() => {}} />
        </TenantProvider>,
    );
}

describe('the amend modal shows the owner and never sends it', () => {
    it('renders the owner read-only, with the sentence saying how ownership moves', () => {
        renderModal();
        const owner = screen.getByTestId('agent-amend-owner') as HTMLInputElement;
        expect(owner.value).toBe('Alice Owner');
        expect(owner.readOnly).toBe(true);
        expect(document.body.textContent).toContain(AMEND.ownerMovesByTransfer);
    });

    it('a rename PATCHes the name alone — no ownerUserId rides along', async () => {
        renderModal();
        const name = screen.getByDisplayValue('Reconciler');
        fireEvent.change(name, { target: { value: 'Reconciler two' } });
        fireEvent.click(screen.getByTestId('agent-amend-save'));

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(init.method).toBe('PATCH');
        expect(JSON.parse(String(init.body))).toEqual({ name: 'Reconciler two' });
    });
});
