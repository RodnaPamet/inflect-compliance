/**
 * Asset create/edit form field changes (2026-06-06):
 *   - Create: classification + data-residency are dropdowns; owner is a
 *     people-picker; a "Risk Assessment" section titles the C/I/A triple.
 *   - Edit: 'Assigned to' → 'Owner'; the free-text 'Owner (label)' and
 *     'External Ref' fields are gone; classification is a dropdown; the
 *     dropdown triggers are full-width (no truncation).
 *   - Detail: the 'Suggest Risks' action is gone; the C/I/A block is
 *     titled 'Risk Assessment'.
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';
import * as fs from 'fs';
import * as path from 'path';
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

import { NewAssetFields } from '@/app/t/[tenantSlug]/(app)/assets/_form/NewAssetFields';
import { EditAssetFields } from '@/app/t/[tenantSlug]/(app)/assets/_form/EditAssetFields';

// #2246 Class A — `codeOf` masks comments at the READ SEAM. Reads whose result
// is JSON.parse'd are left RAW on purpose: a catalogue is parsed as DATA, never
// matched as text, so masking it would only corrupt the parse.
import { codeOf } from '../helpers/source-blocks';

beforeEach(() => {
    global.fetch = jest.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve([]) }),
    ) as unknown as typeof fetch;
});

function withClient(node: React.ReactNode) {
    return render(
        <SWRConfig value={{ provider: () => new Map() }}>
            <TooltipProvider>{node}</TooltipProvider>
        </SWRConfig>,
    );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockForm(fields: Record<string, any>): any {
    return {
        fields,
        setField: jest.fn(),
        touchField: jest.fn(),
        fieldError: () => undefined,
        submitting: false,
        error: null,
        canSubmit: true,
        submit: jest.fn(),
        isDirty: false,
    };
}

const NEW_LABELS = {
    name: 'Name', type: 'Type', classification: 'Classification',
    classificationPlaceholder: '', owner: 'Owner', location: 'Location',
    dataResidency: 'Data Residency', residencyPlaceholder: '',
    confidentiality: 'Confidentiality', integrity: 'Integrity', availability: 'Availability',
};

describe('NewAssetFields (create)', () => {
    const form = mockForm({
        name: '', type: 'SYSTEM', status: 'ACTIVE', classification: '', ownerUserId: '',
        location: '', dataResidency: '', confidentiality: 3, integrity: 3, availability: 3,
    });

    it('classification + data-residency + owner + status are dropdowns (buttons), not text inputs', () => {
        withClient(<NewAssetFields form={form} labels={NEW_LABELS} tenantSlug="acme" />);
        for (const id of ['asset-classification-input', 'asset-data-residency-input', 'asset-owner-input', 'asset-status-select']) {
            const el = document.getElementById(id);
            expect(el).not.toBeNull();
            expect(el!.tagName.toLowerCase()).toBe('button'); // Combobox/UserCombobox trigger
        }
    });

    it('titles the C/I/A box "Asset Criticality" with sliders + a score', () => {
        const { container } = withClient(<NewAssetFields form={form} labels={NEW_LABELS} tenantSlug="acme" />);
        expect(screen.getByText('Asset Criticality')).not.toBeNull();
        // C/I/A are sliders now (not NumberSteppers)
        expect(container.querySelectorAll('input[type="range"]').length).toBe(3);
        expect(screen.getByTestId('asset-criticality-score')).not.toBeNull();
    });
});

describe('EditAssetFields (edit)', () => {
    const form = mockForm({
        name: 'A', type: 'SYSTEM', criticality: 'MEDIUM', status: 'ACTIVE',
        ownerUserId: '', owner: 'legacy', externalRef: 'EXT-1', classification: '', location: '',
        dataResidency: '', confidentiality: 3, integrity: 3, availability: 3,
    });

    it("renames 'Assigned to' → 'Owner' and drops 'Owner (label)' + 'External Ref'", () => {
        withClient(<EditAssetFields form={form} tenantSlug="acme" />);
        expect(screen.getByText('Owner')).not.toBeNull();
        expect(screen.queryByText('Assigned to')).toBeNull();
        expect(screen.queryByText('Owner (label)')).toBeNull();
        expect(screen.queryByText('External Ref')).toBeNull();
    });

    it('drops the Criticality dropdown and gains Data Residency (parity with create)', () => {
        const { container } = withClient(<EditAssetFields form={form} tenantSlug="acme" />);
        // Scope to field labels (the score badge also renders "Criticality").
        const labels = [...container.querySelectorAll('label.input-label')].map(
            (l) => l.textContent,
        );
        expect(labels).not.toContain('Criticality');
        expect(labels).toContain('Data Residency');
        expect(labels).toContain('Status');
    });

    it('classification is a dropdown (button) + all dropdown triggers are full-width', () => {
        const { container } = withClient(<EditAssetFields form={form} tenantSlug="acme" />);
        // Every Combobox trigger button carries w-full (truncation fix).
        const triggers = container.querySelectorAll('button.w-full');
        expect(triggers.length).toBeGreaterThanOrEqual(4); // type, criticality, status, classification
    });
});

describe('asset detail page source', () => {
    const src = codeOf(fs.readFileSync(
        path.join(__dirname, '..', '..', 'src/app/t/[tenantSlug]/(app)/assets/[id]/page.tsx'),
        'utf8',
    ));
    it('no longer renders the Suggest Risks action', () => {
        expect(src).not.toMatch(/suggest-risks-btn/);
        expect(src).not.toMatch(/Suggest Risks/);
    });
    it('titles the criticality block "Asset Criticality" and shows only the score (no C/I/A breakdown)', () => {
        // Heading migrated to next-intl; assert the key + its en value.
        expect(src).toMatch(/t\('detail\.criticalityHeading'\)/);
        const enAssets = JSON.parse(
            fs.readFileSync(path.join(__dirname, '..', '..', 'messages/en.json'), 'utf8'),
        ).assets;
        expect(enAssets.detail.criticalityHeading).toBe('Asset Criticality');
        expect(src).not.toMatch(/Risk Assessment/);
        expect(src).toMatch(/AssetCriticalityBadge/);
        expect(src).not.toMatch(/label="Confidentiality"/);
    });
});
