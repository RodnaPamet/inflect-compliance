/**
 * Epic G-5 — ControlExceptionsPanel render + interaction tests.
 *
 *   1. Empty state when no exceptions exist.
 *   2. Renders one row per exception with the right testid + badge.
 *   3. Header badge surfaces APPROVED state.
 *   4. canWrite gates the "Request exception" button.
 *   5. canAdmin gates Approve / Reject buttons on REQUESTED rows.
 *   6. Renew button only shows on APPROVED / EXPIRED rows.
 *   7. Request form requires justification + risk-acceptor before
 *      enabling submit.
 *   8. Reject dialog requires reason before submit.
 */
import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/controls/c1',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { ControlExceptionsPanel } from '@/components/ControlExceptionsPanel';

function withClient(ui: React.ReactNode) {
    // Fresh per-test SWR cache (these panels read via useSWR); a shared
    // global cache would leak optimistic mutations + dedupe stale data
    // across tests. dedupingInterval 0 keeps mutate→revalidate deterministic.
    return (
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            {ui}
        </SWRConfig>
    );
}

function makeExceptionRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'cex_1',
        controlId: 'c1',
        status: 'REQUESTED' as const,
        expiresAt: null,
        approvedAt: null,
        rejectedAt: null,
        riskAcceptedByUserId: 'u_admin',
        createdByUserId: 'u_creator',
        createdAt: new Date('2026-04-30').toISOString(),
        renewedFromId: null,
        compensatingControlId: null,
        control: { id: 'c1', name: 'Affected', code: 'AC.1' },
        compensatingControl: null,
        ...overrides,
    };
}

function installFetch(rows: unknown[]) {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
        async () => ({
            ok: true,
            json: async () => ({ rows }),
        }),
    );
}

const compensatingChoices = [
    { id: 'c2', name: 'Compensating', code: 'AC.2' },
];

