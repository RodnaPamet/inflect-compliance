/**
 * The admin hub's sections are lists on a phone (#5924).
 *
 * Each section of `/admin` is a group of links to admin pages — up to six.
 * Laid out as a wrapping row of pills, a phone put them on three or four
 * ragged lines (the whole-product audit's "button group on 3+ lines"). Below
 * `sm` a section is now a column of full-width rows, one destination per
 * line; from `sm` up it is the wrapping row it was.
 *
 * jsdom applies no media query, so the classes that make each layout are what
 * is asserted, on the real page rendered the way Next renders it.
 */
import { render, screen, within } from '@testing-library/react';
import { makeRequestContext } from '../helpers/make-context';

jest.mock('@/app/t/[tenantSlug]/(app)/admin/_lib/admin-page-gate', () => ({
    __esModule: true,
    gateAdminPage: async () => ({ allowed: true, ctx: makeRequestContext('OWNER'), tenantSlug: 'acme' }),
}));

jest.mock('@/components/theme/ThemeToggle', () => ({ ThemeToggle: () => null }));

// The workspace-language toggle the hub's header shows an `admin.manage`
// holder reads the stored language from the database; it has its own tests.
jest.mock('@/app-layer/usecases/workspace-language', () => ({
    __esModule: true,
    getWorkspaceLanguage: async () => ({ defaultLocale: 'en' }),
}));
jest.mock('@/app/t/[tenantSlug]/(app)/admin/WorkspaceLanguageToggle', () => ({
    __esModule: true,
    WorkspaceLanguageToggle: () => null,
}));

jest.mock('next-intl/server', () => {
    const lookup = (bag: unknown, key: string): unknown =>
        key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), bag);
    return {
        __esModule: true,
        getTranslations: async (ns: string) => {
            const en = require('../../messages/en.json') as Record<string, unknown>;
            const bag = lookup(en, ns);
            return (key: string) => {
                const v = lookup(bag, key);
                return typeof v === 'string' ? v : key;
            };
        },
    };
});

import AdminPage from '@/app/t/[tenantSlug]/(app)/admin/page';

async function renderHub() {
    const ui = await AdminPage({ params: Promise.resolve({ tenantSlug: 'acme' }) });
    return render(ui);
}

describe('the admin hub on a phone', () => {
    it('every section is a column below sm and a wrapping row from sm up', async () => {
        await renderHub();
        const groups = screen.getAllByTestId('admin-hub-section-links');
        // Every section renders one group; at least one has the six links the
        // audit found on three lines.
        expect(groups.length).toBeGreaterThan(5);
        expect(Math.max(...groups.map((g) => g.children.length))).toBeGreaterThanOrEqual(6);
        for (const group of groups) {
            const classes = group.className.split(/\s+/);
            expect(classes).toEqual(expect.arrayContaining(['flex', 'flex-col', 'sm:flex-row', 'sm:flex-wrap']));
            expect(classes).not.toContain('flex-wrap');
        }
    });

    it('every link is a full-width, left-aligned row below sm, and still goes where it went', async () => {
        await renderHub();
        for (const group of screen.getAllByTestId('admin-hub-section-links')) {
            for (const link of within(group).getAllByRole('link')) {
                expect(link.className.split(/\s+/)).toEqual(expect.arrayContaining(['max-sm:w-full', 'max-sm:justify-start']));
                expect(link.getAttribute('href')).toMatch(/^\/t\/acme\/admin\//);
            }
        }
        expect(document.getElementById('members-pill-btn')?.getAttribute('href')).toBe('/t/acme/admin/members');
    });
});
