/**
 * THE WORKSPACES LIST SAYS WHAT IT MEANS (#4843).
 *
 *   1. Health reads Healthy / At risk / Critical, never the stored GREEN /
 *      AMBER / RED, and the snapshot date is a date, not an ISO string.
 *   2. The delete dialog's title and button agree, and it promises no restore:
 *      nothing brings a deleted workspace back, and its data is erased 90 days
 *      later.
 *   3. A refused delete says the workspace was not deleted, with no HTTP status.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.setTimeout(60_000);

jest.mock('next/navigation', () => ({
    useRouter: () => ({ refresh: jest.fn(), push: jest.fn(), replace: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/org/acme/tenants',
    useSearchParams: () => new URLSearchParams(),
}));
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    const resolve = (path: string): unknown =>
        path.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const make = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(`${ns}.${key}`);
            if (typeof v !== 'string') return key;
            for (const [p, val] of Object.entries(params ?? {})) v = (v as string).replace(`{${p}}`, String(val));
            return v as string;
        };
        // `rich` with the `<b>` tag dropped: the tests read the sentence.
        t.rich = (key: string, params?: Record<string, unknown>) =>
            t(key, params).replace(/<\/?b>/g, '');
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});
jest.mock('@/lib/org-context-provider', () => ({
    useOrgPermissions: () => ({ canManageTenants: true, canDrillDown: true, canManageMembers: true }),
}));

import { TenantsTable } from '@/app/org/[orgSlug]/(app)/tenants/TenantsTable';

const EN = (require('../../messages/en.json') as { org: { tenants: Record<string, string> } }).org.tenants;

const row = (slug: string, rag: 'GREEN' | 'AMBER' | 'RED' | null) => ({
    tenantId: `t-${slug}`,
    slug,
    name: `Workspace ${slug}`,
    drillDownUrl: `/t/${slug}/dashboard`,
    hasSnapshot: rag !== null,
    snapshotDate: rag === null ? null : '2026-10-31',
    rag,
    coveragePercent: rag === null ? null : 72.5,
    openRisks: rag === null ? null : 4,
    criticalRisks: rag === null ? null : 1,
    overdueEvidence: rag === null ? null : 0,
});
const ROWS = [row('green', 'GREEN'), row('amber', 'AMBER'), row('red', 'RED'), row('new', null)];

afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
});

describe('the workspaces list', () => {
    it('reads health as words and the snapshot as a date', () => {
        render(<TenantsTable rows={ROWS as never} orgSlug="acme" />);
        const table = screen.getByTestId('org-tenants-table');
        for (const word of ['Healthy', 'At risk', 'Critical', 'Pending']) {
            expect(within(table).getAllByText(word).length).toBeGreaterThan(0);
        }
        for (const code of ['GREEN', 'AMBER', 'RED']) {
            expect(within(table).queryByText(code)).toBeNull();
        }
        expect(within(table).queryByText('2026-10-31')).toBeNull();
        expect(within(table).getAllByText('31 Oct 2026').length).toBe(3);
    });

    it('the delete dialog agrees with itself and promises no restore', async () => {
        const user = userEvent.setup();
        render(<TenantsTable rows={ROWS as never} orgSlug="acme" />);
        await user.click(screen.getByTestId('org-tenant-delete-green'));
        const dialog = await screen.findByTestId('org-tenant-delete-modal');
        expect(screen.getByRole('heading', { name: EN.removeTitle })).toBeInTheDocument();
        expect(screen.getByTestId('org-tenant-delete-confirm')).toHaveTextContent(EN.deleteTenant);
        expect(EN.removeTitle).toBe(EN.deleteTenant);
        expect(dialog).toHaveTextContent('Nothing in the product brings it back');
        expect(dialog).toHaveTextContent('kept for 90 days and then erased');
        expect(dialog.textContent ?? '').not.toMatch(/restore/i);
    });

    it('a refused delete says it was not deleted, with no status code', async () => {
        const user = userEvent.setup();
        (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({
            ok: false,
            status: 403,
            json: async () => ({}),
        })) as unknown as typeof fetch;
        render(<TenantsTable rows={ROWS as never} orgSlug="acme" />);
        await user.click(screen.getByTestId('org-tenant-delete-green'));
        await user.type(await screen.findByTestId('org-tenant-delete-confirm-input'), 'green');
        await user.click(screen.getByTestId('org-tenant-delete-confirm'));
        const notice = await screen.findByText(EN.failedRemove);
        expect(notice.textContent ?? '').not.toMatch(/403/);
    });
});
