/**
 * @jest-environment jsdom
 *
 * `TldrawCanvasExportMenu` — which items appear, and what each one calls.
 *
 * ── Scope ────────────────────────────────────────────────────────────
 *
 * The export helpers are stubbed. Their mechanics have their own unit tests
 * (29 of them, covering the background injection, the composite seam, the
 * routes and the empty-canvas refusals) and running the real ones here would
 * drag `toImage` into jsdom, which has no canvas.
 *
 * What only this component can be wrong about is the MENU: which items render
 * under which conditions, and which helper each dispatches to with what. The
 * gating is the interesting half — an item that renders without the ids its
 * action needs is a route call that cannot succeed.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TldrawCanvasExportMenu } from '@/components/processes/TldrawCanvasExportMenu';

/**
 * Parameters TYPED, all five. `jest.fn(async () => …)` declares ZERO
 * parameters, so calling it with the options object is
 * `TS2554: Expected 0 arguments, but got 1` — and under ts-jest that fails at
 * transform time, so the suite reports 0 tests rather than a red assertion.
 * Third occurrence of this shape in one session; the tell is a mock that is
 * declared with no args and then invoked with one.
 */
type Opts = Record<string, unknown>;
const exportTldrawCanvasAsPng = jest.fn(async (_o: Opts) => 'data:image/png;base64,STUB');
const exportTldrawCanvasAsSvg = jest.fn(async (_o: Opts) => 'data:image/svg+xml,STUB');
const copyTldrawCanvasToClipboard = jest.fn(async (_o: Opts): Promise<void> => undefined);
const exportTldrawCanvasAsPdf = jest.fn(async (_o: Opts): Promise<void> => undefined);
const attachTldrawCanvasToEvidence = jest.fn(async (_o: Opts) => ({ evidenceId: 'ev_1' }));

jest.mock('@/lib/processes/tldraw-canvas-export', () => ({
    exportTldrawCanvasAsPng: (o: Opts) => exportTldrawCanvasAsPng(o),
    exportTldrawCanvasAsSvg: (o: Opts) => exportTldrawCanvasAsSvg(o),
    copyTldrawCanvasToClipboard: (o: Opts) => copyTldrawCanvasToClipboard(o),
    exportTldrawCanvasAsPdf: (o: Opts) => exportTldrawCanvasAsPdf(o),
    attachTldrawCanvasToEvidence: (o: Opts) => attachTldrawCanvasToEvidence(o),
}));

/**
 * Feature detection, flipped per test. Its own logic is unit-tested.
 *
 * Mocks `canvas-export-shared`, which is where the function now lives — this
 * menu no longer imports anything from the xyflow `canvas-export` module. The
 * `requireActual` spread matters here: `canvas-export-shared` also exports
 * `safeFilename`, `resolveBackground` and the padding/background constants, and
 * replacing it wholesale would hand `undefined` to anything reaching for those.
 */
const canCopy = jest.fn(() => false);
jest.mock('@/lib/processes/canvas-export-shared', () => ({
    ...jest.requireActual('@/lib/processes/canvas-export-shared'),
    canCopyImageToClipboard: () => canCopy(),
}));

const toastError = jest.fn();
const toastSuccess = jest.fn();
/**
 * `requireActual` spread, NOT a bare replacement.
 *
 * Mocking the barrel wholesale left `Popover` without `useMediaQuery` and every
 * test failed with `(0 , hooks_1.useMediaQuery) is not a function` — the
 * partial-barrel trap. Only `useToast` is intercepted, because only the toasts
 * are being asserted; every other hook the UI primitives reach for stays real.
 */
jest.mock('@/components/ui/hooks', () => ({
    ...jest.requireActual('@/components/ui/hooks'),
    useToast: () => ({ error: toastError, success: toastSuccess, info: jest.fn() }),
}));

/** Stands in for an Editor; the menu only passes it through. */
const EDITOR = { id: 'editor-1' } as never;

