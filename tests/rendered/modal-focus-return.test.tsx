/**
 * A DIALOG OWES A KEYBOARD USER TWO THINGS, AND THIS PRIMITIVE DID NEITHER.
 *
 * `<Modal>` used to pass `onOpenAutoFocus={(e) => e.preventDefault()}` AND
 * `onCloseAutoFocus={(e) => e.preventDefault()}` unconditionally, which breaks
 * both halves of the contract at once:
 *
 *   • focus never ENTERS the dialog, so the next Tab continues through the page
 *     behind the overlay — a keyboard user is tabbing through content they
 *     cannot see, and a screen reader is never told a dialog opened;
 *   • focus never RETURNS on close, so dismissing the dialog drops the user at
 *     the top of the document and they have to tab back to where they were.
 *
 * Both are now Radix's defaults. `preventAutoFocus` is the explicit opt-out for
 * content that manages focus itself.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

// Modal uses Next.js's useRouter() as a fallback close path; stub it.
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/',
    useSearchParams: () => new URLSearchParams(),
}));

import { Modal } from '@/components/ui/modal';

function Harness({ preventAutoFocus }: { preventAutoFocus?: boolean }) {
    const [open, setOpen] = React.useState(false);
    return (
        <>
            <button type="button" onClick={() => setOpen(true)}>
                opener
            </button>
            <Modal
                showModal={open}
                setShowModal={setOpen}
                desktopOnly
                size="md"
                title="detail"
                preventAutoFocus={preventAutoFocus}
            >
                <Modal.Header title="detail" />
                <Modal.Body>
                    <input aria-label="name" />
                </Modal.Body>
            </Modal>
        </>
    );
}

describe('<Modal /> — focus moves in and comes back', () => {
    it('moves focus INTO the dialog on open', async () => {
        const user = userEvent.setup();
        render(<Harness />);

        const opener = screen.getByRole('button', { name: 'opener' });
        await user.click(opener);

        const dialog = screen.getByRole('dialog');
        // Which element Radix lands on is its business — the contract is that
        // the focused element is inside the dialog, not out on the page behind
        // the overlay.
        expect(dialog.contains(document.activeElement)).toBe(true);
        expect(document.activeElement).not.toBe(opener);
    });

    it('returns focus to the trigger on close', async () => {
        const user = userEvent.setup();
        render(<Harness />);

        const opener = screen.getByRole('button', { name: 'opener' });
        await user.click(opener);
        expect(screen.getByRole('dialog')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Close' }));

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
    });

    it('preventAutoFocus opts out of BOTH halves', async () => {
        // The escape hatch for content that manages focus itself. It must be a
        // genuine opt-out, not merely a different first focus target: with it
        // set, focus stays exactly where the user left it.
        const user = userEvent.setup();
        render(<Harness preventAutoFocus />);

        const opener = screen.getByRole('button', { name: 'opener' });
        await user.click(opener);

        const dialog = screen.getByRole('dialog');
        expect(dialog.contains(document.activeElement)).toBe(false);
        expect(opener).toHaveFocus();
    });
});
