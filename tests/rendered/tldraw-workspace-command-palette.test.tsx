/**
 * @jest-environment jsdom
 *
 * The command palette, wired to the tldraw workspace.
 *
 * ── Why this is the end of a chain, not a UI test ───────────────────
 *
 * The palette renders groups and knows nothing about either renderer; the
 * builder is pure and tested on its own; the auto-layout host is tested against
 * a real store. What NONE of those cover is whether the three are connected —
 * and before this the auto-layout host had no consumer at all, so a module that
 * worked perfectly was reachable from nothing.
 *
 * So the assertion that matters here runs a command and checks the canvas
 * moved. Everything else is plumbing that a type error would catch.
 *
 * ── Deliberately a new file ─────────────────────────────────────────
 *
 * The obvious home is `tldraw-workspace-history-and-diff.test.tsx`, which
 * already mounts this component. A sibling PR edits that file, and putting this
 * there would create the merge conflict I had just verified my open PRs did not
 * have — four branches, zero shared files.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

import { act, render } from '@testing-library/react';
import type { RefObject } from 'react';

import { TldrawProcessWorkspace } from '@/components/processes/TldrawProcessWorkspace';
import { TenantProvider } from '@/lib/tenant-context-provider';
import type { CanvasCommandGroup } from '@/components/processes/CanvasCommandPalette';
import { shapeIdForNodeKey } from '@/components/processes/tldraw/process-node-shape';
import type { AutosaveStatus } from '@/lib/processes/use-canvas-autosave';

/** What the palette was handed, and the element its `/` shortcut scopes to. */
let groups: CanvasCommandGroup[] = [];
let hostRef: RefObject<HTMLElement | null> | undefined;

jest.mock('@/components/processes/CanvasCommandPalette', () => ({
    CanvasCommandPalette: (p: {
        groups: CanvasCommandGroup[];
        hostRef?: RefObject<HTMLElement | null>;
    }) => {
        groups = p.groups;
        hostRef = p.hostRef;
        return <div data-testid="palette-stub" />;
    },
}));

/**
 * A real editor, because the layout commands act on one.
 *
 * The other workspace suite stubs the map entirely. Here the point is the chain
 * reaching the store, so the map mounts the genuine canvas and hands its editor
 * up — the same `onEditorReady` the real host uses.
 */
import { TldrawProcessCanvas } from '@/components/processes/TldrawProcessCanvas';
import type { Editor } from 'tldraw';
import type { GraphRows } from '@/components/processes/tldraw/serializer';

const node = (k: string, x: number) => ({
    nodeKey: k, nodeType: 'processStep', label: k, subtitle: null,
    posX: x, posY: 0, parentNodeKey: null, dataJson: null,
});
const ROWS: GraphRows = {
    nodes: [node('a', 0), node('b', 10), node('c', 20)],
    edges: [
        { edgeKey: 'e1', sourceKey: 'a', targetKey: 'b', edgeKind: 'flow',
          labelOverride: null, dataJson: null, controls: [] },
        { edgeKey: 'e2', sourceKey: 'b', targetKey: 'c', edgeKind: 'flow',
          labelOverride: null, dataJson: null, controls: [] },
    ],
};

