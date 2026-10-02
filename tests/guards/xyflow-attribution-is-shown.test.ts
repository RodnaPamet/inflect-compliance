/**
 * The React Flow attribution stays visible until somebody can point at a licence.
 *
 * ═══ WHY THIS IS A GUARD AND NOT A CODE REVIEW NOTE ═══
 *
 * `proOptions={{ hideAttribution: true }}` is one line, it makes the canvas
 * look tidier, and nothing about adding it looks like a licensing decision. It
 * had already been added in FOUR places — the process canvas twice, the
 * bow-tie risk canvas and the traceability graph explorer — with no note
 * anywhere saying a subscription had been bought.
 *
 * React Flow is MIT and the option works without one. What the subscription
 * buys is PERMISSION to use it:
 *
 *   "Only remove this attribution, if you are subscribed to React Flow Pro."
 *   — reactflow.dev/learn/troubleshooting/remove-attribution
 *
 * So the failure mode is not a broken build or a rendering bug. It is a
 * compliance product shipping an unlicensed use of a library, discovered by
 * somebody else. That is the kind of thing a guard is for and a habit is not.
 *
 * ═══ WHEN THIS GOES RED ═══
 *
 * It means somebody re-added the option. That is FINE if the subscription
 * exists — delete this file in the same diff, and say in the commit message who
 * confirmed it. What must not happen is the option coming back quietly while
 * this file is edited to look the other way.
 *
 * @see tests/guards/canvas-editor-stays-inside-its-module.test.ts — the other
 *      control on the same libraries, for a different licence question.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/** Every component that mounts a React Flow surface today. */
/*
    TRIMMED, not retired, when the process canvas was deleted (#3079).

    The two entries that went were `PersistedProcessCanvas.tsx` and
    `ProcessCanvas.tsx`. The obligation they carried did NOT go with them: the
    bow-tie risk canvas and the traceability graph explorer still render React
    Flow and still owe the attribution. Deleting this guard alongside the
    renderer would have dropped a licence condition two live surfaces are
    subject to.

    `@xyflow/react` therefore stays a dependency after the cutover — 16
    importers become 3, not 0, which is what
    `canvas-editor-stays-inside-its-module.test.ts` already said in its
    `ALLOWED_OUTSIDE` note before anyone measured it.
*/
const FLOW_SURFACES: readonly string[] = [
    'src/app/t/[tenantSlug]/(app)/risks/[riskId]/BowTieCanvas.tsx',
    'src/components/ui/GraphExplorer.tsx',
];

/** Source with `//` and block comments stripped, so prose cannot satisfy a check. */
function codeOnly(rel: string): string {
    const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    return raw
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

describe('the React Flow attribution is shown', () => {
    it('every listed surface still exists — an absent file checks nothing', () => {
        // The population control. A renamed or deleted file would otherwise
        // drop out of the sweep silently and take its exemption with it.
        for (const rel of FLOW_SURFACES) {
            expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
        }
    });

    it('no surface sets hideAttribution', () => {
        const offenders = FLOW_SURFACES.filter((rel) => /hideAttribution/.test(codeOnly(rel)));
        expect({
            why: 'React Flow permits removing the attribution only with a Pro subscription. If one has been bought, delete this guard in the same diff and name who confirmed it.',
            offenders,
        }).toEqual({ why: expect.any(String), offenders: [] });
    });

    it('nothing ELSE in src/ sets it either — the list is not the whole defence', () => {
        // A fifth surface added later would not be in FLOW_SURFACES, so the
        // assertion above cannot see it. This one sweeps everything.
        const hits: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
                const rel = path.join(dir, e.name);
                if (e.isDirectory()) walk(rel);
                else if (/\.tsx?$/.test(e.name) && /hideAttribution/.test(codeOnly(rel))) hits.push(rel);
            }
        };
        walk('src');
        expect(hits).toEqual([]);
    });

    it('the comment-stripper works — the prose above would otherwise pass for code', () => {
        // The positive control, and it is not hypothetical: all four files carry
        // a comment that QUOTES the option by name. Without stripping, every
        // assertion here would fail on its own explanation.
        const withComment = FLOW_SURFACES.filter((rel) =>
            /hideAttribution/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')),
        );
        expect(withComment.length).toBeGreaterThan(0);
        expect(withComment.every((rel) => !/hideAttribution/.test(codeOnly(rel)))).toBe(true);
    });
});
