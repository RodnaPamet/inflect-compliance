/**
 * The personal MFA page says what went wrong when the server refuses.
 *
 * Two failure paths read the API's error body wrongly:
 *   - starting enrolment threw `new Error(data.error)`, and `error` is the
 *     envelope's OBJECT (`{ code, message }`), so the page showed
 *     "[object Object]";
 *   - removing MFA handled only `res.ok`, so a refused removal showed nothing
 *     at all and left the person wondering whether the factor was gone.
 * Both now show the server's own sentence (`apiErrorMessage`).
 */
import * as React from 'react';
import { render, fireEvent, screen, waitFor, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn(), back: jest.fn() }),
    usePathname: () => '/t/acme/security/mfa',
    useSearchParams: () => new URLSearchParams(),
}));

import UserMfaPage from '@/app/t/[tenantSlug]/(app)/security/mfa/page';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getPermissionsForRole } from '@/lib/permissions';

type Reply = { status: number; body: unknown };

function mount({ verified, start, remove }: { verified: boolean; start?: Reply; remove?: Reply }) {
    const respond = ({ status, body }: Reply) =>
        ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
    global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/security/mfa/enroll/start') && init?.method === 'POST' && start) return respond(start);
        if (u.endsWith('/security/mfa/enroll') && init?.method === 'DELETE' && remove) return respond(remove);
        if (u.endsWith('/security/mfa/enroll')) {
            return respond({
                status: 200,
                body: {
                    isEnrolled: verified,
                    isVerified: verified,
                    enrolledAt: null,
                    verifiedAt: null,
                    tenantMfaPolicy: 'OPTIONAL',
                    mfaRequired: false,
                },
            });
        }
        throw new Error(`unexpected fetch ${u}`);
    }) as unknown as typeof fetch;
    render(
        <TooltipProvider>
            <TenantProvider
                value={{
                    userId: 'alice',
                    tenantId: 'tenant-1',
                    tenantSlug: 'acme',
                    tenantName: 'Acme',
                    role: 'EDITOR',
                    permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: false },
                    appPermissions: getPermissionsForRole('EDITOR'),
                    modules: { processCanvas: false },
                }}
            >
                <UserMfaPage />
            </TenantProvider>
        </TooltipProvider>,
    );
}

const byId = (id: string) =>
    waitFor(() => {
        const el = document.getElementById(id);
        if (!el) throw new Error(`#${id} not rendered yet`);
        return el;
    });

describe('personal MFA page — refusals', () => {
    it("shows the server's reason when enrolment cannot start, not [object Object]", async () => {
        mount({
            verified: false,
            start: { status: 409, body: { error: { code: 'CONFLICT', message: 'An enrolment is already in progress.' } } },
        });
        fireEvent.click(await byId('mfa-enroll-btn'));

        expect(await screen.findByText('An enrolment is already in progress.')).toBeInTheDocument();
        expect(screen.queryByText('[object Object]')).toBeNull();
    });

    it('says so when the server refuses to remove MFA, instead of nothing', async () => {
        mount({
            verified: true,
            remove: {
                status: 403,
                body: { error: { code: 'FORBIDDEN', message: 'Your workspace requires multi-factor authentication.' } },
            },
        });
        fireEvent.click(await byId('mfa-remove-btn'));
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Remove MFA' }));

        expect(await screen.findByText('Your workspace requires multi-factor authentication.')).toBeInTheDocument();
        expect(screen.queryByText('MFA removed.')).toBeNull();
    });
});
