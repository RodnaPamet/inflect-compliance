/**
 * @jest-environment jsdom
 *
 * The workspace mounts a REAL canvas, with nothing stubbed in between.
 *
 * ═══ WHY THIS EXISTS (#3079) ═══
 *
 * Every other suite on this surface mocks the layer below it: the client test
 * stubs the workspace, the workspace test stubs the map, the map test stubs the
 * canvas. Each is right on its own and together they leave one question
 * unasked — whether the chain actually connects.
 *
 * That is not a hypothetical. `visual-editor-reachability` exists because two
 * features on this surface were DEAD CODE while their own unit tests passed,
 * and `p5a-snapshots-table-sidebar` exists because "the pre-fix P5-PR-A shipped
 * the component but never mounted it". The recurring defect here is not a broken
 * component; it is a component nothing reaches.
 *
 * The cutover is exactly when that matters. Deleting the renderer-selecting flag
 * means `ProcessesClient` now has one path to one canvas, and if that path is
 * wrong the page renders an empty frame for every tenant on the next deploy.
 *
 * ═══ WHAT IS MOCKED, AND WHY ONLY THAT ═══
 *
 * The router and `fetch`. Both are environment rather than chain: there is no
 * Next router in jsdom and no server to answer. Everything from
 * `TldrawProcessWorkspace` down to the tldraw editor is real — the workspace
 * mounts the real container, which fetches and mounts the real canvas, which
 * mounts a real editor. No stub anywhere in that span.
 *
 * ═══ RENDERED OUTSIDE `act`, AND THAT IS THE WHOLE TRICK ═══
 *
 * Every other suite here wraps its render in `await act(async () => …)`. That
 * cannot work for this arrangement and the reason is worth recording, because
 * the symptom is a timeout with no error and it cost two wrong diagnoses.
 *
 * An async `act` waits for React's scheduler to DRAIN. With the workspace's
 * autosave debounce, the history sidebar's polling and tldraw's own render loop
 * all live at once, it never does — measured at 120 SECONDS with an empty map,
 * which is not slowness, it is a queue that never empties. My first two
 * explanations (`next/dynamic` never resolving, then the real map's fetches)
 * were both wrong; the diagnostic that settled it printed the DOM after a plain
 * `render` and found a fully-mounted editor in six seconds.
 *
 * So: plain `render`, then poll. There is no act warning to suppress because
 * nothing here dispatches an event — the assertions are reads.
 *
 * ═══ WHERE THIS STOPS ═══
 *
 * It starts at the WORKSPACE, not at `ProcessesClient`. That hop goes through
 * `next/dynamic` with `ssr: false`, and is covered two other ways on purpose:
 * `processes-client-picks-the-canvas` asserts the module it imports and that no
 * deleted component is named in its graph, and the E2E suite loads the real page
 * in a browser where the chunk actually loads.
 *
 * Everything BELOW that hop — the span no other suite mounts unstubbed — is
 * here. It is the slowest suite on the surface; that is the price of the only
 * assertion none of the fast ones can make.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

import { render, waitFor } from '@testing-library/react';

import { TldrawProcessWorkspace } from '@/components/processes/TldrawProcessWorkspace';
import { TenantProvider } from '@/lib/tenant-context-provider';

jest.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({
        push: jest.fn(), replace: jest.fn(), refresh: jest.fn(),
        back: jest.fn(), forward: jest.fn(), prefetch: jest.fn(),
    }),
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/processes',
}));

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
    before.

    Worth noting for THIS file in particular: the throw happened at mount, so the
    failure here was the canvas never appearing — which this file's own header
    warns reads identically to the `act`-never-draining problem it was written
    for. The cause was in the error output, not in the timing.
*/
const TENANT_CTX = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    tenantName: 'Acme',
    role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
} as never;

const MOUNT_BUDGET_MS = 120_000;

const PROCESSES = [{
    id: 'map-1', name: 'Invoice approval', description: null,
    status: 'DRAFT' as const, version: 3,
    createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
    nodeCount: 2, edgeCount: 1, canvasMode: 'DOCUMENT' as const,
}];

