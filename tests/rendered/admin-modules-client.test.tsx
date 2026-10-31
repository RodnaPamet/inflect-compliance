/**
 * #4819 — the Modules page carries no vendor-internal licence note, says why a
 * change was refused, and can retry a failed read.
 */
import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

const swrState: { data: unknown; isLoading: boolean; error: unknown; mutate: jest.Mock } = {
    data: { enabled: false },
    isLoading: false,
    error: undefined,
    mutate: jest.fn(),
};
jest.mock('@/lib/hooks/use-tenant-swr', () => ({ useTenantSWR: () => swrState }));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantSlug: 'acme' }),
}));
jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));

import { ModulesClient } from '@/app/t/[tenantSlug]/(app)/admin/modules/ModulesClient';
import en from '../../messages/en.json';

afterEach(() => {
    swrState.data = { enabled: false };
    swrState.error = undefined;
    swrState.mutate.mockClear();
    delete (globalThis as { fetch?: unknown }).fetch;
});

it('shows the module with no licence notice', () => {
    render(<ModulesClient />);
    expect(screen.getByText(en.admin.modules.processCanvas.name)).toBeInTheDocument();
    expect(screen.queryByText(/licen[cs]e/i)).toBeNull();
    expect(en.admin.modules.processCanvas).not.toHaveProperty('licenceHeading');
});

it('a refused change shows the server\'s reason', async () => {
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({
        ok: false,
        status: 403,
        json: async () => ({ error: { message: 'Only a workspace owner can turn product modules on or off.' } }),
    }));
    render(<ModulesClient />);
    fireEvent.click(screen.getByTestId('toggle-process-canvas'));
    expect(await screen.findByTestId('module-save-failed')).toHaveTextContent(
        'Only a workspace owner can turn product modules on or off.',
    );
    expect(swrState.mutate).not.toHaveBeenCalled();
});

it('a failed read offers a retry that re-reads', () => {
    swrState.data = undefined;
    swrState.error = new Error('boom');
    render(<ModulesClient />);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(swrState.mutate).toHaveBeenCalledTimes(1);
});
