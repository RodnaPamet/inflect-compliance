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

    it('the execution OVERLAY is REACHED, from the workspace and the node (#3115)', () => {
        /*
            This asserted the absence, with "TO NEED THIS AGAIN: the first
            AUTOMATION map" as the trigger that would fail it deliberately. What
            actually fired it was an owner decision rather than a row appearing —
            the same reversal as VR-5's, recorded the same way.

            `canvas-execution-overlay.tsx` was referenced by nothing but itself;
            it now has both of its intended consumers. The sibling guard
            `vr6-execution-overlay` asserts the detail — the gating, the narrowed
            id, and the never-poll-per-node constraint. This one only asserts
            reachability, which is this file's whole subject.
        */
        expect(read(WORKSPACE)).toMatch(/<CanvasOverlayProvider/);
        /*
            The CALL, not the bare name. `useNodeOverlayStatus` appears twice in
            that file once comments are masked — the import and the call — and an
            import with no call is precisely the state this assertion exists to
            reject. The Class D needle ratchet caught the first version of this
            line for that reason, at +1 over its ceiling.
        */
        expect(read('src/components/processes/tldraw/ProcessNodeShapeUtil.tsx')).toMatch(
            /useNodeOverlayStatus\(/,
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

    it('AUTOMATION mode is CONVERTIBLE, though no longer creatable in one step', () => {
        /*
            A genuine reduction, stated rather than papered over.

            The xyflow canvas offered `handleNew("AUTOMATION")` — create a map
            already in automation mode. The tldraw workspace declines to wire
            `newAutomation` (its own comment at the command-group call site says
            so), so the route is now: create a map, then switch its mode.

            The capability is reachable, in two steps instead of one. The
            command BUILDER still supports the action and its label still
            resolves, so wiring it back is one prop — which is why this asserts
            the builder keeps the arm rather than asserting the gap.
        */
        const commands = read(COMMANDS);
        expect(commands).toMatch(/newAutomation\?:\s*\(\)\s*=>\s*void/);
        expect(commands).toMatch(/t\('cmdNewAutomationLabel'\)/);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const en = require('../../messages/en.json');
        expect(en.automation.canvas.cmdNewAutomationLabel).toBe(
            'New automation workflow',
        );
        // And the two-step route exists: the mode switch goes both ways.
        expect(read('src/lib/processes/use-tldraw-document-bar.ts')).toMatch(
            /'AUTOMATION'\s*\?\s*'DOCUMENT'\s*:\s*'AUTOMATION'/,
        );
    });

    it('exposes a Run Mode toggle in the document bar', () => {
        const src = read(DOCBAR);
        expect(src).toMatch(/useRunMode/);
        expect(src).toMatch(/run-mode-toggle/);
    });
});
