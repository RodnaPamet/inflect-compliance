/** @jest-environment jsdom */

/**
 * The product's stock notifications — assignment, review request, task due,
 * watched-task activity, NIS2 gap-assessment assignment, evidence review,
 * vendor and incident alerts, and the rest of `STOCK_NOTIFICATIONS` —
 * rendered for a Bulgarian reader, on the notifications page and in the bell
 * (#5929).
 *
 * Their rows are stored in English, because the emitter does not know the
 * recipient's language. Mounted with the real `bg` catalog (the repo's global
 * `next-intl` mock reads `en`, so this file resolves `bg` the same way), so
 * this fails when either surface falls back to printing the stored English,
 * and — because it walks every kind `STOCK_NOTIFICATIONS` declares — when a
 * new kind is added without its Bulgarian messages.
 */
import * as React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.mock('next-intl', () => {
    const bg = jest.requireActual('../../messages/bg.json') as Record<string, unknown>;
    const lookup = (path: string): unknown =>
        path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), bg);
    const make = (ns?: string) => {
        const at = (key: string) => lookup(ns ? `${ns}.${key}` : key);
        const t = (key: string, values: Record<string, string | number> = {}) => {
            const v = at(key);
            return typeof v === 'string'
                ? v.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole))
                : key;
        };
        t.has = (key: string) => typeof at(key) === 'string';
        t.rich = t;
        t.raw = at;
        return t;
    };
    return {
        useTranslations: make,
        useLocale: () => 'bg',
        useNow: () => new Date(0),
        useTimeZone: () => 'UTC',
        NextIntlClientProvider: ({ children }: { children: unknown }) => children,
    };
});

jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`;
    const href = (p: string) => `/t/acme${p}`;
    return { useTenantApiUrl: () => apiUrl, useTenantHref: () => href };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn(), back: jest.fn() }),
    usePathname: () => '/t/acme/notifications',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import NotificationsPage from '@/app/t/[tenantSlug]/(app)/notifications/page';
import { NotificationsBell } from '@/components/layout/notifications-bell';
import {
    INCIDENT_REPORT,
    NIS2_GROUP,
    STOCK_NOTIFICATIONS,
    WATCH_DETAIL,
    nis2QuestionCount,
    recordLabel,
    stockNotificationText,
    stockNotificationTitle,
    type StockNotificationKind,
} from '@/lib/notifications/stock-notifications';

const BG = jest.requireActual('../../messages/bg.json') as Record<string, Record<string, unknown>>;
const bgAt = (path: string): string =>
    path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], BG) as string;
const fill = (template: string, values: Record<string, string>) =>
    template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);

/** Data a row carries, the same in either language. */
const DATA = {
    label: recordLabel('Rotate keys', 'T-12'),
    title: 'Signed DPA',
    name: 'Northwind Cloud',
    domain: 'northwind.example',
    date: '2026-10-01',
    attestation: 'SOC 2 Type II',
    reference: 'INC-7',
    minutes: '30',
    who: 'Ivo Petrov',
    framework: 'ISO27001',
    version: '2022',
    added: '3',
    flagged: '2',
};
/** The phrases the product writes into a slot, as stored and as Bulgarian words them. */
const PHRASES = {
    stored: {
        count: nis2QuestionCount(12),
        group: NIS2_GROUP.HR,
        detail: WATCH_DETAIL.commented,
        report: INCIDENT_REPORT.DETAILED_72H,
        reportLower: INCIDENT_REPORT.DETAILED_72H.toLowerCase(),
    },
    bg: {
        count: fill(bgAt('notificationBodies.stock.count.other'), { n: '12' }),
        group: bgAt('notificationBodies.stock.group.HR'),
        detail: bgAt('notificationBodies.stock.detail.commented'),
        report: bgAt('notificationBodies.stock.report.DETAILED_72H'),
        reportLower: bgAt('notificationBodies.stock.report.DETAILED_72H'),
    },
};
const KINDS = Object.keys(STOCK_NOTIFICATIONS) as StockNotificationKind[];

const rows = KINDS.map((kind, i) => ({
    id: `n${i}`,
    type: STOCK_NOTIFICATIONS[kind].type,
    title: stockNotificationTitle(kind, { ...DATA, ...PHRASES.stored }),
    message: stockNotificationText(kind, { ...DATA, ...PHRASES.stored }),
    linkUrl: null,
    createdAt: new Date().toISOString(),
    read: false,
}));

const expected = KINDS.map((kind) => ({
    kind,
    title: fill(bgAt(`notificationTitles.stock.${kind}`), { ...DATA, ...PHRASES.bg }),
    body: fill(bgAt(`notificationBodies.stock.${kind}`), { ...DATA, ...PHRASES.bg }),
}));

beforeEach(() => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => rows })) as unknown as typeof fetch;
});
afterEach(cleanup);

function assertBulgarian(scope: HTMLElement) {
    for (const { kind, title, body } of expected) {
        expect({ kind, title: scope.textContent?.includes(title) }).toEqual({ kind, title: true });
        expect({ kind, body: scope.textContent?.includes(body) }).toEqual({ kind, body: true });
    }
    for (const row of rows) {
        expect(scope.textContent).not.toContain(row.title);
        // A worded row carries the record's data, never the stored sentence.
        expect(scope.textContent).not.toContain(row.message);
    }
}

describe('stock notifications, in Bulgarian', () => {
    it('every kind has Bulgarian words that are not its stored English', () => {
        for (const { kind, title, body } of expected) {
            expect({ kind, title }).not.toEqual({ kind, title: STOCK_NOTIFICATIONS[kind].title });
            expect(title).toMatch(/[Ѐ-ӿ]/);
            expect(body).toMatch(/[Ѐ-ӿ]/);
        }
    });

    it('the notifications page words every stored row in Bulgarian', async () => {
        render(<NotificationsPage />);
        await screen.findByTestId('inbox-notification-n0');
        assertBulgarian(document.body);
    });

    it('the bell words every stored row in Bulgarian', async () => {
        const user = userEvent.setup();
        render(<NotificationsBell />);
        await waitFor(() => expect(global.fetch).toHaveBeenCalled());
        await user.click(screen.getByTestId('top-chrome-notifications-bell'));
        await screen.findByTestId('notification-row-n0');
        // The bell loads the stock reader on demand, so it may land a tick
        // after the rows; it must land, and every row must then be Bulgarian.
        await waitFor(() => assertBulgarian(document.body));
    });
});
