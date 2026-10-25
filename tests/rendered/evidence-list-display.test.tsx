/**
 * What the Evidence list's cells and its celebration SAY (#4277).
 *
 *   - The Freshness column used to feed `nextReviewDate` to a badge that
 *     measures the age of a last-refreshed date, so a review due in six
 *     months read "today" and one overdue by 20 days read "20d ago". It now
 *     names the row's freshness bucket — the one the Freshness filter and the
 *     freshness cards count it in.
 *   - The Type column printed the file-kind resolver's English `label`.
 *   - The "all current" celebration was hard-coded English, and said "this
 *     week" while its trigger is the 30-day expiring-soon window.
 *
 * Mounted in Bulgarian, so an English string reaching the DOM is visible.
 */
import * as React from 'react';
import { configure, screen, waitFor } from '@testing-library/react';

jest.setTimeout(180_000);
configure({ asyncUtilTimeout: 20_000 });

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({
        tenantSlug: 'acme',
        tenantName: 'Acme',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: true },
    }),
    usePermissions: () => ({}),
    useCurrentUserId: () => 'user-me',
    useMoneyFormatter: () => (v: number | null | undefined) => (v == null ? '' : String(v)),
    useModules: () => ({}),
}));

// `mock`-prefixed so the hoisted factory may read it.
const mockCatalogue: { messages: Record<string, unknown> } = {
    messages: require('../../messages/bg.json'),
};
jest.mock('next-intl', () => {
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const make = (ns: string) => {
        const t = (key: string, values?: Record<string, unknown>) => {
            const v = walk(walk(mockCatalogue.messages, ns), key);
            if (typeof v !== 'string') return key;
            return v.replace(/\{(\w+)\}/g, (m, name) => (values && name in values ? String(values[name]) : m));
        };
        t.rich = (key: string) => walk(walk(mockCatalogue.messages, ns), key) ?? key;
        t.has = (key: string) => typeof walk(walk(mockCatalogue.messages, ns), key) === 'string';
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'bg' };
});

jest.mock('next/navigation', () => {
    const searchParams = new URLSearchParams();
    const router = { push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() };
    return {
        useRouter: () => router,
        usePathname: () => '/t/acme/evidence',
        useSearchParams: () => searchParams,
        useParams: () => ({ tenantSlug: 'acme' }),
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

const toastSuccess = jest.fn();
jest.mock('sonner', () => {
    const actual = jest.requireActual('sonner');
    return {
        ...actual,
        toast: Object.assign((...a: unknown[]) => actual.toast(...a), {
            ...actual.toast,
            success: (...a: unknown[]) => toastSuccess(...a),
        }),
    };
});

import { evidenceRow, installEvidenceFetch, makeServer, metrics, mountEvidenceClient } from './evidence-client-harness';

const BG = require('../../messages/bg.json');
const EN = require('../../messages/en.json');
const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme/evidence');
    toastSuccess.mockClear();
});

function mount(rows: ReturnType<typeof evidenceRow>[], m = metrics()) {
    const server = makeServer({ rows, metrics: m });
    installEvidenceFetch(server);
    return mountEvidenceClient(server, { role: 'ADMIN' });
}

describe('Freshness column — the row\'s bucket, not an age', () => {
    it('a review due in six months is Current, one overdue by 20 days is Expired, one due in 10 days is Expiring soon', async () => {
        mount([
            evidenceRow({ id: 'ev-future', title: 'Future review', nextReviewDate: iso(180) }),
            evidenceRow({ id: 'ev-overdue', title: 'Overdue review', nextReviewDate: iso(-20) }),
            evidenceRow({ id: 'ev-soon', title: 'Soon review', nextReviewDate: iso(10) }),
        ]);
        const future = await screen.findByTestId('evidence-row-freshness-ev-future');
        await waitFor(() => expect(future).toHaveTextContent(BG.evidence.filterEnums.freshness.current));
        expect(screen.getByTestId('evidence-row-freshness-ev-overdue')).toHaveTextContent(
            BG.evidence.filterEnums.freshness.expired,
        );
        expect(screen.getByTestId('evidence-row-freshness-ev-soon')).toHaveTextContent(
            BG.evidence.filterEnums.freshness.expiring,
        );
        // No age wording ("today", "20d ago") and no "last refreshed" claim.
        expect(future.textContent).not.toMatch(/today|ago/);
        expect(screen.getByTestId('evidence-row-freshness-ev-overdue').textContent).not.toMatch(/ago/);
    });
});

describe('Type column — the file kind in the reader\'s language', () => {
    it('labels an image row with common.fileKinds, not the resolver\'s English', async () => {
        mount([
            evidenceRow({
                id: 'ev-img',
                title: 'Screenshot',
                fileName: 'shot.png',
                fileRecord: { id: 'fr-1', mimeType: 'image/png', scanStatus: 'CLEAN' },
            }),
        ]);
        await screen.findByText('Screenshot');
        const cell = document.querySelector('[data-file-kind="image"]');
        expect(cell).not.toBeNull();
        expect(cell).toHaveTextContent(BG.common.fileKinds.image);
        expect(cell!.textContent).not.toContain('Image');
    });
});

describe('the "all current" celebration', () => {
    it('is translated, and names the 30-day window it checks', async () => {
        mount([evidenceRow()], metrics({ total: 1, expired: 0, expiringSoon: 0, needsReview: 0, current: 1 }));
        await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
        const [message, opts] = toastSuccess.mock.calls[0] as [string, { description?: string }];
        expect(message).toBe(BG.evidence.list.allCurrentMessage);
        expect(opts.description).toBe(BG.evidence.list.allCurrentDescription);
        // The English copy says 30 days, never "this week".
        expect(EN.evidence.list.allCurrentDescription).toMatch(/30 days/);
        expect(EN.evidence.list.allCurrentDescription).not.toMatch(/week/);
    });
});
