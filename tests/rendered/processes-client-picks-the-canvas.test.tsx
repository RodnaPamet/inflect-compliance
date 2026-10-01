/**
 * @jest-environment jsdom
 *
 * Which canvas a tenant gets.
 *
 * ── The one thing this must get right ────────────────────────────────
 *
 * `usesTldraw` is resolved on the SERVER by `isProcessCanvasTldrawEnabled` and
 * arrives as a boolean, so the only logic left on the client is the branch. Two
 * properties matter and the second is the one worth a test on its own:
 *
 *   1. the flag picks the tldraw workspace;
 *   2. the DEFAULT is the engine that has been shipping. A tenant whose flag
 *      could not be read must get xyflow, because that is the only direction a
 *      default can fail in safely — an unreadable flag silently swapping a
 *      customer's canvas is the failure this asserts against.
 *
 * Both canvases are stubbed: each has its own suites, and mounting either here
 * would cost a real editor for a question about an `if`.
 */
import { render, screen } from '@testing-library/react';

import { ProcessesClient } from '@/app/t/[tenantSlug]/(app)/processes/ProcessesClient';

/**
 * `useSearchParams()` returns null without a router, and the client reads
 * `.get` off it — the repo's other rendered tests mock this module the same
 * way. A real `URLSearchParams` is handed over rather than a stub with one
 * method, so a component reading any other part of it behaves normally.
 */
jest.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    }),
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/processes',
}));

jest.mock('@/components/processes/PersistedProcessCanvas', () => ({
    PersistedProcessCanvas: () => <div data-testid="xyflow-canvas" />,
}));

jest.mock('@/components/processes/TldrawProcessWorkspace', () => ({
    TldrawProcessWorkspace: () => <div data-testid="tldraw-workspace" />,
}));

const PROCESSES = [
    {
        id: 'map-1',
        name: 'Invoice approval',
        description: null,
        status: 'DRAFT' as const,
        version: 1,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        nodeCount: 2,
        edgeCount: 1,
        canvasMode: 'DOCUMENT' as const,
    },
];

/** `next/dynamic` resolves lazily; the stub renders on the next tick. */
async function settle() {
    await new Promise((r) => setTimeout(r, 0));
}

describe('the canvas the flag selects', () => {
    it('mounts the tldraw workspace when usesTldraw is true', async () => {
        render(
            <ProcessesClient tenantSlug="acme" initialProcesses={PROCESSES} usesTldraw />,
        );
        await settle();
        expect(await screen.findByTestId('tldraw-workspace')).toBeInTheDocument();
        expect(screen.queryByTestId('xyflow-canvas')).not.toBeInTheDocument();
    });

    it('mounts the xyflow canvas when usesTldraw is false', async () => {
        render(
            <ProcessesClient
                tenantSlug="acme"
                initialProcesses={PROCESSES}
                usesTldraw={false}
            />,
        );
        await settle();
        expect(await screen.findByTestId('xyflow-canvas')).toBeInTheDocument();
        expect(screen.queryByTestId('tldraw-workspace')).not.toBeInTheDocument();
    });

    it('DEFAULTS to xyflow when the prop is absent entirely', async () => {
        // THE assertion. A flag that could not be read must leave the tenant on
        // the engine that has been shipping — an absent prop silently swapping
        // a customer's canvas is the failure worth a test of its own.
        render(<ProcessesClient tenantSlug="acme" initialProcesses={PROCESSES} />);
        await settle();
        expect(await screen.findByTestId('xyflow-canvas')).toBeInTheDocument();
        expect(screen.queryByTestId('tldraw-workspace')).not.toBeInTheDocument();
    });
});
