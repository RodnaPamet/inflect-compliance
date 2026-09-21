/**
 * PR-B follow-ups ratchet — keep the doc-bar mode toggle + governance nav link
 * wired (and the metadata-only PATCH path that backs the toggle).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));

describe('canvas mode toggle + governance link', () => {
    it('the PATCH mode-switch route + usecase exist', () => {
        const route = read('src/app/api/t/[tenantSlug]/processes/[id]/route.ts');
        expect(route).toMatch(/export const PATCH/);
        expect(route).toMatch(/setProcessMapCanvasMode/);
        expect(read('src/app-layer/usecases/process-map.ts')).toMatch(
            /export async function setProcessMapCanvasMode/,
        );
    });

    it('the document bar renders the mode toggle', () => {
        const bar = read('src/components/processes/CanvasDocumentBar.tsx');
        expect(bar).toMatch(/data-testid="canvas-mode-toggle"/);
        expect(bar).toMatch(/onSwitchMode/);
    });

    it('the canvas wires handleSwitchMode via the helper', () => {
        const canvas = read('src/components/processes/PersistedProcessCanvas.tsx');
        expect(canvas).toMatch(/handleSwitchMode/);
        expect(canvas).toMatch(/patchCanvasMode/);
    });

    it('the Processes page links to the governance graph', () => {
        const client = read('src/app/t/[tenantSlug]/(app)/processes/ProcessesClient.tsx');
        expect(client).toMatch(/data-testid="governance-graph-link"/);
        expect(client).toMatch(/processes\/governance/);
    });
});
