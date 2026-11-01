/**
 * THE OVERDUE-EVIDENCE LIST READS IN WORDS (#4847).
 *
 *   1. "12 days overdue", never the compact "12d", with "1 day" for one.
 *   2. The first column says Workspace, and the subtitle says it shows the
 *      rows loaded so far, with a note when more are available.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    const resolve = (path: string): unknown =>
        path.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    // `{name}` and the flat `plural` blocks the catalogue uses.
    const PLURAL = /\{(\w+),\s*plural,((?:\s*(?:=\d+|one|other)\s*\{[^{}]*\})+)\s*\}/g;
    const OPTION = /(=\d+|one|other)\s*\{([^{}]*)\}/g;
    const format = (str: string, params?: Record<string, unknown>) =>
        str
            .replace(PLURAL, (block: string, name: string, options: string) => {
                if (!params || !(name in params)) return block;
                const n = Number(params[name]);
                const forms = new Map<string, string>();
                for (const m of options.matchAll(OPTION)) forms.set(m[1], m[2]);
                const body = forms.get(`=${n}`) ?? (n === 1 ? forms.get('one') : undefined) ?? forms.get('other');
                return body === undefined ? block : body.split('#').join(String(n));
            })
            .replace(/\{(\w+)\}/g, (m: string, name: string) => (params && name in params ? String(params[name]) : m));
    const cache = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) {
                cache.set(ns, (key: string, params?: Record<string, unknown>) => {
                    const v = resolve(`${ns}.${key}`);
                    return typeof v === 'string' ? format(v, params) : key;
                });
            }
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

import { EvidenceTable } from '@/app/org/[orgSlug]/(app)/evidence/EvidenceTable';
import type { OverdueEvidenceRow } from '@/app-layer/schemas/portfolio';

const row = (n: number, daysOverdue: number): OverdueEvidenceRow => ({
    evidenceId: `e-${n}`,
    tenantId: 't-alpha',
    tenantSlug: 'alpha',
    tenantName: 'Alpha Co',
    title: `evidence ${n}`,
    nextReviewDate: '2026-10-01',
    daysOverdue,
    status: 'SUBMITTED',
    drillDownUrl: `/t/alpha/evidence/e-${n}`,
});

describe('the overdue-evidence list', () => {
    it('says how many days, in words', () => {
        render(<EvidenceTable rows={[row(1, 1), row(2, 12)]} nextCursor={null} orgSlug="acme" />);
        const table = screen.getByTestId('org-evidence-table');
        expect(within(table).getByText('1 day overdue')).toBeInTheDocument();
        expect(within(table).getByText('12 days overdue')).toBeInTheDocument();
        expect(within(table).queryByText(/\d+d overdue/)).toBeNull();
    });

    it('names the workspace column, and says it shows the rows loaded so far', () => {
        render(<EvidenceTable rows={[row(1, 3), row(2, 4)]} nextCursor="next" orgSlug="acme" />);
        expect(screen.getByRole('columnheader', { name: /Workspace/ })).toBeInTheDocument();
        expect(screen.queryByRole('columnheader', { name: /Tenant/ })).toBeNull();
        expect(
            screen.getByText(/^Showing 2 evidence items not yet approved, whose review date has passed/),
        ).toHaveTextContent('— more to load below');
    });
});
