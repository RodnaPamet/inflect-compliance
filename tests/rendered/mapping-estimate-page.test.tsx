/** @jest-environment jsdom */

/**
 * The SOC 2 / NIS2 page says it is an estimate from ISO 27001 controls, has
 * a visible heading, and says "no related control" instead of 0% (#4737).
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

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
    usePathname: () => '/t/acme/mapping',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import MappingPage from '@/app/t/[tenantSlug]/(app)/mapping/page';

const EN = jest.requireActual('../../messages/en.json') as { mapping: Record<string, string> };
const M = EN.mapping;

const item = (code: string, controlCount: number, implementedCount: number, evidenceCount: number) => ({
    code, title: `Criterion ${code}`, description: 'd', controlCount, implementedCount, evidenceCount,
    coverage: controlCount > 0 ? Math.round((implementedCount / controlCount) * 100) : 0,
});

beforeEach(() => {
    global.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ soc2: [item('CC1.1', 4, 2, 3), item('CC9.9', 0, 0, 0)], nis2: [] }),
    })) as unknown as typeof fetch;
});

describe('SOC 2 and NIS2 estimate', () => {
    it('has a visible heading and says the figures are an estimate from ISO 27001', async () => {
        render(<MappingPage />);
        const heading = await screen.findByRole('heading', { level: 1, name: M.title });
        expect(heading).not.toHaveClass('sr-only');
        expect(document.getElementById('mapping-estimate-notice')).toHaveTextContent(M.estimateNote);
    });

    it('says a criterion with no related control has none, rather than 0%', async () => {
        render(<MappingPage />);
        const empty = await screen.findByTestId('mapping-item-CC9.9');
        expect(empty).toHaveTextContent(M.relatedNone);
        expect(empty).not.toHaveTextContent('0%');
    });

    it('shows how many related controls carry evidence', async () => {
        render(<MappingPage />);
        const row = await screen.findByTestId('mapping-item-CC1.1');
        expect(row).toHaveTextContent('50%');
        expect(row).toHaveTextContent(M.withEvidence.replace('{count}', '3').replace('{total}', '4'));
    });
});