describe('ControlExceptionsPanel', () => {
    it('renders empty state when no exceptions exist', async () => {
        installFetch([]);
        render(
            withClient(
                <ControlExceptionsPanel
                    tenantSlug="acme"
                    controlId="c1"
                    compensatingControlChoices={compensatingChoices}
                    defaultRiskAcceptedByUserId="u_admin"
                    canWrite
                    canAdmin
                />,
            ),
        );
        await screen.findByTestId('control-exceptions-empty');
    });

    it('renders one row per exception with the right testid', async () => {
        installFetch([
            makeExceptionRow({ id: 'cex_a', status: 'REQUESTED' }),
            makeExceptionRow({
                id: 'cex_b',
                status: 'APPROVED',
                approvedAt: new Date().toISOString(),
                expiresAt: new Date('2026-12-31').toISOString(),
            }),
        ]);
        render(
            withClient(
                <ControlExceptionsPanel
                    tenantSlug="acme"
                    controlId="c1"
                    compensatingControlChoices={compensatingChoices}
                    defaultRiskAcceptedByUserId="u_admin"
                    canWrite
                    canAdmin
                />,
            ),
        );
        await screen.findByTestId('control-exception-row-cex_a');
        await screen.findByTestId('control-exception-row-cex_b');
    });

    it('names each status, and a renewal by its predecessor rather than an id slice (#4691)', async () => {
        installFetch([
            makeExceptionRow({ id: 'cex_old_0123456789', status: 'EXPIRED' }),
            makeExceptionRow({ id: 'cex_new', status: 'REJECTED', renewedFromId: 'cex_old_0123456789' }),
        ]);
        render(
            withClient(
                <ControlExceptionsPanel
                    tenantSlug="acme"
                    controlId="c1"
                    compensatingControlChoices={compensatingChoices}
                    defaultRiskAcceptedByUserId="u_admin"
                    canWrite
                    canAdmin
                />,
            ),
        );
        const renewal = await screen.findByTestId('control-exception-row-cex_new');
        // The test translator returns keys: a label key, never the raw code.
        expect(renewal).toHaveTextContent('status.REJECTED');
        expect(renewal).toHaveTextContent('renewedFrom');
        expect(renewal).not.toHaveTextContent('cex_old_');
        expect(screen.getByTestId('control-exception-row-cex_old_0123456789')).toHaveTextContent('status.EXPIRED');
    });

    it('header badge surfaces an in-force exception as "Excepted until <date>"', async () => {
        installFetch([
            makeExceptionRow({
                status: 'APPROVED',
                approvedAt: new Date().toISOString(),
                // Far-future so the exception is always in-force for this test.
                expiresAt: new Date('2099-12-31').toISOString(),
            }),
        ]);
        render(
            withClient(
                <ControlExceptionsPanel
                    tenantSlug="acme"
                    controlId="c1"
                    compensatingControlChoices={compensatingChoices}
                    defaultRiskAcceptedByUserId="u_admin"
                    canWrite
                    canAdmin
                />,
            ),
        );
        const badge = await screen.findByTestId(
            'control-exception-header-badge',
        );
        // R2-P5 — an APPROVED + unexpired exception reads via the
        // `exceptedUntil` label (not the raw status). The test i18n returns the
        // key path, so match either the key or the resolved copy, and assert
        // the raw status label is NOT shown.
        expect(badge.textContent).toMatch(/exceptedUntil|Excepted until/i);
        expect(badge.textContent).not.toMatch(/exceptionLabel/);
    });

    it('non-write actor cannot see the Request button', async () => {
        installFetch([]);
        render(
            withClient(
                <ControlExceptionsPanel
                    tenantSlug="acme"
                    controlId="c1"
                    compensatingControlChoices={compensatingChoices}
                    defaultRiskAcceptedByUserId="u_admin"
                    canWrite={false}
                    canAdmin={false}
                />,
            ),
        );
        await screen.findByTestId('control-exceptions-empty');
        expect(
            screen.queryByTestId('control-exception-request-button'),
        ).toBeNull();
    });

    it('approve / reject buttons only render for admins on REQUESTED rows', async () => {
        installFetch([
            makeExceptionRow({ id: 'cex_req', status: 'REQUESTED' }),
            makeExceptionRow({
                id: 'cex_app',
                status: 'APPROVED',
                approvedAt: new Date().toISOString(),
                expiresAt: new Date('2026-12-31').toISOString(),
            }),
        ]);
        // Non-admin write user — no approve/reject buttons.
        const r1 = render(
            withClient(
                <ControlExceptionsPanel
                    tenantSlug="acme"
                    controlId="c1"
                    compensatingControlChoices={compensatingChoices}
                    defaultRiskAcceptedByUserId="u_admin"
                    canWrite
                    canAdmin={false}
                />,
            ),
        );
        await screen.findByTestId('control-exception-row-cex_req');
        expect(
            screen.queryByTestId('control-exception-approve-button-cex_req'),
        ).toBeNull();
        expect(
            screen.queryByTestId('control-exception-reject-button-cex_req'),
        ).toBeNull();
        r1.unmount();

        // Admin — buttons visible on REQUESTED, NOT on APPROVED.
        render(
            withClient(
                <ControlExceptionsPanel
                    tenantSlug="acme"
                    controlId="c1"
                    compensatingControlChoices={compensatingChoices}
                    defaultRiskAcceptedByUserId="u_admin"
                    canWrite
                    canAdmin
                />,
            ),
        );
        await screen.findByTestId('control-exception-row-cex_req');
        expect(
            screen.getByTestId('control-exception-approve-button-cex_req'),
        ).toBeTruthy();
        expect(
            screen.queryByTestId('control-exception-approve-button-cex_app'),
        ).toBeNull();
    });

    it('renew button only renders on APPROVED or EXPIRED rows', async () => {
        installFetch([
            makeExceptionRow({ id: 'cex_req', status: 'REQUESTED' }),
            makeExceptionRow({
                id: 'cex_app',
                status: 'APPROVED',
                approvedAt: new Date().toISOString(),
                expiresAt: new Date('2026-12-31').toISOString(),
            }),
            makeExceptionRow({
                id: 'cex_exp',
                status: 'EXPIRED',
                approvedAt: new Date().toISOString(),
                expiresAt: new Date('2025-01-01').toISOString(),
            }),
            makeExceptionRow({
                id: 'cex_rej',
                status: 'REJECTED',
                rejectedAt: new Date().toISOString(),
            }),
        ]);
        render(
            withClient(
                <ControlExceptionsPanel
                    tenantSlug="acme"
                    controlId="c1"
                    compensatingControlChoices={compensatingChoices}
                    defaultRiskAcceptedByUserId="u_admin"
                    canWrite
                    canAdmin
                />,
            ),
        );
        await screen.findByTestId('control-exception-row-cex_req');
        expect(
            screen.queryByTestId('control-exception-renew-button-cex_req'),
        ).toBeNull();
        expect(
            screen.getByTestId('control-exception-renew-button-cex_app'),
        ).toBeTruthy();
        expect(
            screen.getByTestId('control-exception-renew-button-cex_exp'),
        ).toBeTruthy();
        expect(
            screen.queryByTestId('control-exception-renew-button-cex_rej'),
        ).toBeNull();
    });

    it('request form requires justification before submit is enabled', async () => {
        installFetch([]);
        render(
            withClient(
                <ControlExceptionsPanel
                    tenantSlug="acme"
                    controlId="c1"
                    compensatingControlChoices={compensatingChoices}
                    defaultRiskAcceptedByUserId="u_admin"
                    canWrite
                    canAdmin
                />,
            ),
        );
        fireEvent.click(
            await screen.findByTestId('control-exception-request-button'),
        );
        const submit = (await screen.findByTestId(
            'exception-form-submit',
        )) as HTMLButtonElement;
        // Empty justification → disabled.
        expect(submit.disabled).toBe(true);
        fireEvent.change(screen.getByTestId('exception-form-justification'), {
            target: { value: 'legacy system gap' },
        });
        expect(submit.disabled).toBe(false);
    });

    it('reject dialog requires reason before submit is enabled', async () => {
        installFetch([
            makeExceptionRow({ id: 'cex_req', status: 'REQUESTED' }),
        ]);
        render(
            withClient(
                <ControlExceptionsPanel
                    tenantSlug="acme"
                    controlId="c1"
                    compensatingControlChoices={compensatingChoices}
                    defaultRiskAcceptedByUserId="u_admin"
                    canWrite
                    canAdmin
                />,
            ),
        );
        fireEvent.click(
            await screen.findByTestId('control-exception-reject-button-cex_req'),
        );
        const submit = (await screen.findByTestId(
            'exception-reject-submit',
        )) as HTMLButtonElement;
        expect(submit.disabled).toBe(true);
        fireEvent.change(screen.getByTestId('exception-reject-reason'), {
            target: { value: 'mitigation insufficient' },
        });
        expect(submit.disabled).toBe(false);
    });
});
