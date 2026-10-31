/** @jest-environment jsdom */

/**
 * The SOC 2 and NIS2 estimate on ISO 27001's Coverage tab. It replaced the
 * standalone `/mapping` page, and is offered only for a framework the
 * workspace does not use yet.
 *
 *   1. IT SHOWS ONLY THE FRAMEWORKS NOT IN USE, and nothing when both are.
 *   2. IT SAYS IT IS AN ESTIMATE and points to the frameworks' own pages.
 *   3. A CRITERION WITH NO RELATED CONTROL SAYS SO, rather than 0%, and is
 *      left out of the average.
 *   4. A FAILED READ IS AN ERROR WITH A RETRY, not an empty panel.
 */
import * as React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => {
        const dict = ns.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        ) ?? {};
        const t = (key: string, values?: Record<string, string | number>) => {
            const v = key.split('.').reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                dict,
            );
            if (typeof v !== 'string') return key;
            return values ? v.replace(/\{(\w+)\}/g, (m, name) => (name in values ? String(values[name]) : m)) : v;
        };
        t.rich = t;
        return t;
    };
    const cache = new Map<string, unknown>();
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) cache.set(ns, make(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

let payload: Record<string, unknown> | undefined;
let failure: Error | undefined;
const mutate = jest.fn();
const requestedPaths: string[] = [];
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (path: string) => {
        requestedPaths.push(path);
        return { data: payload, error: failure, isLoading: !payload && !failure, mutate };
    },
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

import { IsoEstimatePanel } from '@/components/frameworks/IsoEstimatePanel';

const EN = jest.requireActual('../../messages/en.json') as {
    frameworks: { detail: { isoEstimate: Record<string, string> } };
};
const M = EN.frameworks.detail.isoEstimate;

const item = (code: string, controlCount: number, implementedCount: number, evidenceCount: number) => ({
    code,
    title: `Criterion ${code}`,
    controlCount,
    implementedCount,
    evidenceCount,
    coverage: controlCount > 0 ? Math.round((implementedCount / controlCount) * 100) : 0,
});

function estimate(inUse: { soc2: boolean; nis2: boolean }) {
    return {
        soc2: [item('CC1.1', 4, 2, 3), item('CC2.1', 2, 2, 2), item('CC9.9', 0, 0, 0)],
        nis2: [item('NIS2-21.1', 1, 0, 0)],
        inUse,
    };
}

beforeEach(() => {
    payload = undefined;
    failure = undefined;
    mutate.mockReset();
    requestedPaths.length = 0;
});

describe('SOC 2 and NIS2 estimate panel', () => {
    it('asks for the estimate', () => {
        payload = estimate({ soc2: false, nis2: false });
        render(<IsoEstimatePanel />);
        expect(requestedPaths).toContain('/mapping');
    });

    it('shows only the frameworks the workspace does not use yet', () => {
        payload = estimate({ soc2: true, nis2: false });
        render(<IsoEstimatePanel />);
        expect(screen.queryByTestId('iso-estimate-soc2')).toBeNull();
        expect(screen.getByTestId('iso-estimate-nis2')).toBeInTheDocument();
    });

    it('renders nothing when the workspace uses both', () => {
        payload = estimate({ soc2: true, nis2: true });
        const { container } = render(<IsoEstimatePanel />);
        expect(container).toBeEmptyDOMElement();
    });

    it('says it is an estimate and links to the frameworks', () => {
        payload = estimate({ soc2: false, nis2: false });
        render(<IsoEstimatePanel />);
        const panel = screen.getByTestId('iso-estimate-panel');
        expect(panel).toHaveTextContent(M.description);
        expect(within(panel).getByRole('link', { name: M.frameworksLink })).toHaveAttribute('href', '/t/acme/frameworks');
    });

    it('averages over related criteria only, and says when a criterion has none', () => {
        payload = estimate({ soc2: false, nis2: true });
        render(<IsoEstimatePanel />);
        const soc2 = screen.getByTestId('iso-estimate-soc2');
        // CC1.1 is 50%, CC2.1 is 100%; CC9.9 relates to no control and is left out.
        expect(soc2).toHaveTextContent('2 of 3');
        expect(soc2).toHaveTextContent('75%');

        fireEvent.click(within(soc2).getByRole('button', { name: /CC|criteria/i }));
        const none = screen.getByTestId('iso-estimate-item-CC9.9');
        expect(none).toHaveTextContent(M.relatedNone);
        expect(none).not.toHaveTextContent('0%');
        expect(screen.getByTestId('iso-estimate-item-CC1.1')).toHaveTextContent('3/4 with evidence');
    });

    it('says the read failed and offers a retry', () => {
        failure = new Error('500');
        render(<IsoEstimatePanel />);
        expect(screen.getByText(M.errorTitle)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: M.retry }));
        expect(mutate).toHaveBeenCalled();
    });
});
