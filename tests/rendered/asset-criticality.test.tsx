/**
 * Asset criticality rework (2026-06-06):
 *   A1 — the C/I/A box is titled "Asset Criticality".
 *   A2 — C/I/A are sliders + a high-water-mark score that colours by level,
 *        in BOTH the create and edit modals.
 *   A3 — the detail Overview shows only the score (AssetCriticalityBadge).
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';
import { SWRConfig } from 'swr';
import { TooltipProvider } from '@/components/ui/tooltip';

// next-intl is ESM (jest can't parse its export); mock it to resolve real
// en.json values so the components render English and text assertions hold.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    return {
        useTranslations: (ns: string) => (key: string) => {
            const v = key
                .split('.')
                .reduce((o: unknown, k) =>
                    o && typeof o === 'object'
                        ? (o as Record<string, unknown>)[k]
                        : undefined, en[ns]);
            return typeof v === 'string' ? v : key;
        },
        useLocale: () => 'en',
    };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/assets',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import { getAssetCriticality } from '@/app/t/[tenantSlug]/(app)/assets/_form/asset-criticality';
import {
    AssetCriticalityFields,
    AssetCriticalityBadge,
} from '@/app/t/[tenantSlug]/(app)/assets/_form/AssetCriticalityFields';
import { EditAssetFields } from '@/app/t/[tenantSlug]/(app)/assets/_form/EditAssetFields';

function withProviders(node: React.ReactNode) {
    return render(
        <SWRConfig value={{ provider: () => new Map() }}>
            <TooltipProvider>{node}</TooltipProvider>
        </SWRConfig>,
    );
}

describe('getAssetCriticality — top-two-mean with critical override (item 25)', () => {
    it.each([
        // [C, I, A, expectedScore, expectedLabel]
        [1, 1, 1, 1, 'Low'],
        // A single Medium/High dimension no longer dominates: the mean of
        // the two highest pulls it back down.
        [3, 1, 1, 2, 'Low'], // top two {3,1} → mean 2 → Low (was Medium under max())
        [4, 1, 1, 3, 'Medium'], // top two {4,1} → mean 2.5 → 3 → Medium (was High under max())
        // It takes two elevated dimensions to raise the band.
        [4, 4, 1, 4, 'High'], // top two {4,4} → mean 4 → High
        [4, 3, 1, 4, 'High'], // top two {4,3} → mean 3.5 → 4 → High
        [3, 3, 1, 3, 'Medium'], // top two {3,3} → mean 3 → Medium
        // All-High but no ceiling dimension stays High, NOT Critical.
        [4, 4, 4, 4, 'High'],
        // Critical override — a single ceiling (5) dimension forces
        // Critical regardless of the other two.
        [5, 1, 1, 5, 'Critical'],
        [1, 1, 5, 5, 'Critical'],
        [5, 5, 5, 5, 'Critical'],
    ])('C=%i I=%i A=%i → score %i / %s', (c, i, a, score, label) => {
        const r = getAssetCriticality(c, i, a);
        expect(r.score).toBe(score);
        expect(r.label).toBe(label);
    });
});

describe('AssetCriticalityFields (A1/A2)', () => {
    it('renders the title, 3 sliders, and a coloured score (max + label)', () => {
        const { container } = withProviders(
            <AssetCriticalityFields
                confidentiality={5}
                integrity={2}
                availability={3}
                onChange={() => {}}
            />,
        );
        expect(screen.getByText('Asset Criticality')).not.toBeNull();
        const ranges = container.querySelectorAll('[role="slider"]');
        expect(ranges.length).toBe(3);
        expect(document.getElementById('asset-confidentiality')).not.toBeNull();
        expect(document.getElementById('asset-integrity')).not.toBeNull();
        expect(document.getElementById('asset-availability')).not.toBeNull();
        const score = screen.getByTestId('asset-criticality-score');
        expect(score.textContent).toMatch(/5/);
        expect(score.textContent).toMatch(/Critical/);
    });

    it('honours idPrefix for the edit modal', () => {
        withProviders(
            <AssetCriticalityFields idPrefix="asset-edit" confidentiality={1} integrity={1} availability={1} onChange={() => {}} />,
        );
        expect(document.getElementById('asset-edit-confidentiality')).not.toBeNull();
        expect(screen.getByTestId('asset-edit-criticality-score')).not.toBeNull();
    });
});

describe('AssetCriticalityBadge (A3 — detail Overview)', () => {
    it('shows the score + label and no sliders', () => {
        // C=4, I=1, A=2 → top two {4,2} → mean 3 → Medium (under the
        // item-25 model; was High under the old high-water-mark rule).
        const { container } = withProviders(
            <AssetCriticalityBadge confidentiality={4} integrity={1} availability={2} />,
        );
        expect(container.querySelectorAll('[role="slider"]').length).toBe(0);
        const badge = screen.getByTestId('asset-criticality-score');
        expect(badge.textContent).toMatch(/3/);
        expect(badge.textContent).toMatch(/Medium/);
    });
});

describe('EditAssetFields includes the criticality box (A2 edit side)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const form: any = {
        fields: { name: 'A', type: 'SYSTEM', criticality: 'MEDIUM', status: 'ACTIVE', ownerUserId: '', owner: '', externalRef: '', classification: '', location: '', confidentiality: 3, integrity: 4, availability: 2 },
        setField: jest.fn(),
    };
    it('renders the asset-edit criticality sliders + score', () => {
        const { container } = withProviders(<EditAssetFields form={form} tenantSlug="acme" />);
        expect(screen.getByText('Asset Criticality')).not.toBeNull();
        expect(container.querySelectorAll('[role="slider"]').length).toBe(3);
        expect(screen.getByTestId('asset-edit-criticality-score')).not.toBeNull();
    });
});
