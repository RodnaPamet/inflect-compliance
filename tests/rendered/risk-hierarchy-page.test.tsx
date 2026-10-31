/** @jest-environment jsdom */

/**
 * The risk hierarchy page (#4772).
 *
 *   1. A node lists the risks attached to it, and one is detached from there.
 *   2. A failed rename keeps the editor open with the server's reason.
 *   3. Rename, delete, attach and detach need `risks.edit`, as their routes do.
 *   4. The tree type is a radio group.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

let appPermissions: Record<string, unknown> = { risks: { edit: true } };
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({
        tenantSlug: 'acme',
        permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true },
        appPermissions,
    }),
    useMoneyFormatter: () => (v: number | null | undefined) => `€${v ?? 0}`,
}));
jest.mock('next-intl', () => {
    const shared = jest.requireActual('../../__mocks__/next-intl.js');
    const translators = new Map<string, unknown>();
    return {
        ...shared,
        useTranslations: (ns: string) => {
            if (!translators.has(ns)) translators.set(ns, shared.useTranslations(ns));
            return translators.get(ns);
        },
    };
});
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/risks/hierarchy',
    useSearchParams: () => new URLSearchParams(),
}));
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));
jest.mock('../../src/app/t/[tenantSlug]/(app)/risks/_shared/RiskPicker', () => ({ RiskPicker: () => null }));

import RiskHierarchyPage from '@/app/t/[tenantSlug]/(app)/risks/hierarchy/page';
import { TooltipProvider } from '@/components/ui/tooltip';

const EN = jest.requireActual('../../messages/en.json') as { risks: { hierarchy: Record<string, string> } };
const H = EN.risks.hierarchy;

const TREE = [
    { nodeId: 'n1', nodeName: 'Engineering', riskCount: 1, totalAle: 100, risks: [{ id: 'r1', title: 'Ransomware' }], children: [] },
];
let writes: Array<{ method: string; url: string; body: unknown }> = [];
let patchStatus = 200;

beforeEach(() => {
    appPermissions = { risks: { edit: true } };
    writes = [];
    patchStatus = 200;
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const reply = (status: number, body: unknown) => ({
            ok: status < 400, status, headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => body, text: async () => JSON.stringify(body),
        });
        if (method === 'GET') return reply(200, { treemap: TREE });
        writes.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (method === 'PATCH' && patchStatus !== 200) {
            return reply(patchStatus, { error: { code: 'BAD_REQUEST', message: 'Name is too long' } });
        }
        return reply(200, {});
    }) as unknown as typeof fetch;
});

const mount = () =>
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider><RiskHierarchyPage /></TooltipProvider>
        </SWRConfig>,
    );

describe('Risk hierarchy page', () => {
    it("lists a node's risks and detaches one from that list", async () => {
        mount();
        await act(async () => { fireEvent.click(await screen.findByTestId('node-risks-toggle-n1')); });
        expect(screen.getByTestId('node-risks-n1')).toHaveTextContent('Ransomware');
        await act(async () => { fireEvent.click(screen.getByTestId('node-unlink-n1-r1')); });
        await waitFor(() => expect(writes.find((w) => w.method === 'DELETE')).toBeDefined());
        const del = writes.find((w) => w.method === 'DELETE')!;
        expect(del.url).toContain('/risks/hierarchy/n1/links');
        expect(del.body).toEqual({ riskId: 'r1' });
    });

    it('keeps a failed rename open, with the reason', async () => {
        patchStatus = 400;
        mount();
        await act(async () => { fireEvent.click(await screen.findByTestId('node-rename-n1')); });
        fireEvent.change(screen.getByRole('textbox', { name: H.rename }), { target: { value: 'Platform engineering' } });
        await act(async () => { fireEvent.click(screen.getByTestId('node-rename-save-n1')); });
        expect(await screen.findByTestId('node-rename-error-n1')).toHaveTextContent('Name is too long');
        expect(screen.getByRole('textbox', { name: H.rename })).toHaveValue('Platform engineering');
    });

    it('offers no rename, delete or detach without risks.edit', async () => {
        appPermissions = { risks: { edit: false } };
        mount();
        await act(async () => { fireEvent.click(await screen.findByTestId('node-risks-toggle-n1')); });
        expect(screen.queryByTestId('node-rename-n1')).toBeNull();
        expect(screen.queryByTestId('node-delete-n1')).toBeNull();
        expect(screen.queryByTestId('node-unlink-n1-r1')).toBeNull();
    });

    it('offers the tree types as a radio group', async () => {
        mount();
        expect(await screen.findByRole('radiogroup', { name: H.typeLabel })).toBeInTheDocument();
    });
});
