/**
 * Three list pages offered actions to roles the server then refused, found
 * while writing their help guides:
 *
 *   - Assets (#4276) and Evidence (#4277) offered bulk Delete to Editors. The
 *     routes require `admin.manage` and the usecases `assertCanAdmin`, so an
 *     Editor saw the rows go and come back, or a generic failure toast.
 *   - Controls (#4275) gave Readers, Auditors and AI admins row checkboxes
 *     and an empty selection bar, because the page withheld the bar but left
 *     the table's default-on select column in place.
 *
 * Each page is mounted with the permissions the server page would pass, and
 * asserted on what the user can reach.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.setTimeout(180_000);

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantSlug: 'acme', tenantName: 'Acme', permissions: {} }),
    usePermissions: () => ({}),
    useCurrentUserId: () => 'user-me',
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const make = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const v = walk(walk(en, ns), key);
            if (typeof v !== 'string') return key;
            let s = v;
            if (params) {
                for (const [p, val] of Object.entries(params)) {
                    s = s.replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
                }
            }
            return s;
        };
        t.rich = (key: string) => walk(walk(en, ns), key) ?? key;
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => {
    const searchParams = new URLSearchParams();
    const router = {
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    };
    return {
        useRouter: () => router,
        usePathname: () => '/t/acme',
        useSearchParams: () => searchParams,
        useParams: () => ({ tenantSlug: 'acme' }),
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { AssetsClient } from '@/app/t/[tenantSlug]/(app)/assets/AssetsClient';
import { EvidenceClient } from '@/app/t/[tenantSlug]/(app)/evidence/EvidenceClient';
import { ControlsClient } from '@/app/t/[tenantSlug]/(app)/controls/ControlsClient';
import { getPermissionsForRole } from '@/lib/permissions';
import { __setConfettiForTest } from '@inflect/ui/components/ui/hooks/use-celebration';

const en = require('../../messages/en.json');

type Role = 'ADMIN' | 'EDITOR' | 'READER';
const coarse = (role: Role) => ({
    canRead: true,
    canWrite: role !== 'READER',
    canAdmin: role === 'ADMIN',
    canAudit: false,
    canExport: true,
});

const ASSET = {
    id: 'asset-1',
    key: 'AST-1',
    name: 'Payroll database',
    type: 'DATA_STORE',
    status: 'ACTIVE',
    classification: null,
    owner: null,
    ownerUserId: null,
    ownerUser: null,
    location: null,
    criticality: null,
    _count: { controls: 0 },
    taskTotal: 0,
    taskDone: 0,
    openVulnCount: 0,
    maxVulnSeverity: null,
    deletedAt: null,
    deletedByUserId: null,
} as unknown as React.ComponentProps<typeof AssetsClient>['initialAssets'][number];

const EVIDENCE = {
    id: 'ev-1',
    title: 'Access review export',
    type: 'TEXT',
    status: 'DRAFT',
    fileName: null,
    owner: null,
    ownerUserId: null,
    ownerUser: null,
    folder: null,
    isArchived: false,
    expiredAt: null,
    deletedAt: null,
    retentionUntil: null,
    nextReviewDate: null,
    reviewCycle: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
    dateCollected: '2026-10-01T00:00:00.000Z',
    fileRecordId: null,
    content: 'note',
    category: null,
    controlLinks: [],
} as unknown as React.ComponentProps<typeof EvidenceClient>['initialEvidence'][number];

const EVIDENCE_METRICS = {
    total: 1,
    byStatus: { DRAFT: 1, SUBMITTED: 0, APPROVED: 0, REJECTED: 0, NEEDS_REVIEW: 0 },
    active: 1,
    archived: 0,
    expiringSoon: 0,
    expired: 0,
    needsReview: 0,
} as unknown as React.ComponentProps<typeof EvidenceClient>['initialMetrics'];

const CONTROL = {
    id: 'ctl-1',
    code: 'CTL-1',
    annexId: null,
    name: 'Quarterly access review',
    status: 'NOT_STARTED',
    applicability: 'APPLICABLE',
    category: null,
    frequency: null,
    owner: null,
    ownerUserId: null,
    _count: { evidenceLinks: 0, evidenceControlLinks: 0 },
    taskTotal: 0,
    taskDone: 0,
    frameworks: [],
} as unknown as React.ComponentProps<typeof ControlsClient>['initialControls'][number];

function installFetch() {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), 'https://test.local').pathname;
        let body: unknown = {};
        if (path.endsWith('/assets')) body = { rows: [ASSET], truncated: false };
        else if (path.endsWith('/evidence')) body = { rows: [EVIDENCE], truncated: false };
        else if (path.endsWith('/evidence/retention')) body = EVIDENCE_METRICS;
        else if (path.endsWith('/controls')) body = { rows: [CONTROL], truncated: false };
        return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => body,
            text: async () => JSON.stringify(body),
        } as unknown as Response;
    }) as unknown as typeof fetch;
}

const wrap = (node: React.ReactNode) =>
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider>{node}</TooltipProvider>
        </SWRConfig>,
    );

/** Tick the first row and read the bulk bar's action labels. */
async function bulkActionLabels(): Promise<string[]> {
    const boxes = await screen.findAllByRole('checkbox');
    await act(async () => {
        fireEvent.click(boxes[0]);
    });
    const select = await waitFor(() => {
        const el = document.getElementById('bulk-action-select');
        expect(el).not.toBeNull();
        return el as HTMLElement;
    });
    fireEvent.click(select);
    const listbox = await screen.findByRole('listbox');
    return within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent?.trim() ?? '');
}

