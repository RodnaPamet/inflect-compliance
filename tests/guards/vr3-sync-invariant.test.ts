/**
 * VR-3 — Canvas ↔ AutomationRule sync INVARIANT guardrail.
 *
 * The keystone invariant: `ProcessNode` owns geometry, `AutomationRule` owns
 * logic, NEVER mixed. A violation anywhere in VR-4…VR-10 would require a data
 * migration to untangle — so this ratchet ships with the sync service (the
 * roadmap's explicit day-one requirement).
 *
 * Structural enforcement: the sync service is the ONLY place the two
 * projections meet, so we lock its source shape:
 *   1. It never references geometry columns (posX/posY/parentNodeKey) — so
 *      geometry can't leak into a rule write.
 *   2. It never references rule LOGIC columns (triggerFilterJson /
 *      actionConfigJson) when writing a node — the only thing written back to
 *      a node is `ruleId`.
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
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

const SYNC = 'src/app-layer/services/canvas-rule-sync.ts';

/** Strip block + line comments so the scan sees CODE only (comments
 * legitimately name the forbidden fields when documenting the invariant). */
function code(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('VR-3 — sync invariant', () => {
    it('the sync service exists with both directions', () => {
        expect(exists(SYNC)).toBe(true);
        const src = code(read(SYNC));
        expect(src).toMatch(/export async function syncCanvasToRules/);
        expect(src).toMatch(/export async function hydrateCanvasFromRules/);
    });

    it('never references geometry columns (no geometry → rule leak)', () => {
        const src = code(read(SYNC));
        for (const geom of ['posX', 'posY', 'parentNodeKey']) {
            expect(src).not.toMatch(new RegExp(geom));
        }
    });

    it('never writes rule logic columns to a node (only ruleId crosses to nodes)', () => {
        const src = code(read(SYNC));
        for (const logic of ['triggerFilterJson', 'actionConfigJson']) {
            expect(src).not.toMatch(new RegExp(logic));
        }
        // the only field written back onto a node is `ruleId`
        expect(src).toMatch(/ruleId: rule\.id/);
    });

    it('the save/load usecase gates sync on AUTOMATION mode', () => {
        const src = read('src/app-layer/usecases/process-map.ts');
        expect(src).toMatch(/syncCanvasToRules/);
        expect(src).toMatch(/hydrateCanvasFromRules/);
        expect(src).toMatch(/canvasMode === 'AUTOMATION'/);
    });
});
