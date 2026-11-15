/** @jest-environment jsdom */

/**
 * On a phone, a ConfirmDialog whose action is still running cannot be
 * dismissed (#5309).
 *
 * The desktop dialog already refused Escape and the backdrop while pending.
 * The phone drawer's close passed `dragged: true` for every dismissal — a
 * backdrop tap or Escape as well as a drag — which waved it past
 * `preventDefaultClose`: the drawer closed and `onCancel` cleared the caller's
 * target while the delete went on, and a failed request then had nothing left
 * open to report into.
 *
 * jsdom's matchMedia answers `matches: false`, which `useMediaQuery` reads as
 * a phone, so the modal takes its drawer branch. vaul is stubbed to expose the
 * one thing under test: what the modal does when the drawer asks to close.
 */
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('vaul', () => {
    const React = jest.requireActual('react');
    // vaul is built on Radix Dialog, so the modal's Dialog.Title needs its
    // context; the stub provides it the same way.
    const Dialog = jest.requireActual('@radix-ui/react-dialog');
    const Pass = ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children);
    const Root = ({
        open,
        onOpenChange,
        children,
    }: {
        open: boolean;
        onOpenChange: (open: boolean) => void;
        children?: React.ReactNode;
    }) =>
        open
            ? React.createElement(
                  Dialog.Root,
                  { open: true },
                  React.createElement(
                      'div',
                      { 'data-testid': 'drawer' },
                      // What vaul calls for a backdrop tap, Escape or a drag.
                      React.createElement('button', {
                          type: 'button',
                          'data-testid': 'drawer-dismiss',
                          onClick: () => onOpenChange(false),
                      }),
                      children,
                  ),
              )
            : null;
    const Content = ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children);
    return {
        Drawer: {
            Root,
            Portal: Pass,
            Overlay: () => null,
            Content,
            Title: Pass,
            Description: Pass,
            Trigger: Pass,
        },
    };
});

import { ConfirmDialog } from '@/components/ui/confirm-dialog';

function Harness({ onConfirm, onCancel }: { onConfirm: () => Promise<unknown>; onCancel: () => void }) {
    const [open, setOpen] = React.useState(true);
    return (
        <ConfirmDialog
            showModal={open}
            setShowModal={setOpen}
            title="Delete the policy?"
            tone="danger"
            confirmLabel="Delete policy"
            onConfirm={onConfirm}
            onCancel={onCancel}
        />
    );
}

describe('ConfirmDialog on the phone drawer', () => {
    it('a dismissal while the action runs is refused', async () => {
        const onCancel = jest.fn();
        render(<Harness onConfirm={() => new Promise(() => {})} onCancel={onCancel} />);

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Delete policy' }));
        });
        fireEvent.click(screen.getByTestId('drawer-dismiss'));

        expect(onCancel).not.toHaveBeenCalled();
        expect(screen.getByTestId('drawer')).toBeInTheDocument();
    });

    it('a dismissal with nothing running closes it and cancels', () => {
        const onCancel = jest.fn();
        render(<Harness onConfirm={() => new Promise(() => {})} onCancel={onCancel} />);

        fireEvent.click(screen.getByTestId('drawer-dismiss'));

        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('drawer')).toBeNull();
    });
});
