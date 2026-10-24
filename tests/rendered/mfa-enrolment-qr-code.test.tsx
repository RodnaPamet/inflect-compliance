/**
 * Starting MFA enrolment shows a QR code an authenticator app can scan.
 *
 * The enrol-start response carries the otpauth:// URI; the page used to show a
 * lucide `QrCode` icon in its place, so there was nothing to scan and the
 * setup key was the only way in. The assertion is that the image IS the QR
 * code of the URI the server returned — rebuilt here from the same URI with
 * the same options and compared byte for byte — not merely that some image
 * exists.
 */
import * as React from 'react';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { toDataURL } from 'qrcode';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn(), back: jest.fn() }),
    usePathname: () => '/t/acme/security/mfa',
    useSearchParams: () => new URLSearchParams(),
}));

import UserMfaPage from '@/app/t/[tenantSlug]/(app)/security/mfa/page';
import { TOTP_QR_OPTIONS } from '@/app/t/[tenantSlug]/(app)/security/mfa/TotpQrCode';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getPermissionsForRole } from '@/lib/permissions';

const OTPAUTH_URL =
    'otpauth://totp/Inflect:alice%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Inflect&algorithm=SHA1&digits=6&period=30';
const SETUP_KEY = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

function mount() {
    const fetchMock = jest.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/security/mfa/enroll/start') && init?.method === 'POST') {
            return {
                ok: true,
                status: 201,
                json: async () => ({ otpauthUrl: OTPAUTH_URL, secret: SETUP_KEY, enrollmentId: 'enr-1' }),
            } as unknown as Response;
        }
        if (u.endsWith('/security/mfa/enroll')) {
            return {
                ok: true,
                json: async () => ({
                    isEnrolled: false,
                    isVerified: false,
                    enrolledAt: null,
                    verifiedAt: null,
                    tenantMfaPolicy: 'OPTIONAL',
                    mfaRequired: false,
                }),
            } as unknown as Response;
        }
        throw new Error(`unexpected fetch ${u}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
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
    return fetchMock;
}

describe('personal MFA page — enrolment QR code', () => {
    it('shows the otpauth URI the server returned as a scannable QR image', async () => {
        const fetchMock = mount();

        const start = await waitFor(() => {
            const el = document.getElementById('mfa-enroll-btn');
            if (!el) throw new Error('enrol button not rendered yet');
            return el;
        });
        fireEvent.click(start);

        // Drawing the PNG is CPU-bound, so on a loaded in-band CI shard it can
        // outlast findBy's default 1 s while the page still shows the pending
        // placeholder. The assertion is about which image is drawn, not how fast.
        const img = await screen.findByRole(
            'img',
            { name: 'QR code for adding this account to your authenticator app' },
            { timeout: 10_000 },
        );
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringMatching(/\/security\/mfa\/enroll\/start$/),
            expect.objectContaining({ method: 'POST' }),
        );

        const src = img.getAttribute('src') ?? '';
        expect(src.startsWith('data:image/png;base64,')).toBe(true);
        // The image encodes exactly this URI…
        expect(src).toBe(await toDataURL(OTPAUTH_URL, TOTP_QR_OPTIONS));
        // …and not some other one: a different secret gives a different picture.
        expect(src).not.toBe(await toDataURL(OTPAUTH_URL.replace(SETUP_KEY, 'A'.repeat(32)), TOTP_QR_OPTIONS));

        // The setup key stays as the fallback for a camera-less device.
        expect(screen.getByText(SETUP_KEY)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    });
});