const assetTranslations = new Proxy(
    {},
    { get: (_t, key) => String(key) },
) as React.ComponentProps<typeof AssetsClient>['translations'];

beforeEach(() => {
    // The Evidence page celebrates an all-current library with confetti,
    // which has no canvas under jsdom.
    __setConfettiForTest(() => Promise.resolve(null));
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme');
    installFetch();
});

describe('bulk Delete is offered only to the roles the server lets delete', () => {
    it.each([
        ['ADMIN', true],
        ['EDITOR', false],
    ] as const)('Assets — %s (delete offered: %s)', async (role, offered) => {
        wrap(
            <AssetsClient
                initialAssets={[ASSET]}
                initialFilters={{}}
                tenantSlug="acme"
                permissions={coarse(role)}
                appPermissions={getPermissionsForRole(role)}
                translations={assetTranslations}
            />,
        );
        await screen.findByText('Payroll database');
        const labels = await bulkActionLabels();
        // Positive control: the bar opened with the editing actions.
        expect(labels).toContain(en.assets.bulk.setStatus);
        if (offered) expect(labels).toContain(en.assets.bulk.delete);
        else expect(labels).not.toContain(en.assets.bulk.delete);
    });

    it.each([
        ['ADMIN', true],
        ['EDITOR', false],
    ] as const)('Evidence — %s (delete offered: %s)', async (role, offered) => {
        wrap(
            <EvidenceClient
                initialEvidence={[EVIDENCE]}
                initialControls={[]}
                controlsComplete
                canViewControls
                initialMetrics={EVIDENCE_METRICS}
                tenantSlug="acme"
                permissions={coarse(role)}
                grants={{
                    evidenceEdit: getPermissionsForRole(role).evidence.edit,
                    evidenceUpload: getPermissionsForRole(role).evidence.upload,
                    adminManage: getPermissionsForRole(role).admin.manage,
                }}
                translations={{}}
            />,
        );
        await screen.findByText('Access review export');
        const labels = await bulkActionLabels();
        expect(labels).toContain(en.evidence.list.bulkAssign);
        if (offered) expect(labels).toContain(en.evidence.list.bulkDelete);
        else expect(labels).not.toContain(en.evidence.list.bulkDelete);
    });
});

describe('Controls — read-only roles get no row checkboxes', () => {
    const mountControls = (role: Role) => {
        const perms = getPermissionsForRole(role);
        wrap(
            <ControlsClient
                initialControls={[CONTROL]}
                tenantSlug="acme"
                permissions={coarse(role)}
                appPermissions={{
                    controls: { create: perms.controls.create, edit: perms.controls.edit },
                    tasks: { edit: perms.tasks.edit },
                    evidence: { upload: true },
                    admin: { manage: perms.admin.manage },
                }}
            />,
        );
    };

    it('a Reader cannot tick rows', async () => {
        mountControls('READER');
        await screen.findAllByText('Quarterly access review');
        expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    });

    it('an Editor can (positive control for the case above)', async () => {
        mountControls('EDITOR');
        await screen.findAllByText('Quarterly access review');
        expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0);
    });
});
