/**
 * @jest-environment jsdom
 *
 * The drill-down breadcrumb, wired to the tldraw workspace.
 *
 * ── What was missing, and what was already built ────────────────────
 *
 * #3070 landed the scope semantics and #3085 made the canvas honour them, so
 * entering a group already hid what was outside it. Nothing could ENTER a group
 * from the workspace and nothing showed where you were — `drillGroupId` had no
 * supplier and the trail had no renderer.
 *
 * Almost nothing new was needed for that. `CanvasDrillBreadcrumb` and
 * `useCanvasDrillStack` are both engine-free and both already mounted by the
 * xyflow canvas, so this is the same component and the same state hook in the
 * same position. The assertions therefore target the JOIN, which is the only
 * part that is new and the only part a type error would not catch.
 *
 * ── Why a real editor rather than a stub ────────────────────────────
 *
 * The trail resolves a group's LABEL out of the store via `drillNodesFrom`, so
 * a stubbed editor would let a breadcrumb that renders the right number of
 * crumbs with the wrong text pass. The mocked container renders the real
 * canvas, which is the pattern `tldraw-workspace-command-palette` established.
 *
 * ── Deliberately a new file ─────────────────────────────────────────
 *
 * #3086 is open against `TldrawProcessMap` and `tldraw-workspace-history-and-
 * diff.test.tsx` has sibling edits. A new file keeps the open branches sharing
 * no test file.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Editor } from 'tldraw';

import { TldrawProcessWorkspace } from '@/components/processes/TldrawProcessWorkspace';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import type { GraphRows } from '@/components/processes/tldraw/serializer';
import type { AutosaveStatus } from '@/lib/processes/use-canvas-autosave';

/**
 * Three NESTED groups, a child, and a step outside everything.
 *
 * Three levels rather than one, because the jump arithmetic needs that many to
 * be discriminating: with a stack of two, clicking depth 1 pops once under both
 * `stack.length - depth` (2 − 1) and the off-by-one `depth` (1), so a two-level
 * fixture cannot tell a correct implementation from a broken one.
 */
const ROWS: GraphRows = {
    nodes: [
        {
            nodeKey: 'grp', nodeType: 'group', label: 'Approval sub-flow',
            subtitle: null, posX: 0, posY: 0, parentNodeKey: null, dataJson: null,
        },
        {
            nodeKey: 'inner', nodeType: 'group', label: 'Credit checks',
            subtitle: null, posX: 20, posY: 20, parentNodeKey: 'grp', dataJson: null,
        },
        {
            nodeKey: 'deepest', nodeType: 'group', label: 'Manual review',
            subtitle: null, posX: 30, posY: 30, parentNodeKey: 'inner', dataJson: null,
        },
        {
            nodeKey: 'inside', nodeType: 'processStep', label: 'Check limits',
            subtitle: null, posX: 40, posY: 40, parentNodeKey: 'deepest', dataJson: null,
        },
        {
            nodeKey: 'outside', nodeType: 'processStep', label: 'Archive',
            subtitle: null, posX: 600, posY: 400, parentNodeKey: null, dataJson: null,
        },
    ],
    edges: [],
};

/** What the container was handed — the scope, and the way to change it. */
let seenDrillGroupId: string | null | undefined;
let enterGroup: ((nodeKey: string) => void) | undefined;

jest.mock('@/components/processes/TldrawProcessMap', () => {
    const { useEffect } = jest.requireActual<typeof import('react')>('react');
    const {
        TldrawProcessCanvas,
    } = jest.requireActual<
        typeof import('@/components/processes/TldrawProcessCanvas')
    >('@/components/processes/TldrawProcessCanvas');
    return {
        TldrawProcessMap: ({
            onEditorReady,
            onStateChange,
            drillGroupId,
            onEnterGroup,
        }: {
            onEditorReady?: (e: Editor) => void;
            onStateChange?: (s: {
                version: number | undefined;
                autosaveStatus: AutosaveStatus;
            }) => void;
            drillGroupId?: string | null;
            onEnterGroup?: (nodeKey: string) => void;
        }) => {
            seenDrillGroupId = drillGroupId;
            enterGroup = onEnterGroup;
            useEffect(() => {
                onStateChange?.({ version: 1, autosaveStatus: 'idle' });
            }, [onStateChange]);
            return (
                <TldrawProcessCanvas
                    rows={ROWS}
                    drillGroupId={drillGroupId}
                    onEnterGroup={onEnterGroup}
                    onEditorReady={onEditorReady}
                />
            );
        },
    };
});

jest.mock('@/components/processes/CanvasDocumentBar', () => ({
    CanvasDocumentBar: () => <div data-testid="bar-stub" />,
}));
jest.mock('@/components/processes/CanvasCommandPalette', () => ({
    CanvasCommandPalette: () => <div data-testid="palette-stub" />,
}));
jest.mock('@/components/processes/ProcessInspector', () => ({
    ProcessInspector: () => <div data-testid="inspector-stub" />,
}));
jest.mock('@/components/processes/ProcessPalette', () => ({
    ProcessPalette: () => <div data-testid="node-palette-stub" />,
}));
jest.mock('@/components/processes/CanvasHistorySidebar', () => ({
    CanvasHistorySidebar: () => <div data-testid="history-stub" />,
}));
jest.mock('@/components/processes/CanvasDiffOverlay', () => ({
    CanvasDiffOverlay: () => <div data-testid="diff-stub" />,
}));

