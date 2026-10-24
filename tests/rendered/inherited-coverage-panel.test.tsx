/**
 * The framework Coverage tab's "Coverage from your other frameworks" panel.
 *
 *   1. IT LISTS WHAT IS OPEN, AND HOW IT IS REACHED: each requirement with no
 *      control of its own, its inherited status, and every route in — the
 *      other framework's requirement, the mapping's strength, and the tenant's
 *      controls on it, each linked to the control.
 *   2. A REQUIREMENT WITH ITS OWN CONTROL IS LEFT OUT, even when routes reach
 *      it: the direct figures above already account for it.
 *   3. NOTHING REACHED IS SAID IN WORDS, not rendered as an empty list.
 *   4. A TRUNCATED REPORT SAYS ITS COUNTS ARE LOWER BOUNDS.
 *   5. IT ASKS FOR THE RIGHT REPORT: the framework's own route, `inherited-coverage` action.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => {
        const dict = (en as Record<string, unknown>)[ns] ?? {};
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
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

let payload: Record<string, unknown> | undefined;
const requestedPaths: string[] = [];
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (path: string) => {
        requestedPaths.push(path);
        return { data: payload, error: undefined, isLoading: !payload, mutate: jest.fn() };
    },
}));

import { InheritedCoveragePanel } from '@/components/frameworks/InheritedCoveragePanel';

const control = (id: string, code: string | null, name: string) => ({ id, code, name, status: 'IMPLEMENTED' });

function report(over: Record<string, unknown> = {}) {
    return {
        framework: { key: 'AIUC-1', name: 'AIUC-1 AI Agent Standard' },
        total: 50,
        summary: { direct: 1, partiallyCovered: 1, reviewNeeded: 1, notCovered: 47 },
        sourceFrameworks: [{ key: 'ISO42001-2023', name: 'ISO/IEC 42001:2023', requirements: 3 }],
        requirements: [
            {
                code: 'E015',
                title: 'Log AI system activity',
                section: 'E. Accountability',
                status: 'PARTIALLY_COVERED',
                routes: [
                    {
                        frameworkKey: 'ISO42001-2023',
                        frameworkName: 'ISO/IEC 42001:2023',
                        requirementCode: 'A.6.2.8',
                        requirementTitle: 'Log events across the system life cycle',
                        strength: 'INTERSECT',
                        controls: [control('c-log', 'LOG-1', 'Event logging')],
                    },
                ],
            },
            {
                code: 'F001',
                title: 'Prevent AI cyber misuse',
                section: 'F. Society',
                status: 'REVIEW_NEEDED',
                routes: [
                    {
                        frameworkKey: 'ISO42001-2023',
                        frameworkName: 'ISO/IEC 42001:2023',
                        requirementCode: 'A.5.5',
                        requirementTitle: 'Assess broader societal impacts',
                        strength: 'RELATED',
                        controls: [control('c-soc', null, 'Societal impact review')],
                    },
                ],
            },
            {
                code: 'A001',
                title: 'Establish input data policy',
                section: 'A. Data & Privacy',
                status: 'DIRECT',
                routes: [
                    {
                        frameworkKey: 'ISO42001-2023',
                        frameworkName: 'ISO/IEC 42001:2023',
                        requirementCode: 'A.8.2',
                        requirementTitle: 'Provide user-facing system documentation',
                        strength: 'RELATED',
                        controls: [control('c-doc', 'DOC-1', 'User documentation')],
                    },
                ],
            },
        ],
        truncated: false,
        ...over,
    };
}

beforeEach(() => {
    payload = undefined;
    requestedPaths.length = 0;
});

describe('InheritedCoveragePanel', () => {
    it('lists each open requirement with its status, its routes in and the controls behind them', () => {
        payload = report();
        render(<InheritedCoveragePanel tenantSlug="acme" frameworkKey="AIUC-1" />);

        const logging = screen.getByTestId('inherited-requirement-E015');
        expect(within(logging).getByText('Log AI system activity')).toBeTruthy();
        expect(within(logging).getByText('Partially covered')).toBeTruthy();
        expect(within(logging).getByText('A.6.2.8')).toBeTruthy();
        expect(within(logging).getByText('Overlapping')).toBeTruthy();
        const link = within(logging).getByRole('link', { name: 'LOG-1 · Event logging' });
        expect(link.getAttribute('href')).toBe('/t/acme/controls/c-log');

        const misuse = screen.getByTestId('inherited-requirement-F001');
        expect(within(misuse).getByText('Review needed')).toBeTruthy();
        expect(within(misuse).getByText('Related')).toBeTruthy();
        // A control with no code falls back to its name.
        expect(within(misuse).getByRole('link', { name: 'Societal impact review' })).toBeTruthy();
    });

    it('leaves out a requirement that has its own control, even when routes reach it', () => {
        payload = report();
        render(<InheritedCoveragePanel tenantSlug="acme" frameworkKey="AIUC-1" />);

        expect(screen.queryByTestId('inherited-requirement-A001')).toBeNull();
        expect(screen.getByTestId('inherited-coverage-list').querySelectorAll(':scope > li')).toHaveLength(2);
    });

    it('says in words when no other framework reaches this one', () => {
        payload = report({
            summary: { direct: 1, partiallyCovered: 0, reviewNeeded: 0, notCovered: 49 },
            sourceFrameworks: [],
            requirements: [],
        });
        render(<InheritedCoveragePanel tenantSlug="acme" frameworkKey="AIUC-1" />);

        expect(screen.getByText('No other framework reaches this one yet')).toBeTruthy();
        expect(screen.queryByTestId('inherited-coverage-list')).toBeNull();
    });

    it('says so when everything other frameworks reach already has its own control', () => {
        const all = report();
        payload = {
            ...all,
            requirements: (all.requirements as Array<{ status: string }>).filter((r) => r.status === 'DIRECT'),
        };
        render(<InheritedCoveragePanel tenantSlug="acme" frameworkKey="AIUC-1" />);

        expect(
            screen.getByText('Every requirement your other frameworks reach already has a control of its own.'),
        ).toBeTruthy();
        expect(screen.queryByText('No other framework reaches this one yet')).toBeNull();
    });

    it('says the counts are lower bounds when the report is truncated', () => {
        payload = report({ truncated: true });
        render(<InheritedCoveragePanel tenantSlug="acme" frameworkKey="AIUC-1" />);

        expect(screen.getByTestId('inherited-coverage-truncated')).toBeTruthy();
    });

    it('shows no truncation notice on a complete report', () => {
        payload = report();
        render(<InheritedCoveragePanel tenantSlug="acme" frameworkKey="AIUC-1" />);

        expect(screen.queryByTestId('inherited-coverage-truncated')).toBeNull();
    });

    it('asks the framework route for its inherited-coverage report', () => {
        payload = report();
        render(<InheritedCoveragePanel tenantSlug="acme" frameworkKey="AIUC-1" />);

        expect(requestedPaths[0]).toBe('/frameworks/AIUC-1?action=inherited-coverage');
    });
});
