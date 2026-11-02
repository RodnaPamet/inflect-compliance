/**
 * The asset forms ask before discarding what was typed, in the product's own
 * dialog rather than the browser's `confirm()` (#4963), and the close waits
 * for the answer.
 *
 * Mounted as the user meets them: the real `NewAssetModal` and
 * `EditAssetModal`, open, with their real fields and hooks; only the network,
 * the router and the tenant context are faked.
 */
import * as React from 'react';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.setTimeout(60_000);
configure({ asyncUtilTimeout: 20_000 });

// ─── Mocks (before imports) ─────────────────────────────────────────


jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantSlug: 'acme', tenantName: 'Acme' }),
    usePermissions: () => ({}),
    useCurrentUserId: () => 'user-1',
}));

// next-intl is ESM; resolve real en.json values so the alert's text can be
// compared with the message file rather than a copy of it.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    return {
        useTranslations: (ns: string) => {
            const t = (key: string) => {
                const v = walk(walk(en, ns), key);
                return typeof v === 'string' ? v : key;
            };
            t.rich = t;
            return t;
        },
        useLocale: () => 'en',
    };
});

jest.mock('next/navigation', () => {
    const router = { push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn(), back: jest.fn() };
    const searchParams = new URLSearchParams();
    return {
        useRouter: () => router,
        usePathname: () => '/t/acme/assets/a-1',
        useSearchParams: () => searchParams,
        useParams: () => ({ tenantSlug: 'acme', id: 'a-1' }),
    };
});

// ─── Imports (after mocks) ──────────────────────────────────────────

import { NewAssetModal } from '@/app/t/[tenantSlug]/(app)/assets/NewAssetModal';
import { EditAssetModal } from '@/app/t/[tenantSlug]/(app)/assets/EditAssetModal';
import { TooltipProvider } from '@/components/ui/tooltip';

const A = require('../../messages/en.json').assets;

beforeEach(() => {
    // The owner picker's member list, and anything else the fields read.
    global.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => [],
    })) as unknown as typeof fetch;
});

/** The labels the list page hands the new-asset form. */
const NEW_LABELS = {
    name: 'Name',
    type: 'Type',
    classification: 'Classification',
    classificationPlaceholder: 'Classification',
    owner: 'Owner',
    location: 'Location',
    dataResidency: 'Data residency',
    residencyPlaceholder: 'Data residency',
    confidentiality: 'Confidentiality',
    integrity: 'Integrity',
    availability: 'Availability',
    cancel: 'Cancel',
    createAsset: 'Create asset',
    addAsset: 'Add asset',
};

function wrap(node: React.ReactNode) {
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider>{node}</TooltipProvider>
        </SWRConfig>,
    );
}

describe('the new-asset form asks before discarding what was typed', () => {
    async function typeThenCancel(setOpen: jest.Mock) {
        wrap(<NewAssetModal open setOpen={setOpen} tenantSlug="acme" labels={NEW_LABELS} />);
        const input = await waitFor(() => {
            const el = document.getElementById('asset-name-input');
            expect(el).not.toBeNull();
            return el as HTMLInputElement;
        });
        fireEvent.change(input, { target: { value: 'Draft asset' } });
        fireEvent.click(document.getElementById('new-asset-cancel-btn') as HTMLElement);
        return input;
    }

    it('keeping the draft leaves the form open with what was typed', async () => {
        const confirmSpy = jest.spyOn(window, 'confirm');
        const setOpen = jest.fn();
        const input = await typeThenCancel(setOpen);
        expect((await screen.findAllByText(A.modal.discardTitle)).length).toBeGreaterThan(0);
        expect(screen.getAllByText(A.modal.discardConfirm).length).toBeGreaterThan(0);
        fireEvent.click(screen.getByRole('button', { name: A.modal.discardCancelLabel }));
        await waitFor(() => expect(screen.queryByText(A.modal.discardTitle)).toBeNull());
        expect(setOpen).not.toHaveBeenCalled();
        expect(input.value).toBe('Draft asset');
        expect(confirmSpy).not.toHaveBeenCalled();
        confirmSpy.mockRestore();
    });

    it('discarding closes the form', async () => {
        const setOpen = jest.fn();
        await typeThenCancel(setOpen);
        fireEvent.click(await screen.findByRole('button', { name: A.modal.discardConfirmLabel }));
        await waitFor(() => expect(setOpen).toHaveBeenCalledWith(false));
    });

    it('an untouched form closes without asking', async () => {
        const setOpen = jest.fn();
        wrap(<NewAssetModal open setOpen={setOpen} tenantSlug="acme" labels={NEW_LABELS} />);
        await waitFor(() => expect(document.getElementById('new-asset-cancel-btn')).not.toBeNull());
        fireEvent.click(document.getElementById('new-asset-cancel-btn') as HTMLElement);
        expect(setOpen).toHaveBeenCalledWith(false);
        expect(screen.queryByText(A.modal.discardTitle)).toBeNull();
    });
});

describe('the edit-asset form asks before discarding changes', () => {
    async function editThenCancel(setOpen: jest.Mock) {
        wrap(
            <EditAssetModal
                open
                setOpen={setOpen}
                assetId="a-1"
                initial={{ name: 'Ledger', type: 'SYSTEM', status: 'ACTIVE' }}
                onSaved={jest.fn()}
            />,
        );
        const input = (await screen.findByLabelText(A.form.nameRequired)) as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'Ledger v2' } });
        fireEvent.click(document.getElementById('edit-asset-cancel-btn') as HTMLElement);
        return input;
    }

    it('keeping the changes leaves the form open with them', async () => {
        const confirmSpy = jest.spyOn(window, 'confirm');
        const setOpen = jest.fn();
        const input = await editThenCancel(setOpen);
        expect((await screen.findAllByText(A.modal.editDiscardTitle)).length).toBeGreaterThan(0);
        expect(screen.getAllByText(A.modal.editDiscardConfirm).length).toBeGreaterThan(0);
        fireEvent.click(screen.getByRole('button', { name: A.modal.editDiscardCancelLabel }));
        await waitFor(() => expect(screen.queryByText(A.modal.editDiscardTitle)).toBeNull());
        expect(setOpen).not.toHaveBeenCalled();
        expect(input.value).toBe('Ledger v2');
        expect(confirmSpy).not.toHaveBeenCalled();
        confirmSpy.mockRestore();
    });

    it('discarding closes the form', async () => {
        const setOpen = jest.fn();
        await editThenCancel(setOpen);
        fireEvent.click(await screen.findByRole('button', { name: A.modal.editDiscardConfirmLabel }));
        await waitFor(() => expect(setOpen).toHaveBeenCalledWith(false));
    });
});
