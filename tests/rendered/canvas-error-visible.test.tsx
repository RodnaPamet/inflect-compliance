/**
 * The autosave failure stays visible on the canvas — it is chrome, not a toast.
 *
 * ── The property, and why it needed a behavioural test ───────────────
 *
 * `use-canvas-autosave` deliberately does NOT retry on error: *"auto-retry on a
 * failing endpoint leads to thrashing under permanent failures … so we make the
 * failure visible instead."* That trade only pays if the failure really is
 * visible — and the canvas stays fully interactive during it, so a user who
 * misses or dismisses a transient notice keeps editing into nothing.
 *
 * `use-unsaved-changes-warning` catches them on the way out, on both tab close
 * and in-app navigation. It says nothing MID-SESSION. The persistent status chip
 * in `CanvasDocumentBar` is what covers that window, and #2961 names this file
 * as the test for it.
 *
 * ── Rendering the bar in isolation IS the assertion ──────────────────
 *
 * The distinguishing claim is "not only a dismissable toast". This suite mounts
 * `CanvasDocumentBar` alone, with **no toaster mounted anywhere**. So an error
 * these tests can SEE is necessarily document-bar chrome: were it toast-only,
 * every assertion below would fail to find anything. That is a stronger proof
 * than querying for the absence of a dismiss button, which would only show that
 * one particular affordance is missing.
 *
 * Teeth in the other direction matter too, hence the non-error statuses: an
 * indicator that renders unconditionally would satisfy every positive assertion
 * here while telling the user nothing.
 */
import { render, screen } from '@testing-library/react';

// The bar mounts a <Modal> (delete confirmation), and Modal/Sheet reach for the
// App Router — without this the render dies on "invariant expected app router
// to be mounted" before any assertion runs. next-intl needs no local mock: the
// global manual mock in `__mocks__/` already resolves keys against the real
// `messages/en.json`, which is what lets the assertions below check the
// SENTENCE the user reads rather than a key that might not exist.
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/processes',
    useSearchParams: () => new URLSearchParams(),
}));

import {
    CanvasDocumentBar,
    type CanvasDocumentBarProps,
} from '@/components/processes/CanvasDocumentBar';
import type { AutosaveStatus } from '@/lib/processes/use-canvas-autosave';

const ACTIVE = {
    id: 'map-1',
    name: 'Order to cash',
    description: null,
    status: 'DRAFT' as const,
    version: 4,
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    nodeCount: 3,
    edgeCount: 2,
};

function props(
    autosaveStatus: AutosaveStatus,
    autosaveError: string | null,
    overrides: { editedName?: string } = {},
): CanvasDocumentBarProps {
    return {
        tenantSlug: 'acme',
        doc: {
            activeId: ACTIVE.id,
            processes: [ACTIVE],
            activeProcess: ACTIVE,
            editedName: overrides.editedName ?? ACTIVE.name,
            loadedMap: { version: ACTIVE.version },
            error: null,
        },
        busy: { saving: false, loading: false, creating: false, duplicating: false },
        editorState: {
            snapEnabled: true,
            autosaveStatus,
            autosaveError,
            canUndo: true,
            canRedo: false,
        },
        handlers: {
            onActiveIdChange: jest.fn(),
            setEditedName: jest.fn(),
            handleSave: jest.fn(),
            handleNew: jest.fn(),
            handleDuplicate: jest.fn(),
            handleRenameCommit: jest.fn(),
            handleUndo: jest.fn(),
            handleRedo: jest.fn(),
            setSnapEnabled: jest.fn(),
            onSwitchMode: jest.fn(),
            onChangeStatus: jest.fn(),
            onDelete: jest.fn(),
        },
    };
}

describe('an autosave failure is visible on the canvas itself', () => {
    it('renders the failure in the document bar, with copy the user can read', () => {
        render(<CanvasDocumentBar {...props('error', 'HTTP 500')} />);

        const chip = screen.getByTestId('autosave-status');
        expect(chip).toHaveAttribute('data-autosave-status', 'error');
        // The real English catalogue resolves through the global next-intl mock,
        // so this asserts the SENTENCE the user sees — not a key that might not
        // exist. `automation.documentBar.saveFailed`, not `processes.*`.
        expect(chip).toHaveTextContent('Save failed');
    });

    it('carries the reason, so the failure is diagnosable and not just present', () => {
        render(<CanvasDocumentBar {...props('error', 'Version conflict: v5')} />);
        expect(screen.getByTestId('autosave-status')).toHaveAttribute(
            'title',
            'Version conflict: v5',
        );
    });

    it('survives the user carrying on editing — the window the exit guard misses', () => {
        // The failure mode this exists for: no retry, canvas still interactive,
        // so the user keeps working. Re-rendering with a changed name is that
        // user typing on; the indicator must still be there afterwards.
        const { rerender } = render(<CanvasDocumentBar {...props('error', 'HTTP 500')} />);
        expect(screen.getByTestId('autosave-status')).toHaveAttribute(
            'data-autosave-status',
            'error',
        );

        rerender(
            <CanvasDocumentBar
                {...props('error', 'HTTP 500', { editedName: 'Order to cash (edited)' })}
            />,
        );
        expect(screen.getByTestId('autosave-status')).toHaveAttribute(
            'data-autosave-status',
            'error',
        );
        expect(screen.getByTestId('autosave-status')).toHaveTextContent('Save failed');
    });

    it('leaves the manual Save reachable, so the user has a way out', () => {
        // The no-retry decision is only defensible if the user can retry by hand.
        render(<CanvasDocumentBar {...props('error', 'HTTP 500')} />);
        expect(screen.getByTestId('save-process-btn')).toBeEnabled();
    });
});

describe('and it is specific to the error state', () => {
    it.each<[AutosaveStatus, string]>([
        ['pending', 'pending'],
        ['saving', 'saving'],
        ['saved', 'saved'],
    ])('status %s reports itself, NOT a failure', (status, expected) => {
        render(<CanvasDocumentBar {...props(status, null)} />);
        expect(screen.getByTestId('autosave-status')).toHaveAttribute(
            'data-autosave-status',
            expected,
        );
        expect(screen.queryByText('Save failed')).not.toBeInTheDocument();
    });

    it('idle reports nothing at all', () => {
        // An always-present chip would pass every assertion above while telling
        // the user nothing, so the quiet case is asserted too.
        render(<CanvasDocumentBar {...props('idle', null)} />);
        expect(screen.queryByTestId('autosave-status')).not.toBeInTheDocument();
    });
});
