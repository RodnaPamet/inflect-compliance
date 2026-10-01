/**
 * @jest-environment jsdom
 *
 * A refused arrow tells the user WHY, in their own language.
 *
 * ── The gap this closes ──────────────────────────────────────────────
 *
 * `installArrowToEdgeConversion` refuses an arrow by calling `onRefuse` and
 * returning: the arrow is LEFT on the canvas as a plain tldraw arrow. So until
 * something was wired to `onEdgeRefused`, the user drew a connector, it quietly
 * stopped being an edge, and the only feedback was that it did not look like
 * one. The canvas side has existed since #3067; nothing listened.
 *
 * ── Why the assertions go through the real English catalogue ─────────
 *
 * The global `__mocks__/next-intl.js` resolves keys against the REAL
 * `messages/en.json`. So asserting on visible English text proves two things
 * at once that a key-shaped assertion would not: the key EXISTS in the
 * catalogue, and the component asked for the right one. A missing key renders
 * `undefined`, which is exactly the bug a `toBeDefined()` on a lookup table
 * would miss.
 *
 * Two of the five keys are NEW here, because the tldraw validator refuses more
 * than xyflow's `isValidConnection` did — groups and unknown node keys on top
 * of self, duplicate and annotation.
 */
import { act, render, waitFor } from '@testing-library/react';

import en from '../../messages/en.json';
import { TldrawProcessMap } from '@/components/processes/TldrawProcessMap';
import type { EdgeRefusal } from '@/components/processes/tldraw/edge-validation';

/**
 * The catalogue entry, read rather than retyped.
 *
 * Substring assertions were not enough here and the reason is worth keeping:
 * `describeRefusal`'s own English for a group is "A group is a container, not
 * a step — connect a node inside it instead", and the catalogue's is "…connect
 * something inside it". Both contain "container", so a mutation that swapped
 * the localised lookup for `describeRefusal` left a `toContain('container')`
 * assertion GREEN — blind to the exact substitution this file exists to pin.
 */
const CANVAS = (en as { automation: { canvas: Record<string, string> } }).automation
    .canvas;

/** Every `onEdgeRefused` the container handed the canvas. */
let refusedHandler: ((r: EdgeRefusal[]) => void) | undefined;
/** Whether the prop was passed AT ALL — the wiring, not the behaviour. */
let canvasSawTheProp = false;

jest.mock('@/lib/processes/use-tldraw-canvas-autosave', () => ({
    useTldrawCanvasAutosave: () => ({
        markDirty: jest.fn(),
        markClean: jest.fn(),
        status: 'idle',
        lastSavedAt: null,
    }),
}));

jest.mock('@/components/processes/TldrawProcessCanvas', () => ({
    TldrawProcessCanvas: (props: { onEdgeRefused?: (r: EdgeRefusal[]) => void }) => {
        canvasSawTheProp = 'onEdgeRefused' in props && props.onEdgeRefused !== undefined;
        refusedHandler = props.onEdgeRefused;
        return <div data-testid="canvas-stub" />;
    },
}));

const warning = jest.fn();
const error = jest.fn();
jest.mock('@/components/ui/hooks', () => ({
    useToast: () => ({
        warning: (...a: unknown[]) => warning(...a),
        error: (...a: unknown[]) => error(...a),
        success: jest.fn(),
        info: jest.fn(),
        dismiss: jest.fn(),
    }),
}));

/** The map as the ROUTE returns it: the payload itself, not an envelope. */
const MAP = {
    id: 'map-1',
    version: 3,
    nodes: [
        {
            nodeKey: 'n1',
            nodeType: 'processStep',
            label: 'Receive invoice',
            subtitle: null,
            posX: 10,
            posY: 20,
            parentNodeKey: null,
            dataJson: null,
        },
    ],
    edges: [],
};

function fetchOk() {
    return jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => MAP,
    })) as unknown as typeof fetch;
}

async function mountMap() {
    refusedHandler = undefined;
    canvasSawTheProp = false;
    warning.mockClear();
    error.mockClear();
    await act(async () => {
        render(
            <TldrawProcessMap tenantSlug="acme" mapId="map-1" fetchImpl={fetchOk()} />,
        );
    });
    await waitFor(() => expect(refusedHandler).toBeDefined());
    return refusedHandler!;
}

describe('the container wires the refusal channel at all', () => {
    it('passes onEdgeRefused down to the canvas', async () => {
        // THE assertion that was missing. The canvas has had the prop since
        // #3067 and nothing supplied it, so every refusal went nowhere.
        await mountMap();
        expect(canvasSawTheProp).toBe(true);
    });
});