/** The map as the route returns it — the payload itself, not an envelope. */
const MAP = {
    id: 'map-1',
    version: 3,
    nodes: [
        {
            nodeKey: 'n1', nodeType: 'processStep', label: 'Receive',
            subtitle: null, posX: 0, posY: 0, parentNodeKey: null, dataJson: null,
        },
        {
            nodeKey: 'n2', nodeType: 'processStep', label: 'Approve',
            subtitle: null, posX: 360, posY: 180, parentNodeKey: null, dataJson: null,
        },
    ],
    edges: [
        {
            edgeKey: 'e1', sourceKey: 'n1', targetKey: 'n2',
            edgeKind: 'flow', labelOverride: null,
        },
    ],
};

/**
 * Plain `render`, then poll — see the header on why `act` cannot be used here.
 * Returns the container so the assertions read the tree this mounted rather
 * than `document`, which testing-library's automatic cleanup empties.
 */
async function mountPage(): Promise<HTMLElement> {
    const { container } = render(
        <div style={{ width: 1000, height: 700 }}>
            <TenantProvider value={TENANT_CTX}>
                <TldrawProcessWorkspace
                    tenantSlug="acme"
                    processes={PROCESSES}
                    activeId="map-1"
                    onActiveIdChange={() => {}}
                    onProcessesChange={() => {}}
                />
            </TenantProvider>
        </div>,
    );
    await waitFor(
        () => expect(container.querySelector('.tl-container')).not.toBeNull(),
        { timeout: 60000, interval: 250 },
    );
    return container;
}

let container: HTMLElement;

beforeAll(async () => {
    // Answers every GET with the map. That includes two it is not strictly
    // for — the history sidebar's `/snapshots` poll, and tldraw's own
    // `cdn.tldraw.com/.../translations/en.json` — both harmless here, and both
    // of which a narrower mock would turn into unhandled rejections that
    // surface as this suite timing out for the wrong reason.
    global.fetch = jest.fn(async () => ({
        ok: true, status: 200, json: async () => MAP,
    })) as unknown as typeof fetch;
    container = await mountPage();
}, MOUNT_BUDGET_MS);

/**
 * ONE test, deliberately.
 *
 * The mount costs ~40s and these are four independent READS of it. Split across
 * four `it`s they cost four mounts — and worse, `@testing-library/react`'s
 * automatic `cleanup` runs after EVERY test, so a shared `beforeAll` mount is
 * torn down before the second one reads it. That is not a hypothetical: the
 * first version of this file passed its first assertion and failed the other
 * three against an empty document, which reads exactly like a broken chain.
 *
 * The cost of one test is that the first failure hides the rest. Worth it
 * against a 40-second arrangement, and the assertions are ordered from the
 * outside in so the first failure is the most diagnostic one.
 */
it('the workspace mounts a live editor showing the map, with its chrome', async () => {
    // 1. OUR host wrapper is present — the canvas component rendered at all.
    expect(container.querySelector('[data-tldraw-process-canvas="true"]')).not.toBeNull();

    // 2. And TLDRAW mounted inside it. The wrapper renders before the editor
    //    exists, so (1) alone would pass against a canvas that never
    //    initialised — which is the shape the `.tl-loading` check rules out.
    expect(container.querySelector('.tl-container')).not.toBeNull();
    expect(container.querySelector('.tl-loading')).toBeNull();

    // 3. The map's ROWS became shapes: two nodes came off `fetch`, through the
    //    container's row mapping, into the store, and out as rendered shapes.
    //    A chain that connected but dropped its payload would satisfy 1 and 2.
    await waitFor(
        () => expect(container.querySelectorAll('[data-node-type]').length).toBeGreaterThanOrEqual(2),
        { timeout: 30000, interval: 250 },
    );

    // 4. The workspace's own chrome came with it. A workspace that rendered
    //    only the canvas would satisfy everything above and silently lose the
    //    palette, the document bar and the inspector — which is the exact
    //    defect class `visual-editor-reachability` exists for.
    expect(container.querySelector('[data-process-palette]')).not.toBeNull();
    expect(container.querySelector('[data-testid="canvas-undo-btn"]')).not.toBeNull();
}, MOUNT_BUDGET_MS);
