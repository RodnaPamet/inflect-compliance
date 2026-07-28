/**
 * Rendered tests for the shared <ConfirmDialog>.
 *
 * `ConfirmDialog` is a top-level alias for Modal.Confirm — these tests
 * verify the alias is wired correctly and exercise the destructive-action
 * contract: tone-driven styling, Promise-based onConfirm, error retention.
 *
 * Modal renders the title twice (once visually-hidden as Dialog.Title for
 * screen readers, once visible inside the Header). All title queries use
 * `getAllByText` to handle the legitimate duplication.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

// Modal transitively uses Next router hooks.
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/admin/api-keys',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

// Force the desktop Dialog branch — jsdom's matchMedia polyfill returns
// matches:false so useMediaQuery defaults to mobile, which mounts the
// Vaul Drawer; Vaul's drag-handlers throw "Cannot read 'match' of
// undefined" in jsdom. The Dialog branch is what real desktop users see
// for a confirm dialog anyway.
jest.mock('@/components/ui/hooks', () => {
    const actual = jest.requireActual('@/components/ui/hooks');
    return {
        ...actual,
        useMediaQuery: () => ({
            device: 'desktop',
            width: 1024,
            height: 768,
            isMobile: false,
            isDesktop: true,
        }),
    };
});

import { ConfirmDialog } from '@/components/ui/confirm-dialog';

function Harness(props: {
    onConfirm: () => void | Promise<unknown>;
    onCancel?: () => void;
    tone?: 'danger' | 'warning' | 'info';
    confirmLabel?: string;
    cancelLabel?: string;
    initiallyOpen?: boolean;
}) {
    const [open, setOpen] = React.useState(props.initiallyOpen ?? true);
    return (
        <>
            <ConfirmDialog
                showModal={open}
                setShowModal={setOpen}
                tone={props.tone ?? 'danger'}
                title="Revoke API key?"
                description="Integrations using this key will lose access. This cannot be undone."
                confirmLabel={props.confirmLabel ?? 'Revoke'}
                cancelLabel={props.cancelLabel ?? 'Cancel'}
                onConfirm={props.onConfirm}
                onCancel={props.onCancel}
            />
            <span data-testid="modal-state">{open ? 'open' : 'closed'}</span>
        </>
    );
}

describe('ConfirmDialog', () => {
    it('renders title + description when open', async () => {
        render(<Harness onConfirm={() => undefined} />);
        // Title appears twice — visually-hidden Dialog.Title + the
        // header h2. Description appears once in the header.
        await waitFor(() =>
            expect(screen.getAllByText('Revoke API key?').length).toBeGreaterThan(0),
        );
        expect(
            screen.getAllByText(/integrations using this key/i).length,
        ).toBeGreaterThan(0);
    });

    it('fires onConfirm and closes the modal on success', async () => {
        // pointerEventsCheck=0 — Radix sets pointer-events:none on
        // <body> while a Dialog is open (scroll-lock). userEvent's
        // default check refuses to click anything inside such a
        // subtree. The portalised modal content IS clickable for real
        // users; this flag matches that reality in jsdom.
        const user = userEvent.setup({ pointerEventsCheck: 0 });
        const onConfirm = jest.fn();
        render(<Harness onConfirm={onConfirm} />);

        await user.click(
            await screen.findByRole('button', { name: 'Revoke' }),
        );
        expect(onConfirm).toHaveBeenCalledTimes(1);
        await waitFor(() =>
            expect(screen.getByTestId('modal-state')).toHaveTextContent('closed'),
        );
    });

    it('fires onCancel and closes the modal', async () => {
        // pointerEventsCheck=0 — Radix sets pointer-events:none on
        // <body> while a Dialog is open (scroll-lock). userEvent's
        // default check refuses to click anything inside such a
        // subtree. The portalised modal content IS clickable for real
        // users; this flag matches that reality in jsdom.
        const user = userEvent.setup({ pointerEventsCheck: 0 });
        const onCancel = jest.fn();
        render(
            <Harness onConfirm={() => undefined} onCancel={onCancel} />,
        );

        await user.click(
            await screen.findByRole('button', { name: 'Cancel' }),
        );
        expect(onCancel).toHaveBeenCalledTimes(1);
        await waitFor(() =>
            expect(screen.getByTestId('modal-state')).toHaveTextContent('closed'),
        );
    });

    it('paints the destructive button class when tone="danger"', async () => {
        render(<Harness onConfirm={() => undefined} tone="danger" />);
        const confirm = await screen.findByRole('button', { name: 'Revoke' });
        // PR-1 migrated the danger button variant from bg-red-600/80 to the
        // semantic bg-bg-error-emphasis token.
        // R24-hotfix replaced the opaque `bg-bg-error-emphasis` with the
        // translucent `--btn-glass-fill-destructive` token so the glass
        // backdrop-blur had a transparent base to act on.
        // Still Surface (2026-07-28) replaced the glass fill with a static
        // gradient between the danger stops — the destructive tile is the
        // same material as primary, differing only in hue.
        //
        // The assertion tracks the destructive FILL regardless of which
        // encoding it currently uses; what matters to this test is that
        // tone="danger" reaches the destructive variant at all.
        expect(confirm.className).toMatch(
            /bg-(?:bg-error-emphasis|\[var\(--btn-glass-fill-destructive\)\]|\[image:[^\]]*--btn-still-danger)/,
        );
    });

    it('keeps the modal open when onConfirm rejects', async () => {
        // pointerEventsCheck=0 — Radix sets pointer-events:none on
        // <body> while a Dialog is open (scroll-lock). userEvent's
        // default check refuses to click anything inside such a
        // subtree. The portalised modal content IS clickable for real
        // users; this flag matches that reality in jsdom.
        const user = userEvent.setup({ pointerEventsCheck: 0 });
        const onConfirm = jest
            .fn()
            .mockImplementation(() => Promise.reject(new Error('boom')));
        render(<Harness onConfirm={onConfirm} />);

        await user.click(
            await screen.findByRole('button', { name: 'Revoke' }),
        );
        await waitFor(() => expect(onConfirm).toHaveBeenCalled());
        // Modal-state still 'open' => modal stayed open.
        expect(screen.getByTestId('modal-state')).toHaveTextContent('open');
    });

    it('renders custom confirm/cancel labels', async () => {
        render(
            <Harness
                onConfirm={() => undefined}
                confirmLabel="Delete forever"
                cancelLabel="Keep it"
            />,
        );
        expect(
            await screen.findByRole('button', { name: 'Delete forever' }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole('button', { name: 'Keep it' }),
        ).toBeInTheDocument();
    });
});