const PROCESSES = [{
    id: 'map-1', name: 'Invoice approval', description: null,
    status: 'DRAFT' as const, version: 1,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    nodeCount: 3, edgeCount: 0, canvasMode: 'DOCUMENT' as const,
}];

async function mount() {
    seenDrillGroupId = undefined;
    enterGroup = undefined;
    await act(async () => {
        render(
            // The provider is REQUIRED for the Escape assertion, and its
            // absence is silent: `KeyboardShortcutContext` defaults to a no-op
            // registry, so an unwrapped tree registers nothing and every
            // shortcut simply does not fire. `src/app/providers.tsx` mounts it
            // in the real app, so this is the production arrangement.
            <KeyboardShortcutProvider>
                <TldrawProcessWorkspace
                    tenantSlug="acme"
                    processes={PROCESSES}
                    activeId="map-1"
                    onActiveIdChange={() => {}}
                    onProcessesChange={() => {}}
                />
            </KeyboardShortcutProvider>,
        );
    });
}

const crumbs = () =>
    screen.queryAllByTestId('canvas-drill-crumb').map((b) => b.textContent);

describe('at root there is no trail', () => {
    it('renders no crumbs, and the canvas is scoped to nothing', async () => {
        await mount();
        expect(crumbs()).toEqual([]);
        expect(seenDrillGroupId).toBeNull();
    });
});

describe('entering a group', () => {
    it('shows the trail, naming the group from the STORE', async () => {
        // The label is the discriminator. A breadcrumb built from the stack
        // alone would render the nodeKey "grp" and look plausible.
        await mount();
        await act(async () => enterGroup!('grp'));
        expect(crumbs()).toEqual(['All', 'Approval sub-flow']);
    });

    it('and scopes the canvas to it — the half that was unsupplied', async () => {
        // `drillGroupId` had no supplier before this. The canvas honoured the
        // prop from #3085 and nothing ever set it.
        await mount();
        await act(async () => enterGroup!('grp'));
        expect(seenDrillGroupId).toBe('grp');
    });
});

describe('navigating back out', () => {
    it('clicking the root crumb returns to the whole map', async () => {
        await mount();
        await act(async () => enterGroup!('grp'));
        expect(crumbs()).toHaveLength(2);

        await act(async () => {
            screen.getAllByTestId('canvas-drill-crumb')[0]!.click();
        });
        expect(crumbs()).toEqual([]);
        expect(seenDrillGroupId).toBeNull();
    });

    it('ESCAPE pops one level — the parity a hand-rolled stack would lose', async () => {
        // `useCanvasDrillStack` binds Escape itself, enabled only above root.
        // Reusing the hook is what keeps this; a local useState would not have.
        await mount();
        await act(async () => enterGroup!('grp'));
        expect(seenDrillGroupId).toBe('grp');

        await act(async () => {
            fireEvent.keyDown(window, { key: 'Escape' });
        });
        expect(seenDrillGroupId).toBeNull();
        expect(crumbs()).toEqual([]);
    });

    it('the LAST crumb is inert — it is where you already are', async () => {
        await mount();
        await act(async () => enterGroup!('grp'));
        const all = screen.getAllByTestId('canvas-drill-crumb');
        expect(all[all.length - 1]).toBeDisabled();
        expect(all[0]).not.toBeDisabled();
    });
});

describe('jumping to a middle level, three deep', () => {
    async function drillThree() {
        await mount();
        await act(async () => enterGroup!('grp'));
        await act(async () => enterGroup!('inner'));
        await act(async () => enterGroup!('deepest'));
    }

    it('shows the whole nested trail', async () => {
        await drillThree();
        expect(crumbs()).toEqual([
            'All',
            'Approval sub-flow',
            'Credit checks',
            'Manual review',
        ]);
    });

    it('clicking depth 1 lands on the FIRST group, not the second', async () => {
        // The discriminating assertion. `stack.length - depth` = 3 − 1 = 2 pops
        // and leaves ['grp']; the off-by-one `depth` = 1 pop leaves
        // ['grp','inner'] and scopes the canvas one level too deep.
        await drillThree();
        await act(async () => {
            screen.getAllByTestId('canvas-drill-crumb')[1]!.click();
        });
        expect(seenDrillGroupId).toBe('grp');
        expect(crumbs()).toEqual(['All', 'Approval sub-flow']);
    });

    it('and depth 2 lands on the second', async () => {
        await drillThree();
        await act(async () => {
            screen.getAllByTestId('canvas-drill-crumb')[2]!.click();
        });
        expect(seenDrillGroupId).toBe('inner');
    });
});

describe('the crumb depths are the stack depths', () => {
    it('each crumb carries the depth it jumps to, root first', async () => {
        // The off-by-one risk: `trail[0]` is the root row, so depth N means a
        // stack of length N, not N - 1.
        await mount();
        await act(async () => enterGroup!('grp'));
        expect(
            screen.getAllByTestId('canvas-drill-crumb').map((b) =>
                b.getAttribute('data-depth'),
            ),
        ).toEqual(['0', '1']);
    });
});
