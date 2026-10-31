/** @jest-environment jsdom */

/**
 * #4639 — the Information Registry reads in words, filters on the statuses a
 * vendor can have, and says when the register is cut short.
 *
 * The filter offered SUSPENDED, which `VendorStatus` does not have, and left
 * out OFFBOARDING, which it does. Criticality, status and data access printed
 * their stored codes in the table and the filter. And the page read at most
 * 1,000 arrangements and counted the header from them, with no notice.
 */
import * as React from 'react';
import { act, configure, fireEvent, render, screen, within } from '@testing-library/react';

configure({ asyncUtilTimeout: 10_000 });

const TENANT_HREF = (p: string) => `/t/acme${p}`;
jest.mock('@/lib/tenant-context-provider', () => ({ useTenantHref: () => TENANT_HREF }));

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn(), refresh: jest.fn() }),
    useSearchParams: () => new URLSearchParams(window.location.search),
    usePathname: () => window.location.pathname,
}));

// Resolves real en.json values, `{name}` placeholders and the flat plural
// blocks the register's count uses. Memoised per namespace so the page's
// `useMemo([t])` filter defs settle.
jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const PLURAL = /\{(\w+),\s*plural,((?:\s*(?:=\d+|one|other)\s*\{[^{}]*\})+)\s*\}/g;
    const OPTION = /(=\d+|one|other)\s*\{([^{}]*)\}/g;
    const has = (params: Record<string, unknown> | undefined, name: string) =>
        !!params && Object.prototype.hasOwnProperty.call(params, name);
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
            .replace(/\{(\w+)(?:,\s*number)?\}/g, (m: string, name: string) => (has(params, name) ? String(params![name]) : m));
    const cache = new Map<string, unknown>();
    const makeT = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const val = lookup(ns, key);
            return typeof val === 'string' ? format(val, params) : key;
        };
        t.rich = t; t.markup = t; t.raw = (k: string) => lookup(ns, k);
        t.has = (k: string) => typeof lookup(ns, k) === 'string';
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

import { TooltipProvider } from '@/components/ui/tooltip';
import {
    InformationRegistryClient,
    type RegisterRow,
} from '@/app/t/[tenantSlug]/(app)/risks/information-registry/InformationRegistryClient';

const en = jest.requireActual('../../messages/en.json');
const IR = en.risks.informationRegistry;
const V = en.vendors;

function vendor(id: string, criticality: string, status: string, dataAccess: string | null): RegisterRow {
    return {
        id, name: `Vendor ${id}`, legalName: null, country: 'BG', status, criticality, dataAccess,
        isSubprocessor: false, contractRenewalAt: null, nextReviewAt: null, owner: null,
    };
}

const ROWS = [vendor('a', 'CRITICAL', 'OFFBOARDING', 'HIGH'), vendor('b', 'LOW', 'ACTIVE', 'NONE')];

function mount(props: Partial<React.ComponentProps<typeof InformationRegistryClient>> = {}) {
    return render(
        <TooltipProvider>
            <InformationRegistryClient
                rows={ROWS}
                truncated={false}
                total={ROWS.length}
                criticalOrImportant={1}
                canWrite={false}
                {...props}
            />
        </TooltipProvider>,
    );
}

function rowOf(id: string): HTMLElement {
    const tr = screen.getByTestId(`register-row-${id}`).closest('tr');
    if (!tr) throw new Error(`no row for ${id}`);
    return tr as HTMLElement;
}

beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme/risks/information-registry');
});

describe('the register reads in words (#4639)', () => {
    it('labels criticality, status and data access, and prints no stored code', () => {
        mount();
        const a = rowOf('a').textContent ?? '';
        for (const word of [V.filterEnums.criticality.critical, V.filterEnums.status.offboarding, V.form.dataHigh]) {
            expect(a).toContain(word);
        }
        for (const code of ['CRITICAL', 'OFFBOARDING', 'HIGH']) expect(a).not.toContain(code);

        const b = rowOf('b').textContent ?? '';
        for (const word of [V.filterEnums.criticality.low, V.filterEnums.status.active, V.form.dataNone]) {
            expect(b).toContain(word);
        }
        for (const code of ['LOW', 'ACTIVE', 'NONE']) expect(b).not.toContain(code);
    });

    it("offers the statuses a vendor can have — Offboarding, and no Suspended — as words", async () => {
        mount();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: en.common.ui.filter }));
        });
        const facet = await screen.findByRole('option', { name: new RegExp(`^${IR.colStatus}`) });
        await act(async () => { fireEvent.click(facet); });
        await screen.findByRole('option', { name: new RegExp(V.filterEnums.status.offboarding) });
        const names = screen.getAllByRole('option').map((o) => o.textContent ?? '');
        for (const s of ['active', 'onboarding', 'offboarding', 'offboarded'] as const) {
            expect(names.some((n) => n.includes(V.filterEnums.status[s]))).toBe(true);
        }
        expect(names.some((n) => /suspended/i.test(n))).toBe(false);
        expect(names.some((n) => n.includes('OFFBOARDING'))).toBe(false);
    });
});

describe('the register says when it is cut short (#4639)', () => {
    it("counts the header from the server's totals, not the rows it received", () => {
        mount({ truncated: true, total: 1500, criticalOrImportant: 640 });
        const count = screen.getByTestId('register-count').textContent ?? '';
        expect(count).toContain('1500 arrangements');
        expect(count).toContain(IR.criticalCount.replace('{count}', '640'));
    });

    it('shows the notice only when the list is cut short', () => {
        const { rerender } = mount({ truncated: true, total: 1500, criticalOrImportant: 640 });
        const banner = screen.getByTestId('list-truncation-banner');
        expect(within(banner).getByText(IR.truncatedHint)).toBeTruthy();

        rerender(
            <TooltipProvider>
                <InformationRegistryClient rows={ROWS} truncated={false} total={2} criticalOrImportant={1} canWrite={false} />
            </TooltipProvider>,
        );
        expect(screen.queryByTestId('list-truncation-banner')).toBeNull();
    });
});
