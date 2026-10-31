/** @jest-environment jsdom */

/**
 * The framework-updates page shows what an update changed, and offers its
 * actions only to a role that can take them (#4736).
 */
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

// A stable translator per namespace, as next-intl gives.
jest.mock('next-intl', () => {
    const shared = jest.requireActual('../../__mocks__/next-intl.js');
    const translators = new Map<string, unknown>();
    return {
        ...shared,
        useTranslations: (ns: string) => {
            if (!translators.has(ns)) translators.set(ns, shared.useTranslations(ns));
            return translators.get(ns);
        },
    };
});

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/framework-updates',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import { FrameworkUpdatesClient, type DeltaRow } from '@/app/t/[tenantSlug]/(app)/framework-updates/FrameworkUpdatesClient';

const EN = jest.requireActual('../../messages/en.json') as {
    frameworkUpdates: Record<string, string> & { status: Record<string, string>; failed: Record<string, string> };
};
const U = EN.frameworkUpdates;

const DELTA: DeltaRow = {
    id: 'd1',
    frameworkKey: 'ISO27001',
    frameworkName: 'ISO/IEC 27001',
    fromVersion: '2013',
    toVersion: '2022',
    newGapCount: 1,
    flaggedControlCount: 1,
    status: 'NEW',
    createdAt: '2026-10-01T00:00:00.000Z',
    changelog: 'Threat intelligence added.',
    added: [{ code: '5.7', title: 'Threat intelligence' }],
    changed: [],
    removed: [{ code: 'A.6.1.5', title: null }],
    flaggedControls: [{ id: 'c1', code: 'A.5.1', name: 'Information security policy' }],
};

const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
    global.fetch = jest.fn(async () => reply(200, { created: 1 })) as unknown as typeof fetch;
});

describe('framework updates', () => {
    it('shows the changelog, the framework by name, the requirement titles and the flagged controls by name', () => {
        render(<FrameworkUpdatesClient tenantSlug="acme" initialDeltas={[DELTA]} canWrite />);
        expect(screen.getByTestId('delta-changelog-d1')).toHaveTextContent('Threat intelligence added.');
        expect(screen.getByText('ISO/IEC 27001 v2013 → v2022')).toBeInTheDocument();
        expect(screen.getByText(U.status.NEW)).toBeInTheDocument();
        expect(screen.queryByText('NEW')).toBeNull();
        expect(screen.getByTestId('delta-added-d1')).toHaveTextContent('5.7 — Threat intelligence');
        const flagged = screen.getByRole('link', { name: 'A.5.1 — Information security policy' });
        expect(flagged).toHaveAttribute('href', '/t/acme/controls/c1');
    });

    it('offers no write action to a role the server refuses, and says who can', () => {
        render(<FrameworkUpdatesClient tenantSlug="acme" initialDeltas={[DELTA]} canWrite={false} />);
        expect(document.getElementById('delta-review-d1')).toBeNull();
        expect(document.getElementById('delta-materialize-d1')).toBeNull();
        expect(document.getElementById('delta-dismiss-d1')).toBeNull();
        expect(document.getElementById('delta-restricted-d1')).toHaveTextContent(U.restricted);
    });

    it('names the action that failed, not the URL segment', async () => {
        global.fetch = jest.fn(async () => reply(500, {})) as unknown as typeof fetch;
        render(<FrameworkUpdatesClient tenantSlug="acme" initialDeltas={[DELTA]} canWrite />);
        await act(async () => { fireEvent.click(document.getElementById('delta-materialize-d1')!); });
        expect(document.getElementById('framework-update-error')).toHaveTextContent(U.failed.materialize);
        expect(screen.queryByText(/materialize-findings/)).toBeNull();
    });

    it('says the update is gone on a 404, and who can act on a 403', async () => {
        global.fetch = jest.fn(async () => reply(404, {})) as unknown as typeof fetch;
        render(<FrameworkUpdatesClient tenantSlug="acme" initialDeltas={[DELTA]} canWrite />);
        await act(async () => { fireEvent.click(document.getElementById('delta-review-d1')!); });
        expect(document.getElementById('framework-update-error')).toHaveTextContent(U.notFound);

        global.fetch = jest.fn(async () => reply(403, {})) as unknown as typeof fetch;
        await act(async () => { fireEvent.click(document.getElementById('delta-dismiss-d1')!); });
        expect(document.getElementById('framework-update-error')).toHaveTextContent(U.restricted);
    });
});
