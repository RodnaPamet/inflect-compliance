/**
 * Values the help-guide reviews found printed as stored codes or as untranslated
 * English (#4275, #4276, #4277, #4278):
 *
 *   - the Assets preview showed "DATA STORE", "RETIRED" and "3 · HIGH";
 *   - a link the new-task form staged showed its enum and the record's cuid;
 *   - the truncation banner on every list page was hard-coded English.
 *
 * Each is rendered with the real `messages/en.json` and asserted on what the
 * user reads.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

jest.setTimeout(60_000);

// The truncation banner is checked in Bulgarian: its English text equals
// `en.json`, so only another locale shows whether it is translated at all.
let mockLocale: 'en' | 'bg' = 'en';
jest.mock('next-intl', () => {
    const messages = {
        en: require('../../messages/en.json'),
        bg: require('../../messages/bg.json'),
    };
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const make = (ns?: string) => {
        const root = () => (ns ? walk(messages[mockLocale], ns) : messages[mockLocale]);
        const t = (key: string, params?: Record<string, unknown>) => {
            const v = walk(root(), key);
            if (typeof v !== 'string') return key;
            let s = v;
            for (const [p, val] of Object.entries(params ?? {})) s = s.replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            return s;
        };
        t.rich = (key: string) => walk(root(), key) ?? key;
        t.has = (key: string) => typeof walk(root(), key) === 'string';
        return t;
    };
    return { useTranslations: (ns?: string) => make(ns), useLocale: () => mockLocale };
});

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantSlug: 'acme', tenantName: 'Acme', permissions: {} }),
    usePermissions: () => ({}),
    useCurrentUserId: () => 'user-me',
}));

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { AssetDetailPanel } from '@/app/t/[tenantSlug]/(app)/assets/AssetDetailPanel';
import { NewTaskModal } from '@/app/t/[tenantSlug]/(app)/tasks/NewTaskModal';
import { TruncationBanner } from '@/components/ui/TruncationBanner';

const en = require('../../messages/en.json');
const bg = require('../../messages/bg.json');

beforeEach(() => {
    mockLocale = 'en';
    global.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => [],
        text: async () => '[]',
    })) as unknown as typeof fetch;
});

describe('labels, not stored codes', () => {
    it('the Assets preview names the type, status and worst severity', () => {
        render(
            <AssetDetailPanel
                asset={{
                    id: 'a-1',
                    key: 'AST-1',
                    name: 'Payroll database',
                    type: 'DATA_STORE',
                    status: 'RETIRED',
                    openVulnCount: 3,
                    maxVulnSeverity: 'HIGH',
                }}
                tenantHref={(p) => `/t/acme${p}`}
            />,
        );

        expect(screen.getAllByText(en.assets.filterEnums.type.DATA_STORE).length).toBeGreaterThan(0);
        expect(screen.getByText(en.assets.filterEnums.status.RETIRED)).toBeTruthy();
        expect(screen.getByText(`3 · ${en.vulnerabilities.filterEnums.severity.HIGH}`)).toBeTruthy();
        expect(screen.queryByText(/DATA STORE/)).toBeNull();
        expect(screen.queryByText('RETIRED')).toBeNull();
        expect(screen.queryByText('3 · HIGH')).toBeNull();
    });

    it("a link the page stages for itself reads as its type, not its enum and cuid", async () => {
        render(
            <TooltipProvider>
                <NewTaskModal
                    open
                    setOpen={() => undefined}
                    initialPendingLinks={[{ entityType: 'CONTROL', entityId: 'cmctl000000000000000001' }]}
                />
            </TooltipProvider>,
        );

        const list = await screen.findByText(en.tasks.new.linkPresetName);
        const row = list.parentElement as HTMLElement;
        expect(row.textContent).toContain(en.tasks.linkEntity.CONTROL);
        expect(row.textContent).not.toContain('cmctl000000000000000001');
        expect(row.textContent).not.toContain('CONTROL');
    });

    it('the truncation banner is translated', () => {
        mockLocale = 'bg';
        render(<TruncationBanner truncated cap={5000} />);

        expect(
            screen.getByText(bg.common.ui.truncationTitle.replace('{count}', (5000).toLocaleString())),
        ).toBeTruthy();
        expect(screen.getByText(bg.common.ui.truncationHint)).toBeTruthy();
        expect(screen.queryByText(/Showing the first/)).toBeNull();
    });
});
