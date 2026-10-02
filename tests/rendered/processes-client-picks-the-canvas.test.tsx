/**
 * @jest-environment jsdom
 *
 * Which canvas a tenant gets — and there is only one.
 *
 * ── Rewritten, not deleted (#3079) ──────────────────────────────────
 *
 * This file used to assert a BRANCH: `usesTldraw` picked the tldraw workspace,
 * its absence defaulted to xyflow, and that default mattered because an
 * unreadable flag silently swapping a customer's canvas was the failure worth
 * guarding. The flag is gone with the renderer it chose, so all three of those
 * assertions now describe code that does not exist.
 *
 * Deleting the file would have been the easy reading and the wrong one. The
 * question it answers — "what does this client actually mount?" — is still
 * live, and it is the question the ORIGINAL defect in this area was about: the
 * canvas reachable from the processes page was for a long time not the one the
 * tests exercised. So the branch assertions become unconditional ones.
 *
 * What is deliberately NOT asserted any more is a default. There is no flag to
 * be absent, and an assertion about the fallback for a value that cannot
 * exist would pass forever without describing anything.
 *
 * The workspace is stubbed: it has its own suites, and mounting a real editor
 * to answer "which component is rendered" would be a slow way to read one
 * line of JSX.
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

describe('the canvas this client mounts', () => {
    it('mounts the tldraw workspace, with no flag to ask', async () => {
        render(<ProcessesClient tenantSlug="acme" initialProcesses={PROCESSES} />);
        await settle();
        expect(await screen.findByTestId('tldraw-workspace')).toBeInTheDocument();
    });

    it('mounts exactly ONE canvas, not two', async () => {
        // The branch is gone, so the new failure mode is a leftover second
        // mount rather than the wrong one chosen. A `?:` collapsed carelessly
        // renders both arms, and both arms rendering looks like neither
        // assertion failing.
        render(<ProcessesClient tenantSlug="acme" initialProcesses={PROCESSES} />);
        await settle();
        expect(screen.getAllByTestId('tldraw-workspace')).toHaveLength(1);
    });

    it('names no deleted component anywhere in its module graph', async () => {
        // Teeth against the lazier cutover: a `dynamic()` import of a module
        // that no longer exists resolves to a REJECTED promise, and
        // `next/dynamic` swallows it into a never-resolving boundary rather
        // than throwing. The canvas would simply never appear, and a test
        // that only asserted the tldraw stub IS present would still pass if a
        // dead second import sat beside it.
        const src = require('node:fs').readFileSync(
            require('node:path').resolve(
                __dirname,
                '../../src/app/t/[tenantSlug]/(app)/processes/ProcessesClient.tsx',
            ),
            'utf8',
        ) as string;
        expect(src).not.toContain('PersistedProcessCanvas');
        expect(src).not.toContain('usesTldraw');
    });
});
