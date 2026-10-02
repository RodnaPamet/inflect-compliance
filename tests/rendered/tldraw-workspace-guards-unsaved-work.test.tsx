/**
 * @jest-environment jsdom
 *
 * Unsaved work on the tldraw canvas does not leave silently.
 *
 * ── Why this test exists ─────────────────────────────────────────────
 *
 * The regression list on #2962 asks whether the shared unsaved-changes guard
 * "still fires on BOTH tab close and in-app navigation, driven by the new
 * canvas's dirty state". It did not: `TldrawProcessWorkspace` called neither
 * hook, so a tab close or a sidebar click would have discarded edits with no
 * word.
 *
 * That was the only gap in the migration that DESTROYS something rather than
 * missing it. Everything else found — the inert size control, the unported diff
 * overlay — is a visible absence; this one was invisible until the work was
 * gone.
 *
 * Asserted on the ARGUMENT the hooks receive rather than on a registered
 * listener, because the hooks have their own tests for the listener half and
 * what was missing here was the wiring.
 */
import { render } from '@testing-library/react';

import { TldrawProcessWorkspace } from '@/components/processes/TldrawProcessWorkspace';
import { TenantProvider } from '@/lib/tenant-context-provider';
import type { AutosaveStatus } from '@/lib/processes/use-canvas-autosave';

/** Every value the two guards were handed, in call order. */
const warnCalls: boolean[] = [];
const navCalls: Array<[boolean, string]> = [];

/**
 * `requireActual` spread, not a bare replacement. `@/lib/hooks` is a barrel the
 * UI primitives reach into — replacing it wholesale is what left `Popover`
 * without `useMediaQuery` in the export-menu suite and failed every test with
 * `is not a function`.
 */
jest.mock('@/lib/hooks', () => ({
    ...jest.requireActual('@/lib/hooks'),
    useUnsavedChangesWarning: (dirty: boolean) => {
        warnCalls.push(dirty);
    },
    useUnsavedNavigationGuard: (dirty: boolean, msg: string) => {
        navCalls.push([dirty, msg]);
    },
}));

/** The canvas is irrelevant here; only the status it reports matters. */
let reportStatus: AutosaveStatus = 'idle';
jest.mock('@/components/processes/TldrawProcessMap', () => {
    const { useEffect } = jest.requireActual<typeof import('react')>('react');
    return {
        TldrawProcessMap: ({
            onStateChange,
        }: {
            onStateChange?: (s: {
                version: number | undefined;
                autosaveStatus: AutosaveStatus;
            }) => void;
        }) => {
            // In an EFFECT, not the render body. Reporting during render sets
            // state in the parent mid-render — React warns "Cannot update a
            // component while rendering a different component" — and the real
            // component deliberately does not do that. A stub that violates
            // the contract it stands in for tests the wrong thing, and a
            // warning left in a suite is how warnings stop being read.
            useEffect(() => {
                onStateChange?.({ version: 1, autosaveStatus: reportStatus });
            }, [onStateChange]);
            return <div data-testid="map-stub" />;
        },
    };
});

jest.mock('@/components/processes/CanvasDocumentBar', () => ({
    CanvasDocumentBar: () => <div data-testid="bar-stub" />,
}));
jest.mock('@/components/processes/ProcessInspector', () => ({
    ProcessInspector: () => <div data-testid="inspector-stub" />,
}));
jest.mock('@/components/processes/ProcessPalette', () => ({
    ProcessPalette: () => <div data-testid="palette-stub" />,
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
        nodeCount: 1,
        edgeCount: 0,
        canvasMode: 'DOCUMENT' as const,
    },
];

function mount(status: AutosaveStatus) {
    warnCalls.length = 0;
    navCalls.length = 0;
    reportStatus = status;
    render(
        <TenantProvider value={TENANT_CTX}>
            <TldrawProcessWorkspace
                tenantSlug="acme"
                processes={PROCESSES}
                activeId="map-1"
                onActiveIdChange={() => {}}
                onProcessesChange={() => {}}
            />,
        </TenantProvider>
    );
}

/** The last value each guard saw. */
const lastWarn = () => warnCalls[warnCalls.length - 1];
const lastNav = () => navCalls[navCalls.length - 1];


/*
    `TenantProvider` is required as of #3115, and it is a product fact rather
    than scaffolding: the workspace mounts `OverlayBridge`, whose `useTenantSWR`
    resolves the tenant API URL through `useTenantContext` EAGERLY — before the
    null key is consulted — so it throws without a provider even with Run Mode
    off and nothing being fetched.

    Satisfied in the app: `ProcessesClient` renders under
    `src/app/t/[tenantSlug]/layout.tsx`, which mounts this. The workspace
    previously needed no context at all — it takes `tenantSlug` as a PROP and
    builds its own URLs — which is why this arrived with the overlay and not
    before. A per-file literal rather than a shared helper, following the
    pattern every other rendered test here uses.
*/
const TENANT_CTX = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    tenantName: 'Acme',
    role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
} as never;

describe('both guards are wired, because neither covers the other', () => {
    it('the tab-close guard is armed while a save is PENDING', () => {
        // `pending` is the debounce window — markDirty has fired, the save has
        // not — which is where most unsaved work lives during normal editing.
        mount('pending');
        expect(lastWarn()).toBe(true);
    });

    it('and so is the in-app navigation guard, with a message', () => {
        // `beforeunload` never fires for an App Router client-side transition,
        // so the tab-close guard alone still loses work to a sidebar click.
        mount('pending');
        expect(lastNav()?.[0]).toBe(true);
        expect(lastNav()?.[1]).toBeTruthy();
    });
});

describe('the status window', () => {
    it.each<AutosaveStatus>(['pending', 'saving', 'error'])(
        'arms both guards for %s',
        (status) => {
            mount(status);
            expect(lastWarn()).toBe(true);
            expect(lastNav()?.[0]).toBe(true);
        },
    );

    it('and DISARMS them when idle — teeth for the above', () => {
        // A guard armed unconditionally would satisfy every assertion above
        // while prompting the user on every navigation away from a clean
        // canvas, which is the failure that gets guards deleted.
        mount('idle');
        expect(lastWarn()).toBe(false);
        expect(lastNav()?.[0]).toBe(false);
    });
});
