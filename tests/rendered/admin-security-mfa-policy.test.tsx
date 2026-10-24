/**
 * The tenant Security & MFA page shows a refusal's sentence, not
 * "[object Object]", and describes the Disabled policy as it behaves.
 *
 * Every refusal from these routes comes through `withApiErrorHandling`, whose
 * body is `{ error: { code, message, requestId } }`
 * (src/lib/errors/types.ts::toApiErrorResponse). The page used to do
 * `new Error(data.error || fallback)`, and `new Error(object)` stringifies it.
 * The REQUIRED refusal is the one an admin meets first: `updateTenantMfaPolicy`
 * refuses it with a 400 until an active owner or admin has enrolled.
 *
 * Disabled used to read "Users cannot enroll". Under DISABLED the sign-in jwt
 * callback sets `mfaPending = false` for everyone (src/auth.ts), and nothing on
 * the enrolment path reads the policy (`startMfaEnrollment`, the personal MFA
 * page), so users can still enrol and are simply never asked for a code.
 */
import * as React from 'react';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn(), back: jest.fn() }),
    usePathname: () => '/t/acme/admin/security',
    useSearchParams: () => new URLSearchParams(),
}));

import AdminSecurityPage from '@/app/t/[tenantSlug]/(app)/admin/security/page';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getPermissionsForRole } from '@/lib/permissions';

const REQUIRED_REFUSAL =
    'Cannot enable REQUIRED MFA: at least one active owner or admin must be enrolled in MFA first. ' +
    'Please set up MFA for your account before enabling this policy.';

/** The canonical error envelope `toApiErrorResponse` writes. */
const refusal = (status: number, code: string, message: string) =>
    ({
        ok: false,
        status,
        json: async () => ({ error: { code, message, requestId: 'req-1' } }),
    }) as unknown as Response;

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

function mount(overrides: Record<string, (init?: RequestInit) => Response> = {}) {
    global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method ?? 'GET';
        const key = `${method} ${u.replace(/^.*\/api\/t\/acme/, '')}`;
        if (overrides[key]) return overrides[key](init);
        if (key === 'GET /security/mfa/policy') return ok({ mfaPolicy: 'OPTIONAL', sessionMaxAgeMinutes: null });
        // The two embedded cards read admin settings this test does not cover;
        // a refusal puts them in their own "unavailable" state.
        return refusal(403, 'FORBIDDEN', 'Forbidden');
    }) as unknown as typeof fetch;
    render(
        <TooltipProvider>
            <TenantProvider
                value={{
                    userId: 'admin-1',
                    tenantId: 'tenant-1',
                    tenantSlug: 'acme',
                    tenantName: 'Acme',
                    role: 'OWNER',
                    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
                    appPermissions: getPermissionsForRole('OWNER'),
                    modules: { processCanvas: false },
                }}
            >
                <AdminSecurityPage />
            </TenantProvider>
        </TooltipProvider>,
    );
}

async function loaded() {
    return waitFor(() => {
        const save = document.getElementById('security-save-btn');
        if (!save) throw new Error('settings not loaded yet');
        return save;
    });
}

describe('admin Security & MFA page', () => {
    afterEach(() => jest.restoreAllMocks());

    it('shows the server sentence when switching to Required is refused', async () => {
        mount({ 'PUT /security/mfa/policy': () => refusal(400, 'BAD_REQUEST', REQUIRED_REFUSAL) });
        const save = await loaded();

        fireEvent.click(screen.getByRole('radio', { name: /Required/ }));
        fireEvent.click(save);

        expect(await screen.findByText(REQUIRED_REFUSAL)).toBeInTheDocument();
        expect(screen.queryByText('[object Object]')).not.toBeInTheDocument();
        const put = (global.fetch as jest.Mock).mock.calls.find(([, init]) => init?.method === 'PUT');
        expect(JSON.parse(put?.[1]?.body as string)).toEqual({ mfaPolicy: 'REQUIRED', sessionMaxAgeMinutes: null });
    });

    it('shows the server sentence when revoking every session is refused', async () => {
        jest.spyOn(window, 'confirm').mockReturnValue(true);
        mount({ 'POST /security/sessions/revoke-all': () => refusal(403, 'FORBIDDEN', 'You do not have permission to revoke sessions.') });
        await loaded();

        fireEvent.click(document.getElementById('revoke-all-sessions-btn') as HTMLElement);

        expect(await screen.findByText('You do not have permission to revoke sessions.')).toBeInTheDocument();
        expect(screen.queryByText('[object Object]')).not.toBeInTheDocument();
    });

    it("shows the server sentence when revoking one user's sessions is refused", async () => {
        jest.spyOn(window, 'confirm').mockReturnValue(true);
        mount({ 'POST /security/sessions/revoke-user': () => refusal(400, 'BAD_REQUEST', 'targetUserId is required') });
        await loaded();

        fireEvent.change(document.getElementById('revoke-user-id-input') as HTMLElement, { target: { value: 'user-9' } });
        fireEvent.click(document.getElementById('revoke-user-btn') as HTMLElement);

        expect(await screen.findByText('targetUserId is required')).toBeInTheDocument();
        expect(screen.queryByText('[object Object]')).not.toBeInTheDocument();
    });

    it('describes Disabled as no sign-in check, with enrolment still open', async () => {
        mount();
        await loaded();

        const disabled = screen.getByRole('radio', { name: /Disabled/ }).closest('label') as HTMLElement;
        expect(disabled).toHaveTextContent(
            'MFA is not checked at sign-in, even for users who have enrolled. ' +
                'Users can still set up an authenticator app, and existing enrollments are kept.',
        );
        expect(disabled).not.toHaveTextContent(/cannot enroll/i);
    });
});
