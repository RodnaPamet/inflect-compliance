/**
 * The asset edit dialog says why a save was refused (#4361).
 *
 * `useEditAssetForm` threw `form.saveFailed` ("Couldn't save the asset.
 * Please try again.") on ANY non-OK response, so a rename onto another
 * asset's name — which `updateAsset` now refuses with a 409 carrying
 * `details.reason: ASSET_NAME_TAKEN` — read as a transient failure that no
 * retry could clear, and every other refusal lost the server's reason too.
 *
 * Mounted as the user meets it: the real `EditAssetModal`, open, with the
 * real fields and hook; only the network and the tenant context are faked.
 * Each case submits the form and reads the dialog's alert.
 */
import * as React from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

import { EditAssetModal } from '@/app/t/[tenantSlug]/(app)/assets/EditAssetModal';
import { TooltipProvider } from '@/components/ui/tooltip';

const A = require('../../messages/en.json').assets;

// ─── Network ────────────────────────────────────────────────────────

/** Per test: the answer to the dialog's PATCH. */
let answerPatch: { status: number; body?: unknown; unparseable?: boolean } = { status: 200, body: {} };
let patched: unknown = null;

beforeEach(() => {
    patched = null;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'https://test.local');
        if (init?.method === 'PATCH' && url.pathname === '/api/t/acme/assets/a-1') {
            patched = JSON.parse(String(init.body));
            const { status, body, unparseable } = answerPatch;
            return {
                ok: status < 400,
                status,
                headers: new Headers({ 'content-type': unparseable ? 'text/html' : 'application/json' }),
                json: async () => {
                    if (unparseable) throw new SyntaxError('Unexpected token < in JSON');
                    return body;
                },
            } as unknown as Response;
        }
        // The owner picker's member list, and anything else the fields read.
        return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => [],
        } as unknown as Response;
    }) as unknown as typeof fetch;
});

// ─── Mount + submit ─────────────────────────────────────────────────

async function saveRenamed(to: string) {
    const onSaved = jest.fn();
    const setOpen = jest.fn();
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider>
                <EditAssetModal
                    open
                    setOpen={setOpen}
                    assetId="a-1"
                    initial={{ name: 'Ledger', type: 'SYSTEM', status: 'ACTIVE' }}
                    onSaved={onSaved}
                />
            </TooltipProvider>
        </SWRConfig>,
    );
    const input = (await screen.findByLabelText(A.form.nameRequired)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: to } });
    await act(async () => {
        fireEvent.submit(document.getElementById('edit-asset-form') as HTMLFormElement);
    });
    const alert = await waitFor(() => {
        const el = document.getElementById('edit-asset-error');
        expect(el).not.toBeNull();
        return el as HTMLElement;
    });
    return { alert, onSaved, setOpen };
}

/** The refusal `updateAsset` sends for a taken name (`src/lib/asset-name-taken.ts`). */
const NAME_TAKEN = {
    status: 409,
    body: {
        error: {
            code: 'CONFLICT',
            message: 'Another asset already has this name. Choose a different name.',
            details: { reason: 'ASSET_NAME_TAKEN' },
        },
    },
};

describe('Asset edit dialog — a refused save says why', () => {
    it("a rename to another asset's name says so in the page's words, not 'try again'", async () => {
        // The reason decides, not the sentence: the server's is English
        // whatever the reader's language.
        answerPatch = {
            ...NAME_TAKEN,
            body: { error: { ...NAME_TAKEN.body.error, message: 'A resource with that unique constraint already exists' } },
        };
        const { alert, onSaved, setOpen } = await saveRenamed('Payroll DB');

        expect(patched).toMatchObject({ name: 'Payroll DB' });
        expect(alert.textContent).toBe(A.form.nameTaken);
        expect(alert.textContent).not.toBe(A.form.saveFailed);
        // The dialog stays open with the user's edit, so they can pick
        // another name.
        expect(onSaved).not.toHaveBeenCalled();
        expect(setOpen).not.toHaveBeenCalledWith(false);
        expect((screen.getByLabelText(A.form.nameRequired) as HTMLInputElement).value).toBe('Payroll DB');
    });

    it("any other refusal shows the server's reason", async () => {
        answerPatch = {
            status: 400,
            body: { error: { code: 'BAD_REQUEST', message: 'Owner must be an active member of this tenant' } },
        };
        const { alert } = await saveRenamed('Ledger v2');

        expect(alert.textContent).toBe('Owner must be an active member of this tenant');
    });

    it('a refusal with no readable reason still falls back to "try again"', async () => {
        answerPatch = { status: 502, unparseable: true };
        const { alert } = await saveRenamed('Ledger v2');

        expect(alert.textContent).toBe(A.form.saveFailed);
    });
});