beforeEach(() => {
    jest.clearAllMocks();
    canCopy.mockReturnValue(false);
});

async function open() {
    await userEvent.click(screen.getByTestId('tldraw-export-trigger'));
}

describe('the trigger', () => {
    it('mounts and reads as an export control', () => {
        render(<TldrawCanvasExportMenu editor={EDITOR} mapName="Sample map" />);
        const trigger = screen.getByTestId('tldraw-export-trigger');
        expect(trigger).toBeInTheDocument();
        expect(trigger).toHaveTextContent(/export/i);
        expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    });

    it('is disabled with no editor — the unmounted / empty state', () => {
        render(<TldrawCanvasExportMenu editor={null} mapName="Sample map" />);
        expect(screen.getByTestId('tldraw-export-trigger')).toBeDisabled();
    });

    it('and is disabled by the external signal', () => {
        render(<TldrawCanvasExportMenu editor={EDITOR} mapName="m" disabled />);
        expect(screen.getByTestId('tldraw-export-trigger')).toBeDisabled();
    });

    it('is ENABLED with an editor and no disable signal — teeth for both above', () => {
        render(<TldrawCanvasExportMenu editor={EDITOR} mapName="m" />);
        expect(screen.getByTestId('tldraw-export-trigger')).toBeEnabled();
    });
});

describe('which items render', () => {
    it('PNG and SVG always', async () => {
        render(<TldrawCanvasExportMenu editor={EDITOR} mapName="m" />);
        await open();
        expect(screen.getByTestId('tldraw-export-png')).toBeInTheDocument();
        expect(screen.getByTestId('tldraw-export-svg')).toBeInTheDocument();
    });

    it('clipboard ONLY when the browser supports it', async () => {
        render(<TldrawCanvasExportMenu editor={EDITOR} mapName="m" />);
        await open();
        expect(screen.queryByTestId('tldraw-export-clipboard')).not.toBeInTheDocument();
    });

    it('and clipboard DOES render when it does — teeth for the above', async () => {
        canCopy.mockReturnValue(true);
        render(<TldrawCanvasExportMenu editor={EDITOR} mapName="m" />);
        await open();
        expect(screen.getByTestId('tldraw-export-clipboard')).toBeInTheDocument();
    });

    it('PDF and Evidence are HIDDEN without tenantSlug + mapId', async () => {
        // THE gating assertion. Both call routes keyed on those ids, so an
        // item rendered without them is a call that cannot succeed — the
        // component would have to throw at click time instead.
        render(<TldrawCanvasExportMenu editor={EDITOR} mapName="m" />);
        await open();
        expect(screen.queryByTestId('tldraw-export-pdf')).not.toBeInTheDocument();
        expect(screen.queryByTestId('tldraw-export-evidence')).not.toBeInTheDocument();
    });

    it('and appear once both are supplied', async () => {
        render(
            <TldrawCanvasExportMenu
                editor={EDITOR}
                mapName="m"
                tenantSlug="acme"
                mapId="map-1"
            />,
        );
        await open();
        expect(screen.getByTestId('tldraw-export-pdf')).toBeInTheDocument();
        expect(screen.getByTestId('tldraw-export-evidence')).toBeInTheDocument();
    });

    it('stay hidden with only ONE of the two', async () => {
        // Half the pair is the case a `||` instead of `&&` would let through.
        render(<TldrawCanvasExportMenu editor={EDITOR} mapName="m" tenantSlug="acme" />);
        await open();
        expect(screen.queryByTestId('tldraw-export-pdf')).not.toBeInTheDocument();
    });
});

