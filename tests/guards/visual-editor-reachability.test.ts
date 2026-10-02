/**
 * Visual editor reachability ratchet (PR-B).
 *
 * The VR roadmap shipped three pieces of dead code + an unreachable feature.
 * This ratchet keeps them WIRED so they can't silently revert to inert:
 *   - the live-execution overlay provider + run-mode provider are MOUNTED;
 *   - the edge-kind inference is CALLED on connect (not dead);
 *   - AUTOMATION canvas mode is CREATABLE from the UI;
 *   - a Run Mode toggle exists.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// Every path this file READS is a TypeScript-alike: the `.json` it touches
// arrives through `require()`, which is a module import, not a text read — so
// it never reaches this seam and needs no separate reader.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));

/*
    ═══ WHAT THE CUTOVER DID TO THIS FILE (#3079) ═══

    This guard exists BECAUSE VR-5 and VR-6 were dead code once already — its
    own test names say so. So when the xyflow canvas was deleted and three of
    these four assertions lost their subject, deleting them was the one move
    this file is designed to prevent: replacing a reachability claim with
    silence is exactly how the thing it guards recurs.

    Each is therefore rewritten to say what IS true, and to record the number
    that makes it tolerable. Read against production at the cutover:

        ProcessMap rows ................ 1
        maps in AUTOMATION mode ........ 0
        ProcessEdge rows ............... 3

    Nothing below is an argument that the capability does not matter. It is the
    evidence that nothing is currently relying on it, plus what would have to
    become true before the absence does matter.
*/
const WORKSPACE = 'src/components/processes/TldrawProcessWorkspace.tsx';
const DOCBAR = 'src/components/processes/CanvasDocumentBar.tsx';
const COMMANDS = 'src/lib/processes/canvas-command-groups.ts';

describe('visual editor reachability', () => {
    it('mounts the run-mode provider (VR-6 half that DID port)', () => {
        // Re-pointed, not retired: the provider moved hosts intact.
        expect(read(WORKSPACE)).toMatch(/<RunModeProvider>/);
    });

    it('the execution OVERLAY is unported, and nothing pretends otherwise', () => {
        /*
            `CanvasOverlayProvider` and `useNodeOverlayStatus` live in
            `lib/processes/canvas-execution-overlay.tsx`, which after the
            cutover is referenced by nothing but itself, and the tldraw node
            util does not paint an overlay.

            Asserted as an absence rather than deleted so the state is on the
            record. The overlay shows per-node RUN state, which needs an
            AUTOMATION map to run; there are none. Porting it would be building
            a renderer for zero rows.

            TO NEED THIS AGAIN: the first AUTOMATION map. At that point this
            assertion fails — deliberately — and the port is the fix.
        */
        expect(read(WORKSPACE)).not.toMatch(/<CanvasOverlayProvider/);
        expect(read('src/components/processes/tldraw/ProcessNodeShapeUtil.tsx')).not.toMatch(
            /useNodeOverlayStatus/,
        );
    });

    it('inferEdgeKind is REACHED again, from the live-draw site (#3093)', () => {
        /*
            This assertion was "has no consumer, and that is recorded not
            hidden" — true from the cutover until VR-5 was ported. The note it
            carried is worth keeping in one line: the module was KEPT rather
            than deleted, the `GraphExplorer` treatment, because re-deriving it
            was worse than leaving it unreferenced. That bet paid out.

            `arrow-to-edge.ts` is the tldraw equivalent of the xyflow canvas's
            `onConnect`, which is where the call used to be. The WORKSPACE does
            not call it and should not: inference belongs with the gesture that
            creates an edge, not with the component that hosts the canvas.
        */
        expect(read('src/components/processes/tldraw/arrow-to-edge.ts')).toMatch(
            /inferEdgeKind\(/,
        );
        expect(read(WORKSPACE)).not.toMatch(/inferEdgeKind\(/);
    });

    it('AUTOMATION mode is creatable in ONE step again, and still convertible (#3116)', () => {
        /*
            ═══ THE ONE GENUINE REDUCTION, NOW CLOSED ═══

            This read "no longer creatable in one step", and it was the only
            honest capability LOSS in the whole cutover — the other three gaps
            were retirements with production counts behind them. The xyflow
            canvas offered `handleNew("AUTOMATION")`; the tldraw workspace
            declined to wire `newAutomation`, so the route became create-then-
            convert.

            It is wired now. The command BUILDER always supported the action and
            its label always resolved — this was one prop, exactly as the old
            text predicted.

            ═══ WHAT THE SCOPE TURNED OUT TO BE ═══

            Worth recording, because I filed the issue claiming the create
            endpoint ignored `canvasMode` and that a UI-only change would ship a
            200 carrying the wrong mode. That was wrong: `CreateProcessMapSchema`
            has accepted the field since VR-2, the usecase forwards it and the
            repository defaults it. I had grepped the 38-line route FILE, found
            nothing, and concluded about the route's PATH.
        */
        const commands = read(COMMANDS);
        const bar = read('src/lib/processes/use-tldraw-document-bar.ts');
        const workspace = read(WORKSPACE);

        // The builder's arm, and the label it resolves.
        expect(commands).toMatch(/newAutomation\?:\s*\(\)\s*=>\s*void/);
        expect(commands).toMatch(/t\('cmdNewAutomationLabel'\)/);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const en = require('../../messages/en.json');
        expect(en.automation.canvas.cmdNewAutomationLabel).toBe('New automation workflow');

        // The HOST supplies it — the half that was missing.
        expect(workspace).toMatch(/newAutomation:\s*\(\)\s*=>\s*void bar\.handlers\.handleNew\('AUTOMATION'\)/);

        /*
            And the argument is NORMALISED. `CanvasDocumentBar` renders
            `onClick={handleNew}`, so React passes a SyntheticEvent as the first
            argument — an un-normalised read would put an event object in the
            request body, where the schema's enum rejects it, and the bar's own
            New button would 400 while the palette worked. Asserted here because
            the hazard is created by giving this function a parameter at all.
        */
        expect(bar).toMatch(/canvasMode === 'AUTOMATION' \? 'AUTOMATION' : 'DOCUMENT'/);

        // The two-step route survives: the mode switch still goes both ways.
        expect(bar).toMatch(/'AUTOMATION'\s*\?\s*'DOCUMENT'\s*:\s*'AUTOMATION'/);
    });

    it('exposes a Run Mode toggle in the document bar', () => {
        const src = read(DOCBAR);
        expect(src).toMatch(/useRunMode/);
        expect(src).toMatch(/run-mode-toggle/);
    });
});