let liveEditor: Editor | undefined;
jest.mock('@/components/processes/TldrawProcessMap', () => {
    const { useEffect } = jest.requireActual<typeof import('react')>('react');
    return {
        TldrawProcessMap: ({
            onEditorReady,
            onStateChange,
        }: {
            onEditorReady?: (e: Editor) => void;
            onStateChange?: (s: { version: number | undefined; autosaveStatus: AutosaveStatus }) => void;
        }) => {
            useEffect(() => {
                onStateChange?.({ version: 1, autosaveStatus: 'idle' });
            }, [onStateChange]);
            return (
                <TldrawProcessCanvas
                    rows={ROWS}
                    onEditorReady={(e) => {
                        liveEditor = e;
                        onEditorReady?.(e);
                    }}
                />
            );
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
    nodeCount: 3, edgeCount: 2, canvasMode: 'DOCUMENT' as const,
}];

async function mount() {
    groups = [];
    hostRef = undefined;
    liveEditor = undefined;
    await act(async () => {
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
    });
}

const command = (id: string) =>
    groups.flatMap((g) => g.commands).find((c) => c.id === id);
const posOf = (nodeKey: string) => {
    const s = liveEditor!.getShape(shapeIdForNodeKey(nodeKey) as never) as
        | { x: number; y: number } | undefined;
    if (!s) throw new Error(`no shape for ${nodeKey}`);
    return { x: s.x, y: s.y };
};


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

describe('the palette is mounted and fed', () => {
    it('receives the four groups', async () => {
        await mount();
        expect(groups.map((g) => g.heading)).toHaveLength(4);
        expect(groups.flatMap((g) => g.commands).length).toBeGreaterThan(20);
    });

    it('gets a hostRef attached to a real element', async () => {
        // Its absence DISABLES the `/` shortcut rather than falling back to a
        // global binding, so a ref that never attaches loses the feature
        // silently — and `/` is scoped precisely because a global
        // single-character binding breaks WCAG 2.1.4.
        await mount();
        expect(hostRef).toBeDefined();
        expect(hostRef!.current).toBeInstanceOf(HTMLElement);
    });

    it('offers new-automation now that the host can perform it (#3116)', async () => {
        /*
            This asserted `new-automation` was UNDEFINED, because `handleNew`
            took no argument and hardcoded DOCUMENT. That was the cutover's one
            genuine capability loss, and it is wired now.

            `new-from-template` stays absent, and that is the teeth for this
            assertion rather than a leftover: the builder omits a command whose
            action is missing, so if it started offering everything
            unconditionally this line would catch it. `ProcessTemplateModal` is
            still not mounted here.
        */
        await mount();
        expect(command('new-automation')).toBeDefined();
        expect(command('new')).toBeDefined();
        expect(command('new-from-template')).toBeUndefined();
    });

    it('and selecting it POSTs an AUTOMATION map, not a document one', async () => {
        /*
            The end of the wire, through the real builder, the real host and the
            real handler. Asserted on the REQUEST BODY: the failure shape being
            guarded is a perfectly successful create carrying DOCUMENT, which no
            assertion on the result could distinguish from success.

            `fetch` is spied for this test only — the rest of this file never
            reaches the network, and a file-wide stub would hide that.
        */
        const calls: Array<{ url: string; body: unknown }> = [];
        const spy = jest
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
                calls.push({
                    url: String(url),
                    body: JSON.parse((init?.body as string | undefined) ?? '{}'),
                });
                return {
                    ok: true,
                    status: 201,
                    json: async () => ({
                        id: 'map-new',
                        name: 'Untitled workflow 2',
                        status: 'DRAFT',
                        version: 1,
                        canvasMode: 'AUTOMATION',
                    }),
                } as never;
            });
        try {
            await mount();
            await act(async () => {
                command('new-automation')!.onSelect();
            });
            const post = calls.find((c) => c.url.includes('/processes'));
            expect(post).toBeDefined();
            expect((post!.body as { canvasMode: string }).canvasMode).toBe('AUTOMATION');
            expect((post!.body as { name: string }).name).toMatch(/^Untitled workflow /);
        } finally {
            spy.mockRestore();
        }
    });
});

describe('a layout command reaches the store', () => {
    it('arrange-lr moves the nodes left to right', async () => {
        // THE assertion. Before this wiring the auto-layout host was reachable
        // from nothing — a module that worked and was connected to no one.
        await mount();
        expect(command('arrange-lr')?.disabled).toBe(false);

        await act(async () => {
            command('arrange-lr')!.onSelect();
        });

        expect(posOf('b').x).toBeGreaterThan(posOf('a').x);
        expect(posOf('c').x).toBeGreaterThan(posOf('b').x);
    });

    it('arrange-tb moves them top to bottom', async () => {
        await mount();
        await act(async () => {
            command('arrange-tb')!.onSelect();
        });
        expect(posOf('b').y).toBeGreaterThan(posOf('a').y);
        expect(posOf('c').y).toBeGreaterThan(posOf('b').y);
    });

    it('selection arranges are disabled with nothing selected', async () => {
        // The counts hook feeds this; a stale count would offer a command that
        // silently does nothing.
        await mount();
        expect(command('arrange-selection-lr')?.disabled).toBe(true);
    });

    it('and enabled once two nodes are selected', async () => {
        await mount();
        await act(async () => {
            liveEditor!.select(
                shapeIdForNodeKey('a') as never,
                shapeIdForNodeKey('b') as never,
            );
        });
        expect(command('arrange-selection-lr')?.disabled).toBe(false);
    });
});

describe('a selection command reaches the editor', () => {
    it('delete removes the selected node', async () => {
        await mount();
        await act(async () => {
            liveEditor!.select(shapeIdForNodeKey('c') as never);
        });
        expect(command('delete')?.disabled).toBe(false);
        await act(async () => {
            command('delete')!.onSelect();
        });
        expect(liveEditor!.getShape(shapeIdForNodeKey('c') as never)).toBeUndefined();
    });
});