describe('what each item calls', () => {
    it('PNG → exportTldrawCanvasAsPng with the editor and name', async () => {
        render(<TldrawCanvasExportMenu editor={EDITOR} mapName="Invoice approval" />);
        await open();
        await userEvent.click(screen.getByTestId('tldraw-export-png'));
        expect(exportTldrawCanvasAsPng).toHaveBeenCalledWith(
            expect.objectContaining({ editor: EDITOR, mapName: 'Invoice approval' }),
        );
        expect(exportTldrawCanvasAsSvg).not.toHaveBeenCalled();
    });

    it('SVG → exportTldrawCanvasAsSvg', async () => {
        render(<TldrawCanvasExportMenu editor={EDITOR} mapName="m" />);
        await open();
        await userEvent.click(screen.getByTestId('tldraw-export-svg'));
        expect(exportTldrawCanvasAsSvg).toHaveBeenCalledTimes(1);
        expect(exportTldrawCanvasAsPng).not.toHaveBeenCalled();
    });

    it('clipboard → copies AND confirms, because nothing else shows it worked', async () => {
        // A download is self-evident; a clipboard write is invisible without
        // the toast.
        canCopy.mockReturnValue(true);
        render(<TldrawCanvasExportMenu editor={EDITOR} mapName="m" />);
        await open();
        await userEvent.click(screen.getByTestId('tldraw-export-clipboard'));
        expect(copyTldrawCanvasToClipboard).toHaveBeenCalledTimes(1);
        expect(toastSuccess).toHaveBeenCalled();
    });

    it('PDF → passes the ids through to the route helper', async () => {
        render(
            <TldrawCanvasExportMenu
                editor={EDITOR}
                mapName="m"
                tenantSlug="acme"
                mapId="map-1"
            />,
        );
        await open();
        await userEvent.click(screen.getByTestId('tldraw-export-pdf'));
        expect(exportTldrawCanvasAsPdf).toHaveBeenCalledWith(
            expect.objectContaining({ tenantSlug: 'acme', mapId: 'map-1' }),
        );
    });

    it('Evidence → attaches AND confirms', async () => {
        render(
            <TldrawCanvasExportMenu
                editor={EDITOR}
                mapName="m"
                tenantSlug="acme"
                mapId="map-1"
            />,
        );
        await open();
        await userEvent.click(screen.getByTestId('tldraw-export-evidence'));
        expect(attachTldrawCanvasToEvidence).toHaveBeenCalledWith(
            expect.objectContaining({ tenantSlug: 'acme', mapId: 'map-1' }),
        );
        expect(toastSuccess).toHaveBeenCalled();
    });
});

describe('failures reach the user', () => {
    it("shows the helper's OWN message, not a generic one", async () => {
        // The empty-canvas refusal arrives this way and its message is already
        // human-readable — replacing it with "Export failed" would discard the
        // only thing that tells the user what to do.
        exportTldrawCanvasAsPng.mockRejectedValueOnce(
            new Error('There is nothing on this canvas to export.'),
        );
        render(<TldrawCanvasExportMenu editor={EDITOR} mapName="m" />);
        await open();
        await userEvent.click(screen.getByTestId('tldraw-export-png'));
        expect(toastError).toHaveBeenCalledWith('There is nothing on this canvas to export.');
        expect(toastSuccess).not.toHaveBeenCalled();
    });

    it('and falls back for a non-Error throw', async () => {
        exportTldrawCanvasAsSvg.mockRejectedValueOnce('a string, somehow');
        render(<TldrawCanvasExportMenu editor={EDITOR} mapName="m" />);
        await open();
        await userEvent.click(screen.getByTestId('tldraw-export-svg'));
        expect(toastError).toHaveBeenCalledTimes(1);
    });

    it('does not call anything at all without an editor', async () => {
        render(<TldrawCanvasExportMenu editor={null} mapName="m" />);
        // The trigger is disabled, so the menu cannot be opened — asserted via
        // the helpers never being reached rather than via the DOM alone.
        expect(exportTldrawCanvasAsPng).not.toHaveBeenCalled();
        expect(screen.getByTestId('tldraw-export-trigger')).toBeDisabled();
    });
});
