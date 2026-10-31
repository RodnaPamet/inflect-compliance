/**
 * #4820 — the Privacy page names the declared region in words, speaks of the
 * workspace (not "the tenant"), points to where each item is set, and says
 * plainly that no page sets up audit streaming.
 */
import { render, screen, cleanup } from '@testing-library/react';

const EN = jest.requireActual('../../messages/en.json') as { admin: { privacy: Record<string, unknown> } };
const privacy = EN.admin.privacy as Record<string, Record<string, unknown>> & { subtitle: string };

jest.mock('next-intl/server', () => {
    const en = jest.requireActual('../../messages/en.json') as Record<string, unknown>;
    const lookup = (o: unknown, path: string): unknown =>
        path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o);
    return {
        __esModule: true,
        getTranslations: async (ns: string) => {
            const bag = lookup(en, ns);
            const t = (key: string, values?: Record<string, unknown>) => {
                const v = lookup(bag, key);
                if (typeof v !== 'string') return key;
                return v.replace(/\{(\w+)[^}]*\}/g, (_m, k: string) => String(values?.[k] ?? ''));
            };
            t.has = (key: string) => typeof lookup(bag, key) === 'string';
            return t;
        },
    };
});

jest.mock('@/app/t/[tenantSlug]/(app)/admin/_lib/admin-page-gate', () => ({
    gateAdminPage: async () => ({ allowed: true, ctx: { tenantId: 't1' }, tenantSlug: 'acme' }),
}));

let region = 'EU_WEST_1';
jest.mock('@/app-layer/usecases/privacy-posture', () => ({
    getPrivacyPosture: async () => ({
        encryption: { perTenantDek: true, rotationInFlight: false },
        residency: { region, provisioned: false },
        retention: { softDeleteGraceDays: 90, evidencePurgeDays: 365, tenantConfigurable: false, evidenceWithRetentionRule: 3 },
        subProcessors: { flaggedVendorCount: 2, relationshipCount: 4 },
        auditStream: { configured: false },
        dsar: { intakeEnabled: true, automatedFulfilment: false },
    }),
}));
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));
jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

import PrivacyPage from '@/app/t/[tenantSlug]/(app)/admin/privacy/page';

afterEach(() => {
    cleanup();
    region = 'EU_WEST_1';
});

async function renderPage() {
    const el = await PrivacyPage({ params: Promise.resolve({ tenantSlug: 'acme' }) });
    return render(el);
}

it('names the declared region in words', async () => {
    await renderPage();
    expect(document.getElementById('privacy-region')).toHaveTextContent('European Union (Ireland)');
    expect(document.body.textContent).not.toContain('EU_WEST_1');
});

it('shows an unknown region as stored rather than nothing', async () => {
    region = 'SA_EAST_1';
    await renderPage();
    expect(document.getElementById('privacy-region')).toHaveTextContent('SA_EAST_1');
});

it('links to where sub-processors and retention dates are set', async () => {
    await renderPage();
    expect(document.getElementById('privacy-vendors-link')).toHaveAttribute('href', '/t/acme/vendors');
    expect(document.getElementById('privacy-evidence-link')).toHaveAttribute('href', '/t/acme/evidence');
});

it('speaks of the workspace, and says no page sets up audit streaming', async () => {
    await renderPage();
    expect(document.body.textContent).not.toMatch(/\btenant\b/i);
    expect(document.body.textContent).not.toMatch(/key-rotation API/);
    expect(screen.getByText(privacy.auditStream.note as string)).toBeInTheDocument();
});