describe('a refused edge is explained', () => {
    it('a self-loop says a step cannot connect to itself', async () => {
        const refuse = await mountMap();
        act(() => refuse([{ code: 'SELF_LOOP', nodeKey: 'n1' }] as EdgeRefusal[]));
        expect(warning).toHaveBeenCalledTimes(1);
        expect(warning.mock.calls[0]![0]).toBe(CANVAS.rejectSelf);
    });

    it('a group says to connect something inside it — a NEW key', async () => {
        // xyflow never refused groups, so this key did not exist. If it is
        // missing from en.json the mock resolves it to undefined and this
        // fails on the text rather than passing on a truthy object.
        const refuse = await mountMap();
        act(() =>
            refuse([
                { code: 'NODE_IS_GROUP', nodeKey: 'g1', nodeType: 'group' },
            ] as EdgeRefusal[]),
        );
        expect(warning.mock.calls[0]![0]).toBe(CANVAS.rejectGroup);
    });

    it('an unknown node key is explained too — the other NEW key', async () => {
        const refuse = await mountMap();
        act(() =>
            refuse([{ code: 'UNKNOWN_NODE_KEY', nodeKey: 'gone' }] as EdgeRefusal[]),
        );
        expect(warning.mock.calls[0]![0]).toBe(CANVAS.rejectUnknownNode);
    });

    it('every refusal code resolves to real text, never "undefined"', async () => {
        // The total-map teeth. `Record<EdgeRefusal['code'], string>` makes a
        // missing arm a type error, but a missing CATALOGUE key is not — it
        // renders the string "undefined" into a toast.
        const refuse = await mountMap();
        const all: EdgeRefusal[] = [
            { code: 'SELF_LOOP', nodeKey: 'n1' },
            { code: 'DUPLICATE_EDGE', sourceKey: 'n1', targetKey: 'n2' },
            { code: 'NODE_IS_ANNOTATION', nodeKey: 'a1', nodeType: 'annotation' },
            { code: 'NODE_IS_GROUP', nodeKey: 'g1', nodeType: 'group' },
            { code: 'UNKNOWN_NODE_KEY', nodeKey: 'gone' },
        ] as EdgeRefusal[];
        for (const r of all) {
            warning.mockClear();
            act(() => refuse([r]));
            const text = String(warning.mock.calls[0]![0]);
            expect(text).not.toContain('undefined');
            expect(text.length).toBeGreaterThan(10);
        }
    });
});

describe('the shape of the feedback matches the canvas it replaces', () => {
    it('is a WARNING, not an error — a refusal is the product working', async () => {
        const refuse = await mountMap();
        act(() => refuse([{ code: 'SELF_LOOP', nodeKey: 'n1' }] as EdgeRefusal[]));
        expect(warning).toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    });

    it('carries ONE shared id, so a run of misclicks is one toast', async () => {
        // The xyflow canvas collapses rapid-fire rejections onto a single id.
        // Without it a user who misclicks four times gets four stacked toasts.
        const refuse = await mountMap();
        act(() => refuse([{ code: 'SELF_LOOP', nodeKey: 'n1' }] as EdgeRefusal[]));
        act(() => refuse([{ code: 'SELF_LOOP', nodeKey: 'n1' }] as EdgeRefusal[]));
        const ids = warning.mock.calls.map(
            (c) => (c[1] as { id?: string } | undefined)?.id,
        );
        expect(ids).toEqual(['canvas-connection-rejected', 'canvas-connection-rejected']);
    });
});

describe('more than one reason, and none at all', () => {
    it('reports BOTH reasons rather than only the first', async () => {
        // `validateEdge` pushes a refusal per failing rule. Showing only
        // the first makes the user fix one thing and be told about the next.
        const refuse = await mountMap();
        act(() =>
            refuse([
                { code: 'DUPLICATE_EDGE', sourceKey: 'n1', targetKey: 'n2' },
                { code: 'NODE_IS_ANNOTATION', nodeKey: 'a1', nodeType: 'annotation' },
            ] as EdgeRefusal[]),
        );
        expect(warning.mock.calls[0]![0]).toBe(
            `${CANVAS.rejectDuplicate} ${CANVAS.rejectAnnotation}`,
        );
    });

    it('collapses two refusals of the SAME code into one sentence', async () => {
        // Both ends being annotations is two refusals, one fact.
        const refuse = await mountMap();
        act(() =>
            refuse([
                { code: 'NODE_IS_ANNOTATION', nodeKey: 'a1', nodeType: 'annotation' },
                { code: 'NODE_IS_ANNOTATION', nodeKey: 'a2', nodeType: 'annotation' },
            ] as EdgeRefusal[]),
        );
        expect(warning.mock.calls[0]![0]).toBe(CANVAS.rejectAnnotation);
    });

    it('an EMPTY refusal list toasts nothing', async () => {
        // Teeth for the early return: without it an accepted edge whose
        // handler fired with [] would raise an empty toast.
        const refuse = await mountMap();
        act(() => refuse([]));
        expect(warning).not.toHaveBeenCalled();
    });
});
