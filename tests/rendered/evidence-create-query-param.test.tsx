/**
 * `/evidence?create=1` opens the Evidence list's create menu (#4458).
 *
 * The dashboard's "Add Evidence" quick-add used to open the plain list, so a
 * link labelled "Add" added nothing. It now lands on `?create=1`, which the
 * Risks and Policies lists already honoured and the Evidence list did not.
 * The menu belongs to the create trigger, which renders only for a viewer
 * who may create evidence, so for a Reader the param opens nothing.
 *
 * Mounts the REAL `EvidenceClient` (fetch faked by path; see
 * `./evidence-client-harness`).
 */
import * as React from 'react';
import { configure, screen, waitFor } from '@testing-library/react';

jest.setTimeout(180_000);
configure({ asyncUtilTimeout: 20_000 });

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({
        tenantSlug: 'acme',
        tenantName: 'Acme',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: true },
    }),
    usePermissions: () => ({}),
    useCurrentUserId: () => 'user-me',
    useMoneyFormatter: () => (v: number | null | undefined) => (v == null ? '' : String(v)),
    useModules: () => ({}),
}));

const mockSearchParams = new URLSearchParams();
const mockReplace = jest.fn();
jest.mock('next/navigation', () => {
    const router = {
        push: jest.fn(),
        replace: (...a: unknown[]) => mockReplace(...a),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    };
    return {
        useRouter: () => router,
        usePathname: () => '/t/acme/evidence',
        useSearchParams: () => mockSearchParams,
        useParams: () => ({ tenantSlug: 'acme' }),
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));
jest.mock('@/components/LinkedTasksPanel', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/user-combobox', () => ({ UserCombobox: () => null }));

import { installEvidenceFetch, makeServer, mountEvidenceClient } from './evidence-client-harness';

beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme/evidence');
    for (const k of Array.from(mockSearchParams.keys())) mockSearchParams.delete(k);
    mockReplace.mockClear();
});

describe('Evidence list — ?create=1', () => {
    it('opens the create menu for an Editor, then drops the param', async () => {
        mockSearchParams.set('create', '1');
        const server = makeServer();
        installEvidenceFetch(server);
        mountEvidenceClient(server, { role: 'EDITOR' });

        await waitFor(() =>
            expect(document.getElementById('create-evidence-upload')).not.toBeNull(),
        );
        expect(document.getElementById('create-evidence-text')).not.toBeNull();
        expect(mockReplace).toHaveBeenCalledWith('/t/acme/evidence', { scroll: false });
    });

    it('opens nothing for a Reader, who has no create menu', async () => {
        mockSearchParams.set('create', '1');
        const server = makeServer();
        installEvidenceFetch(server);
        mountEvidenceClient(server, { role: 'READER' });

        await screen.findAllByText('Access review export');
        expect(document.getElementById('add-evidence-btn')).toBeNull();
        expect(document.getElementById('create-evidence-upload')).toBeNull();
    });

    it('stays closed without the param', async () => {
        const server = makeServer();
        installEvidenceFetch(server);
        mountEvidenceClient(server, { role: 'EDITOR' });

        await screen.findAllByText('Access review export');
        expect(document.getElementById('add-evidence-btn')).not.toBeNull();
        expect(document.getElementById('create-evidence-upload')).toBeNull();
    });
});
