/**
 * The asset criticality band reads in the page's language.
 *
 * `getAssetCriticality` and `CRITICALITY_PRESENTATION` carry the band's
 * English name as its identity (the write path maps it to the stored enum),
 * and the form's score box and the detail page's badge printed that name: a
 * Bulgarian `assets/new` and `assets/[id]` read "Medium" and "Critical"
 * (#5884). Both now render the band through
 * `assets.filterEnums.criticality.<LEVEL>`, the same words as the list filter.
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';
import { SWRConfig } from 'swr';
import { TooltipProvider } from '@/components/ui/tooltip';

jest.mock('next-intl', () => {
    const bg = require('../../messages/bg.json');
    return {
        useTranslations: (ns: string) => (key: string) => {
            const v = key
                .split('.')
                .reduce(
                    (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                    bg[ns],
                );
            return typeof v === 'string' ? v : key;
        },
        useLocale: () => 'bg',
    };
});

import {
    AssetCriticalityFields,
    AssetCriticalityBadge,
} from '@/app/t/[tenantSlug]/(app)/assets/_form/AssetCriticalityFields';
import { getAssetCriticality } from '@/app/t/[tenantSlug]/(app)/assets/_form/asset-criticality';

const BG = jest.requireActual('../../messages/bg.json') as {
    assets: { filterEnums: { criticality: Record<'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL', string> } };
};
const BAND = BG.assets.filterEnums.criticality;
const ENGLISH_BANDS = /\b(Low|Medium|High|Critical)\b/;

function mount(node: React.ReactNode) {
    return render(
        <SWRConfig value={{ provider: () => new Map() }}>
            <TooltipProvider>{node}</TooltipProvider>
        </SWRConfig>,
    );
}

describe('asset criticality band in Bulgarian', () => {
    it('names the level the label stands for', () => {
        expect(getAssetCriticality(5, 1, 1).level).toBe('CRITICAL');
        expect(getAssetCriticality(4, 4, 1).level).toBe('HIGH');
        expect(getAssetCriticality(3, 3, 1).level).toBe('MEDIUM');
        expect(getAssetCriticality(1, 1, 1).level).toBe('LOW');
    });

    it('the form score box shows the translated band', () => {
        mount(<AssetCriticalityFields confidentiality={5} integrity={2} availability={3} onChange={() => {}} />);
        const score = screen.getByTestId('asset-criticality-score');
        expect(score.textContent).toContain(BAND.CRITICAL);
        expect(score.textContent).not.toMatch(ENGLISH_BANDS);
    });

    it('the detail badge shows the translated band derived from the triad', () => {
        mount(<AssetCriticalityBadge confidentiality={4} integrity={1} availability={2} />);
        const badge = screen.getByTestId('asset-criticality-score');
        expect(badge.textContent).toContain(BAND.MEDIUM);
        expect(badge.textContent).not.toMatch(ENGLISH_BANDS);
    });

    it('the detail badge shows the translated STORED band when there is one', () => {
        // The triad says Medium; the stored enum wins, as the list filter does.
        mount(<AssetCriticalityBadge confidentiality={4} integrity={1} availability={2} storedCriticality="HIGH" />);
        const badge = screen.getByTestId('asset-criticality-score');
        expect(badge.textContent).toContain(BAND.HIGH);
        expect(badge.textContent).not.toMatch(ENGLISH_BANDS);
    });
});
