/**
 * The admin Personnel page says what it can do and what it is showing (#4470).
 *
 * Pinned here by what a viewer sees:
 *
 *   1. The empty state promised "add a person", and the page cannot add one;
 *      it also named BambooHR alone among the HRIS providers.
 *   2. Status and Source were printed as raw codes (TERMINATED, MANUAL).
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/personnel',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    const href = (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    return { useTenantApiUrl: () => apiUrl, useTenantHref: () => href };
});

import { PersonnelClient, type EmployeeRow } from '@/app/t/[tenantSlug]/(app)/admin/personnel/PersonnelClient';
import { HRIS_PROVIDERS } from '@/app-layer/integrations/providers/hris';
import en from '../../messages/en.json';
import bg from '../../messages/bg.json';

const person = (over: Partial<EmployeeRow> = {}): EmployeeRow => ({
    id: 'e-1',
    fullName: 'Ada Lovelace',
    workEmail: 'ada@acme.test',
    status: 'ACTIVE',
    department: null,
    jobTitle: null,
    managerEmployeeId: null,
    source: 'HRIS',
    ...over,
});

function renderPage(rows: EmployeeRow[]) {
    return render(<PersonnelClient initialRows={rows} tenantSlug="acme" />);
}

beforeEach(() => {
    window.history.replaceState({}, '', '/t/acme/admin/personnel');
});

describe('the empty state describes an HRIS-synced roster', () => {
    it('does not offer to add a person, and names no single HRIS', () => {
        renderPage([]);

        expect(screen.getByText(en.personnel.emptyDesc)).toBeInTheDocument();
        expect(screen.queryByText(/add a person/i)).not.toBeInTheDocument();
        for (const text of [en.personnel.emptyDesc, bg.personnel.emptyDesc, en.personnel.description, bg.personnel.description]) {
            for (const provider of HRIS_PROVIDERS) {
                expect(text.toLowerCase()).not.toContain(provider);
            }
        }
        // Neither header line says the page adds people by hand.
        expect(en.personnel.description).not.toMatch(/manual/i);
        expect(bg.personnel.description).not.toMatch(/ръчно/i);
    });
});

describe('status and source are words, not codes', () => {
    it('renders the translated labels', () => {
        renderPage([
            person({ id: 'e-1', status: 'TERMINATED', source: 'MANUAL' }),
            person({ id: 'e-2', workEmail: 'bob@acme.test', status: 'ONBOARDING', source: 'HRIS' }),
        ]);
        const table = screen.getByRole('table');

        expect(within(table).getByText(en.personnel.filterEnums.status.TERMINATED)).toBeInTheDocument();
        expect(within(table).getByText(en.personnel.filterEnums.status.ONBOARDING)).toBeInTheDocument();
        expect(within(table).getByText(en.personnel.sourceLabels.MANUAL)).toBeInTheDocument();
        expect(within(table).queryByText('TERMINATED')).not.toBeInTheDocument();
        expect(within(table).queryByText('ONBOARDING')).not.toBeInTheDocument();
        expect(within(table).queryByText('MANUAL')).not.toBeInTheDocument();
    });

    it('falls back to the stored value for a code it has no label for', () => {
        renderPage([person({ source: 'IMPORT' })]);
        expect(within(screen.getByRole('table')).getByText('IMPORT')).toBeInTheDocument();
    });
});
