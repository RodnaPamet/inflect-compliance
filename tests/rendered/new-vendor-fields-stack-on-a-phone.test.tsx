/**
 * The new-vendor form's paired rows stack below `sm`.
 *
 * At 360px the form kept two- and three-column grids, so each select was
 * about 90px wide and the data-access one read "— Ни…" (#5884). Every row of
 * fields is one column on a phone and its old column count from `sm` up.
 */
import { render } from '@testing-library/react';
import * as React from 'react';

jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
    useLocale: () => 'bg',
}));

import { NewVendorFields } from '@/app/t/[tenantSlug]/(app)/vendors/_form/NewVendorFields';
import type { NewVendorFormReturn } from '@/app/t/[tenantSlug]/(app)/vendors/_form/useNewVendorForm';

const form: NewVendorFormReturn = {
    fields: {
        name: '',
        legalName: '',
        websiteUrl: '',
        domain: '',
        country: '',
        description: '',
        criticality: 'MEDIUM',
        dataAccess: '',
        isSubprocessor: false,
        nextReviewAt: '',
        contractRenewalAt: '',
    },
    setField: jest.fn(),
    touchField: jest.fn(),
    fieldError: () => undefined,
    submitting: false,
    error: null,
    canSubmit: false,
    submit: jest.fn(),
    isDirty: false,
};

/** The grid that holds the element with this id, nearest first. */
function gridOf(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error(`no #${id}`);
    const grid = el.closest('.grid');
    if (!grid) throw new Error(`#${id} is not in a grid`);
    return grid as HTMLElement;
}

describe('new-vendor fields on a phone', () => {
    it('every row of fields is one column below sm', () => {
        const { container } = render(<NewVendorFields form={form} />);
        const grids = Array.from(container.querySelectorAll<HTMLElement>('.grid'));
        expect(grids.length).toBe(4);
        for (const g of grids) {
            expect(g).toHaveClass('grid-cols-1');
            expect(g).not.toHaveClass('grid-cols-2');
            expect(g).not.toHaveClass('grid-cols-3');
        }
    });

    it('keeps the desktop columns from sm up', () => {
        render(<NewVendorFields form={form} />);
        expect(gridOf('vendor-legal-name')).toHaveClass('sm:grid-cols-2');
        expect(gridOf('vendor-website')).toHaveClass('sm:grid-cols-2');
        expect(gridOf('vendor-status-on-create')).toHaveClass('sm:grid-cols-3');
        expect(gridOf('vendor-criticality-select')).toBe(gridOf('vendor-status-on-create'));
    });
});
