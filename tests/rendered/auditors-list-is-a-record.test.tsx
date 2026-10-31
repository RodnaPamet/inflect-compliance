/** @jest-environment jsdom */

/**
 * The auditor list is a record, and the page says what it does (#4730).
 *
 *   - An auditor is "Listed" or "Revoked". INVITED and ACTIVE both read
 *     "Listed": ACTIVE was set by adding the same email twice.
 *   - Adding a listed auditor again changes nothing, and says so.
 *   - A draft pack is not offered, because it cannot be shared.
 *   - A refusal the server names is shown as what it is, never as "please
 *     try again".
 */

import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const sonner = {
    success: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
    info: jest.fn(),
    message: jest.fn(),
    loading: jest.fn(),
};
jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign((msg: string) => msg, {
        custom: () => 1,
        dismiss: (id: string | number) => id,
        ...sonner,
    }),
}));

jest.mock('@/components/ui/tooltip', () => ({
    __esModule: true,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    InfoTooltip: () => null,
    DynamicTooltipWrapper: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// A stable translator per namespace, as next-intl gives, so effects settle.
jest.mock('next-intl', () => {
    const shared = jest.requireActual('../../__mocks__/next-intl.js');
    const translators = new Map<string, unknown>();
    return {
        ...shared,
        useTranslations: (ns: string) => {
            if (!translators.has(ns)) translators.set(ns, shared.useTranslations(ns));
            return translators.get(ns);
        },
    };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/audits/auditors',
    useSearchParams: () => new URLSearchParams(),
    useSelectedLayoutSegment: () => null,
    useSelectedLayoutSegments: () => [],
    notFound: jest.fn(),
    redirect: jest.fn(),
}));

import { SWRConfig } from 'swr';
import AuditorsPage from '@/app/t/[tenantSlug]/(app)/audits/auditors/page';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';

const EN = jest.requireActual('../../messages/en.json') as {
    audits: { auditorsAdmin: Record<string, string> & { refused: Record<string, string> } };
};
const A = EN.audits.auditorsAdmin;

const TENANT_CTX = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    tenantName: 'Acme',
    role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
    modules: { processCanvas: false },
};

const auditor = (id: string, status: string, packAccess: { auditPackId: string }[] = []) => ({
    id,
    email: `${id}@auditfirm.example`,
    name: null,
    status,
    createdAt: '2026-07-01T00:00:00.000Z',
    packAccess,
});

const reply = (status: number, body: unknown) =>
    Promise.resolve({ ok: status < 400, status, json: async () => body } as Response);
const refusal = (status: number, reason: string, message = 'English sentence') =>
    reply(status, { error: { code: 'BAD_REQUEST', message, details: { reason } } });

type Handler = (url: string, init?: RequestInit) => Promise<Response> | undefined;
let handler: Handler;
let auditors: ReturnType<typeof auditor>[];
let packs: { id: string; name: string; status: string }[];

beforeEach(() => {
    Object.values(sonner).forEach((f) => f.mockReset());
    auditors = [auditor('aud-1', 'ACTIVE'), auditor('aud-2', 'INVITED')];
    packs = [{ id: 'pack-1', name: 'FY26 ISO pack', status: 'FROZEN' }];
    handler = () => undefined;
    global.fetch = jest.fn((url: string, init?: RequestInit) => {
        const custom = handler(String(url), init);
        if (custom) return custom;
        if (String(url).includes('/audits/packs')) return reply(200, packs);
        return reply(200, auditors);
    }) as unknown as typeof fetch;
});

async function renderPage() {
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TenantProvider value={TENANT_CTX}>
                <AuditorsPage />
            </TenantProvider>
        </SWRConfig>,
    );
    await waitFor(() => expect(document.getElementById('auditor-aud-1')).not.toBeNull());
}

const byId = (id: string) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`#${id} not in the document`);
    return el;
};

