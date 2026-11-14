/** @jest-environment jsdom */

/**
 * The inherited panels and their siblings say what happened, in the reader's
 * language (#5309).
 *
 *   - A failed or refused load of the inherited evidence / mappings / tests is
 *     an error notice, never the "nothing inherited" empty state a reviewer
 *     reads as a coverage gap.
 *   - The Policy page's mappings copy names a policy in Bulgarian, not the
 *     English word `policy`.
 *   - The control's test plans show status, method and result by their labels.
 *   - Linked vendors show the relation by its label.
 *
 * Rendered against the Bulgarian catalogue, so an English word or a raw enum
 * value reaching the screen is visible.
 */
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

// The Bulgarian catalogue, memoised per namespace so an effect keyed on `t`
// does not refire every render. `mock`-prefixed so the hoisted factory may
// read it.
const mockBg: Record<string, unknown> = require('../../messages/bg.json');
jest.mock('next-intl', () => {
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        const lookup = (key: string) => walk(mockBg, ns ? `${ns}.${key}` : key);
        const t = (key: string, values?: Record<string, unknown>) => {
            const v = lookup(key);
            if (typeof v !== 'string') return key;
            return v.replace(/\{(\w+)\}/g, (m, name) => (values && name in values ? String(values[name]) : m));
        };
        t.rich = t;
        t.has = (key: string) => typeof lookup(key) === 'string';
        return t;
    };
    return {
        useTranslations: (ns = '') => {
            if (!cache.has(ns)) cache.set(ns, make(ns));
            return cache.get(ns);
        },
        useLocale: () => 'bg',
    };
});

jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign((m: string) => m, {
        custom: jest.fn(), dismiss: jest.fn(), success: jest.fn(),
        error: jest.fn(), warning: jest.fn(), info: jest.fn(),
        message: jest.fn(), loading: jest.fn(),
    }),
}));

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/controls/c1',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('@/lib/tenant-context-provider', () => {
    const ctx = { tenantSlug: 'acme', permissions: { canWrite: false } };
    const apiUrl = (path: string) => `/api/t/acme${path}`;
    const href = (path: string) => `/t/acme${path}`;
    return {
        useTenantContext: () => ctx,
        useTenantApiUrl: () => apiUrl,
        useTenantHref: () => href,
    };
});

import { InheritedEvidencePanel } from '@/components/InheritedEvidencePanel';
import { InheritedMappingsPanel } from '@/components/InheritedMappingsPanel';
import { InheritedTestPlansPanel } from '@/components/InheritedTestPlansPanel';
import TestPlansPanel from '@/components/TestPlansPanel';
import { LinkedVendorsPanel } from '@/components/LinkedVendorsPanel';

/** A Bulgarian message by its full key. */
function bg(path: string): string {
    const v = path.split('.').reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        mockBg,
    );
    if (typeof v !== 'string') throw new Error(`no bg message ${path}`);
    return v;
}

function inBulgarian(ui: React.ReactNode) {
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            {ui}
        </SWRConfig>,
    );
}

function answer(status: number, body: unknown) {
    global.fetch = jest.fn(async () => ({
        ok: status < 300,
        status,
        json: async () => body,
    })) as unknown as typeof fetch;
}

const tenantHref = (p: string) => `/t/acme${p}`;

describe('inherited panels — a failed load is not an empty record', () => {
    it.each([
        ['evidence', InheritedEvidencePanel, 'evidenceLoadError', 'evidenceEmpty'],
        ['mappings', InheritedMappingsPanel, 'mappingsLoadError', 'mappingsEmpty'],
        ['tests', InheritedTestPlansPanel, 'testsLoadError', 'testsEmpty'],
    ] as const)('%s: a 500 shows the load error', async (_name, Panel, errorKey, emptyKey) => {
        answer(500, { error: { code: 'INTERNAL', message: 'boom' } });
        inBulgarian(<Panel endpoint="/api/t/acme/risks/r1/x" tenantHref={tenantHref} entityLabel="risk" />);
        expect(await screen.findByText(bg(`panels.inherited.${errorKey}`))).toBeTruthy();
        expect(screen.queryByText(bg(`panels.inherited.${emptyKey}`))).toBeNull();
    });

    it('a 200 with no rows still shows the empty state', async () => {
        answer(200, []);
        inBulgarian(<InheritedEvidencePanel endpoint="/api/t/acme/risks/r1/evidence" tenantHref={tenantHref} entityLabel="risk" />);
        expect(await screen.findByText(bg('panels.inherited.evidenceEmpty'))).toBeTruthy();
        expect(screen.queryByText(bg('panels.inherited.evidenceLoadError'))).toBeNull();
    });
});

describe('labels in Bulgarian', () => {
    it('the policy mappings copy names the policy in Bulgarian', async () => {
        answer(200, []);
        inBulgarian(<InheritedMappingsPanel endpoint="/api/t/acme/policies/p1/mappings" tenantHref={tenantHref} entityLabel="policy" />);
        await waitFor(() => expect(document.body.textContent).toContain('свързани с тази политика'));
        expect(document.body.textContent).not.toMatch(/\bpolicy\b/);
    });

    it('test plans show status, method and result by their labels', async () => {
        answer(200, [
            {
                id: 'tp1',
                name: 'Quarterly review',
                method: 'MANUAL',
                frequency: 'QUARTERLY',
                status: 'ACTIVE',
                nextDueAt: null,
                owner: null,
                runs: [{ id: 'run1', result: 'PASS', executedAt: '2026-10-01T00:00:00.000Z', status: 'COMPLETED' }],
                _count: { runs: 1 },
            },
        ]);
        inBulgarian(<TestPlansPanel controlId="c1" />);
        await screen.findByText('Quarterly review');
        expect(screen.getByText(bg('controlTests.filterEnums.status.ACTIVE'))).toBeTruthy();
        expect(screen.getByText(bg('panels.testPlans.manual'))).toBeTruthy();
        expect(screen.getByText(bg('controlTests.filterEnums.result.PASS'))).toBeTruthy();
        expect(screen.queryByText('ACTIVE')).toBeNull();
        expect(screen.queryByText('MANUAL')).toBeNull();
        expect(screen.queryByText('PASS')).toBeNull();
    });

    it('linked vendors show the relation by its label', async () => {
        answer(200, [{ vendorId: 'v1', vendorName: 'Acme Cloud', relation: 'STORES_DATA_FOR' }]);
        inBulgarian(<LinkedVendorsPanel entityType="RISK" entityId="r1" />);
        expect(await screen.findByText(bg('vendors.linkRelation.STORES_DATA_FOR'))).toBeTruthy();
        expect(screen.queryByText('Stores Data For')).toBeNull();
    });
});
