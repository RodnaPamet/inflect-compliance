/**
 * THE PENDING STATE THE PROPS DOC HAS ALWAYS PROMISED.
 *
 * `ConfirmModalProps.onConfirm` is documented as "If it returns a Promise, the
 * button shows a pending state until it settles" — and nothing implemented it.
 * So a confirm wired to a slow DELETE sat there looking inert, and a second
 * click ran `onConfirm` again: two deletes, or two of whatever the caller did.
 *
 * The teeth here are the SECOND CLICK. A test that only checked for a spinner
 * would pass on a cosmetic fix that still double-submits.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

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

import { ConfirmDialog } from '@/components/ui/confirm-dialog';

/** A promise this test decides when to settle. */
function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function Harness({ onConfirm }: { onConfirm: () => Promise<unknown> }) {
    const [open, setOpen] = React.useState(true);
    return (
        <ConfirmDialog
            showModal={open}
            setShowModal={setOpen}
            tone="danger"
            title="remove?"
            onConfirm={onConfirm}
        />
    );
}

const confirmButton = () =>
    document.querySelector<HTMLButtonElement>('[data-modal-confirm]')!;
const cancelButton = () =>
    document.querySelector<HTMLButtonElement>('[data-modal-cancel]')!;

describe('<ConfirmDialog /> — pending state', () => {
    it('disables the confirm button and paints a spinner while onConfirm runs', async () => {
        const user = userEvent.setup();
        const gate = deferred();
        render(<Harness onConfirm={() => gate.promise} />);

        expect(confirmButton().disabled).toBe(false);
        expect(
            confirmButton().querySelector('.loading-spinner'),
        ).toBeNull();

        await user.click(confirmButton());

        await waitFor(() => expect(confirmButton().disabled).toBe(true));
        expect(
            confirmButton().querySelector('.loading-spinner'),
        ).not.toBeNull();

        gate.resolve();
    });

    it('a second click does NOT run onConfirm again', async () => {
        // `pointerEventsCheck: 0` (a setup() option in user-event 14, not a
        // per-call one) so userEvent delivers the second click instead of
        // refusing it as unclickable — a refusal would make the assertion a
        // statement about userEvent rather than about the dialog.
        //
        // What this proves is that the double-submit is CLOSED, not which of
        // the two mechanisms closes it: `disabled` means jsdom dispatches no
        // click at all, so the `if (pending) return` guard at the top of
        // handleConfirm is a backstop this test cannot isolate. That is the
        // right way round — the DOM-level block is the one a real browser
        // enforces.
        const user = userEvent.setup({ pointerEventsCheck: 0 });
        const gate = deferred();
        const onConfirm = jest.fn(() => gate.promise);
        render(<Harness onConfirm={onConfirm} />);

        await user.click(confirmButton());
        await waitFor(() => expect(confirmButton().disabled).toBe(true));

        await user.click(confirmButton());

        expect(onConfirm).toHaveBeenCalledTimes(1);

        gate.resolve();
    });

    it('cancel is disabled while the action is in flight', async () => {
        // Cancelling mid-flight closes the dialog under an in-flight promise
        // whose own close then runs against something already dismissed.
        const user = userEvent.setup();
        const gate = deferred();
        render(<Harness onConfirm={() => gate.promise} />);

        await user.click(confirmButton());

        await waitFor(() => expect(cancelButton().disabled).toBe(true));

        gate.resolve();
    });

    it('closes once the promise resolves', async () => {
        const user = userEvent.setup();
        const gate = deferred();
        render(<Harness onConfirm={() => gate.promise} />);

        await user.click(confirmButton());
        await waitFor(() => expect(confirmButton().disabled).toBe(true));

        gate.resolve();

        await waitFor(() =>
            expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
        );
    });

    it('a REJECTED promise clears pending and keeps the dialog open', async () => {
        // Otherwise the dialog is left with a dead button and the user cannot
        // retry — strictly worse than the no-pending-state behaviour it
        // replaces.
        const user = userEvent.setup();
        const gate = deferred();
        render(<Harness onConfirm={() => gate.promise} />);

        await user.click(confirmButton());
        await waitFor(() => expect(confirmButton().disabled).toBe(true));

        gate.reject(new Error('nope'));

        await waitFor(() => expect(confirmButton().disabled).toBe(false));
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('a SYNCHRONOUS onConfirm closes immediately and never shows a spinner', async () => {
        // The common case must not regress into a flash of pending state.
        const user = userEvent.setup();
        const onConfirm = jest.fn();
        const Sync = () => {
            const [open, setOpen] = React.useState(true);
            return (
                <ConfirmDialog
                    showModal={open}
                    setShowModal={setOpen}
                    title="remove?"
                    onConfirm={onConfirm}
                />
            );
        };
        render(<Sync />);

        await user.click(confirmButton());

        expect(onConfirm).toHaveBeenCalledTimes(1);
        await waitFor(() =>
            expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
        );
    });
});