describe('auditor list status', () => {
    it('shows every auditor not revoked as Listed, never Active or Invited', async () => {
        await renderPage();
        expect(byId('auditor-aud-1')).toHaveTextContent(A.statusLISTED);
        expect(byId('auditor-aud-2')).toHaveTextContent(A.statusLISTED);
        expect(screen.queryByText('Active')).toBeNull();
        expect(screen.queryByText('Invited')).toBeNull();
    });
});

describe('adding an auditor', () => {
    async function add(email: string) {
        await renderPage();
        await act(async () => { fireEvent.click(byId('invite-auditor-btn')); });
        fireEvent.change(byId('invite-auditor-email'), { target: { value: email } });
        await act(async () => { fireEvent.submit(byId('invite-auditor-form')); });
    }

    it('says an auditor already on the list was not changed', async () => {
        handler = (url, init) =>
            init?.method === 'POST' && url.endsWith('/audits/auditors')
                ? reply(201, { ...auditors[0], reactivated: false, alreadyListed: true })
                : undefined;
        await add('aud-1@auditfirm.example');

        await waitFor(() => expect(sonner.info).toHaveBeenCalledWith(A.alreadyListed, expect.anything()));
        expect(sonner.success).not.toHaveBeenCalled();
    });

    it('says an email the server refused is not valid, rather than to try again', async () => {
        handler = (url, init) =>
            init?.method === 'POST' && url.endsWith('/audits/auditors')
                ? reply(400, { error: { code: 'VALIDATION_ERROR', message: 'Invalid request payload', details: [{ path: ['email'], code: 'invalid_string', message: 'Valid email required' }] } })
                : undefined;
        await add('not-an-email');

        await waitFor(() => expect(sonner.error).toHaveBeenCalledWith(A.emailInvalid, expect.anything()));
    });
});

describe('recording packs', () => {
    it('does not offer a draft pack, and says to freeze one when none is frozen', async () => {
        packs = [{ id: 'pack-d', name: 'Draft pack', status: 'DRAFT' }];
        await renderPage();
        expect(byId('auditor-aud-1')).toHaveTextContent(A.freezeToRecord);
        expect(screen.queryByText('Draft pack')).toBeNull();
    });

    it('offers a frozen pack', async () => {
        await renderPage();
        expect(byId('auditor-aud-1')).toHaveTextContent(A.grantPlaceholder);
    });
});

describe('server refusals', () => {
    it('shows the named refusal when revoking an auditor someone else already revoked', async () => {
        handler = (url, init) =>
            init?.method === 'DELETE' && /\/audits\/auditors\/aud-1$/.test(url)
                ? refusal(400, 'AUDITOR_ALREADY_REVOKED')
                : undefined;
        await renderPage();
        await act(async () => { fireEvent.click(byId('revoke-account-aud-1')); });
        fireEvent.change(byId('revoke-account-confirm-input'), { target: { value: 'aud-1@auditfirm.example' } });
        await act(async () => { fireEvent.click(byId('revoke-account-confirm-submit')); });

        await waitFor(() =>
            expect(sonner.error).toHaveBeenCalledWith(A.refused.AUDITOR_ALREADY_REVOKED, expect.anything()),
        );
        expect(sonner.error).not.toHaveBeenCalledWith(A.revokeAccountError, expect.anything());
    });

    it('keeps the fallback for a server failure', async () => {
        handler = (url, init) =>
            init?.method === 'DELETE' && /\/audits\/auditors\/aud-1$/.test(url)
                ? reply(500, { error: { code: 'INTERNAL', message: 'boom' } })
                : undefined;
        await renderPage();
        await act(async () => { fireEvent.click(byId('revoke-account-aud-1')); });
        fireEvent.change(byId('revoke-account-confirm-input'), { target: { value: 'aud-1@auditfirm.example' } });
        await act(async () => { fireEvent.click(byId('revoke-account-confirm-submit')); });

        await waitFor(() => expect(sonner.error).toHaveBeenCalledWith(A.revokeAccountError, expect.anything()));
    });
});
