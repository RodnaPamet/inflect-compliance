/**
 * The Audit log page's table (#4468), rendered.
 *
 * Paging: the page used to stop at the latest 100 entries with no sign that
 * more existed. The server page now hands the island the older page's link
 * exactly when the read found one, and the newest page's link on any later
 * page; this asserts the island renders each link exactly when it is given.
 *
 * Columns: Action and Entity printed the stored codes (`CUSTOM_ROLE_CREATED`,
 * `TenantCustomRole`); they now read as words, with the dashboard feed's
 * translated noun where one exists. The table has no bulk actions, so it
 * offers no row selection.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
        );
    return {
        useTranslations: (ns: string) => (key: string) => {
            const v = resolve(ns, key);
            return typeof v === 'string' ? v : key;
        },
        useLocale: () => 'en',
    };
});

jest.mock('next/navigation', () => ({
    usePathname: () => '/t/acme/admin/audit-log',
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));

import { AuditLogClient, type AuditLogRow } from '@/app/t/[tenantSlug]/(app)/admin/audit-log/AuditLogClient';

const en = require('../../messages/en.json') as { admin: Record<string, unknown> };
const A = en.admin as Record<string, string>;

const TRANSLATIONS = {
    time: A.time,
    user: A.user,
    action: A.action,
    entity: A.entity,
    details: A.details,
    noEntries: A.noEntries,
    older: A.auditLogOlder,
    newest: A.auditLogNewest,
    pages: A.auditLogPages,
};

const ROW: AuditLogRow = {
    id: 'log-1',
    createdAt: '2026-10-29T12:00:00.000Z',
    action: 'RISK_CREATED',
    entity: 'Risk',
    details: 'Created risk "Ransomware"',
    userName: 'Ivo',
};

function renderTable(props: Partial<React.ComponentProps<typeof AuditLogClient>> = {}) {
    return render(
        <AuditLogClient
            auditLog={[ROW]}
            olderHref={null}
            newestHref={null}
            translations={TRANSLATIONS}
            {...props}
        />,
    );
}

describe('paging', () => {
    test('the first page of a longer log links to the older page only', () => {
        renderTable({ olderHref: '/t/acme/admin/audit-log?cursor=c-2' });
        const nav = screen.getByRole('navigation', { name: A.auditLogPages });
        expect(within(nav).getByRole('link', { name: A.auditLogOlder })).toHaveAttribute(
            'href',
            '/t/acme/admin/audit-log?cursor=c-2',
        );
        expect(within(nav).queryByRole('link', { name: A.auditLogNewest })).toBeNull();
    });

    test('a later page links back to the newest, and on to the older page when there is one', () => {
        renderTable({ olderHref: '/t/acme/admin/audit-log?cursor=c-3', newestHref: '/t/acme/admin/audit-log' });
        const nav = screen.getByRole('navigation', { name: A.auditLogPages });
        expect(within(nav).getByRole('link', { name: A.auditLogNewest })).toHaveAttribute('href', '/t/acme/admin/audit-log');
        expect(within(nav).getByRole('link', { name: A.auditLogOlder })).toBeInTheDocument();
    });

    test('a log that fits on one page shows no paging at all', () => {
        renderTable();
        expect(screen.queryByRole('navigation', { name: A.auditLogPages })).toBeNull();
    });
});

describe('columns', () => {
    test('Action and Entity read as words, not the stored codes', () => {
        renderTable({
            auditLog: [
                { ...ROW, id: 'a', action: 'CUSTOM_ROLE_CREATED', entity: 'TenantCustomRole' },
                { ...ROW, id: 'b', action: 'AUTHZ_DENIED', entity: 'Permission' },
            ],
        });
        const table = screen.getByTestId('audit-log-table');
        for (const text of ['Custom role created', 'Tenant custom role', 'Authorization denied', 'Permission']) {
            expect(within(table).getAllByText(text).length).toBeGreaterThan(0);
        }
        for (const code of ['CUSTOM_ROLE_CREATED', 'TenantCustomRole', 'AUTHZ_DENIED']) {
            expect(within(table).queryByText(code)).toBeNull();
        }
    });

    test("an entity the dashboard feed translates uses that noun", () => {
        renderTable({ auditLog: [{ ...ROW, entity: 'RISK' }] });
        const noun = (require('../../messages/en.json') as { dashboard: { activity: { entity: { risk: string } } } })
            .dashboard.activity.entity.risk;
        const expected = noun.charAt(0).toUpperCase() + noun.slice(1);
        expect(within(screen.getByTestId('audit-log-table')).getAllByText(expected).length).toBeGreaterThan(0);
    });

    test('the details text is shown as given', () => {
        renderTable();
        expect(within(screen.getByTestId('audit-log-table')).getAllByText(ROW.details!).length).toBeGreaterThan(0);
    });

    test('offers no row selection: the table has no bulk actions', () => {
        renderTable();
        expect(within(screen.getByTestId('audit-log-table')).queryAllByRole('checkbox')).toEqual([]);
    });
});
