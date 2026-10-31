/** @jest-environment jsdom */

/**
 * The risk CSV import page (#4775).
 *
 *   1. A refused import is a failure, not "Import complete — 0 of N".
 *   2. Row errors from the server are shown through a translated sentence.
 *   3. The format card states the workspace matrix's scale.
 *   4. Rows with no title are counted, not dropped without a word.
 *   5. A file the browser cannot read says so.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({
        tenantSlug: 'acme',
        tenantName: 'Acme',
        permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true },
        appPermissions: { risks: { create: true } },
    }),
}));
// The repo-wide next-intl mock substitutes `{name}` only, which would leave
// this page's plural sentences as their templates. This one also evaluates the
// flat `plural` blocks (`=N` / `one` / `other`), as in
// `ai-system-unclassified-tier.test.tsx`. Memoised per namespace.
jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const PLURAL = /\{(\w+),\s*plural,((?:\s*(?:=\d+|one|other)\s*\{[^{}]*\})+)\s*\}/g;
    const OPTION = /(=\d+|one|other)\s*\{([^{}]*)\}/g;
    const has = (p: Record<string, unknown> | undefined, n: string) => !!p && Object.prototype.hasOwnProperty.call(p, n);
    const format = (str: string, params?: Record<string, unknown>) =>
        str
            .replace(PLURAL, (block: string, name: string, options: string) => {
                if (!has(params, name)) return block;
                const n = Number(params![name]);
                const forms = new Map<string, string>();
                for (const m of options.matchAll(OPTION)) forms.set(m[1], m[2]);
                const body = forms.get(`=${n}`) ?? (n === 1 ? forms.get('one') : undefined) ?? forms.get('other');
                return body === undefined ? block : body.split('#').join(String(n));
            })
            .replace(/\{(\w+)\}/g, (m: string, name: string) => (has(params, name) ? String(params![name]) : m));
    const cache = new Map<string, unknown>();
    const makeT = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const val = lookup(ns, key);
            return typeof val === 'string' ? format(val, params) : key;
        };
        t.rich = t; t.markup = t; t.raw = (k: string) => lookup(ns, k);
        t.has = (k: string) => lookup(ns, k) !== undefined;
        return t;
    };
    return {
        useTranslations: (ns = '') => {
            if (!cache.has(ns)) cache.set(ns, makeT(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});
jest.mock('@/lib/hooks/use-risk-matrix-config', () => ({
    useRiskMatrixConfig: () => ({ config: { likelihoodLevels: 6, impactLevels: 4 }, isLoading: false }),
}));
jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));

import RiskImportPage from '@/app/t/[tenantSlug]/(app)/risks/import/page';
import { TooltipProvider } from '@/components/ui/tooltip';

const EN = jest.requireActual('../../messages/en.json') as { riskManager: Record<string, string> };
const R = EN.riskManager;

let importReply: { status: number; body: unknown } = { status: 200, body: { created: 1, skipped: 0, errors: [] } };
beforeEach(() => {
    importReply = { status: 200, body: { created: 1, skipped: 0, errors: [] } };
    global.fetch = jest.fn(async () => ({
        ok: importReply.status < 400, status: importReply.status,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => importReply.body, text: async () => JSON.stringify(importReply.body),
    })) as unknown as typeof fetch;
});

const mount = () => render(<TooltipProvider><RiskImportPage /></TooltipProvider>);

async function choose(csv: string) {
    const input = document.getElementById('csv-file-input') as HTMLInputElement;
    const file = new File([csv], 'risks.csv', { type: 'text/csv' });
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
}

const CSV = 'title,likelihood,impact\nPhishing,3,2\n,2,2\nOutage,1,1\n';

describe('Risk import page', () => {
    it("states the workspace matrix's scale", () => {
        mount();
        expect(screen.getByText(/likelihood \(1–6\), impact \(1–4\)/)).toBeInTheDocument();
    });

    it('counts rows with no title instead of dropping them silently', async () => {
        mount();
        await choose(CSV);
        expect(await screen.findByTestId('import-untitled')).toHaveTextContent("1 row has no title and won't be imported.");
    });

    it('a refused import is a failure, not a completed import', async () => {
        importReply = { status: 403, body: { error: { code: 'FORBIDDEN', message: 'Plan limit reached' } } };
        mount();
        await choose(CSV);
        await screen.findByTestId('import-untitled');
        await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /^Import 2 risks$/ })); });
        expect(await screen.findByTestId('import-failed')).toHaveTextContent('Plan limit reached');
        expect(screen.queryByTestId('import-done')).toBeNull();
    });

    it('shows each row error through a translated sentence', async () => {
        importReply = { status: 200, body: { created: 1, skipped: 0, errors: [{ row: 2, title: 'Outage', message: 'Owner not found' }] } };
        mount();
        await choose(CSV);
        await screen.findByTestId('import-untitled');
        await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /^Import 2 risks$/ })); });
        expect(await screen.findByText(R.rowError.replace('{row}', '2').replace('{title}', 'Outage').replace('{message}', 'Owner not found'))).toBeInTheDocument();
    });

    it('says so when the browser cannot read the file', async () => {
        const Real = global.FileReader;
        class FailingReader {
            onload: ((e: unknown) => void) | null = null;
            onerror: (() => void) | null = null;
            readAsText() { setTimeout(() => this.onerror?.(), 0); }
        }
        (global as unknown as { FileReader: unknown }).FileReader = FailingReader;
        try {
            mount();
            await choose(CSV);
            await waitFor(() => expect(screen.getByTestId('import-read-error')).toHaveTextContent(R.fileReadError));
        } finally {
            global.FileReader = Real;
        }
    });
});
