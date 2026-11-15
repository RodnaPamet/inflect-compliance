/** @jest-environment jsdom */

/**
 * StatusBreakdown's default empty state is in the reader's language (#5309).
 * It was an English literal, shown on the vendor and controls dashboards of a
 * tenant with nothing to count.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

const mockBg: Record<string, unknown> = require('../../messages/bg.json');
jest.mock('next-intl', () => {
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const make = (ns: string) => (key: string) => {
        const v = walk(mockBg, ns ? `${ns}.${key}` : key);
        return typeof v === 'string' ? v : key;
    };
    return { useTranslations: (ns = '') => make(ns), useLocale: () => 'bg' };
});

import { StatusBreakdown } from '@/components/ui/status-breakdown';

const bgNoData = (mockBg.common as { ui: { noData: string } }).ui.noData;

describe('<StatusBreakdown> empty state in Bulgarian', () => {
    it('reads the catalogue, not English', () => {
        render(<StatusBreakdown items={[]} />);
        expect(screen.getByText(bgNoData)).toBeInTheDocument();
        expect(screen.queryByText('No data')).toBeNull();
    });

    it('a caller-supplied empty state still wins', () => {
        render(<StatusBreakdown items={[]} emptyState={<span>Nothing yet</span>} />);
        expect(screen.getByText('Nothing yet')).toBeInTheDocument();
        expect(screen.queryByText(bgNoData)).toBeNull();
    });
});
