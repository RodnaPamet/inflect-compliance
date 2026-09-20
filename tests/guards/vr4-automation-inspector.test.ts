/**
 * VR-4 — automation inspector panel ratchet.
 *
 * Locks the inline rule editor + its mode/kind-gated mount in ProcessInspector.
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

describe('VR-4 — automation inspector', () => {
    it('the panel component exists and edits the rule (not the node)', () => {
        const p = 'src/components/processes/AutomationInspectorPanel.tsx';
        expect(exists(p)).toBe(true);
        const src = read(p);
        // edits flow to the rule endpoint, per-kind branches present
        expect(src).toMatch(/CACHE_KEYS\.automation\.rules\.detail/);
        for (const kind of ['trigger', 'condition', 'action', 'slaGate']) {
            expect(src).toMatch(new RegExp(`'${kind}'`));
        }
    });

    it('ProcessInspector mounts it gated on automation mode + node kind', () => {
        const src = read('src/components/processes/ProcessInspector.tsx');
        expect(src).toMatch(/useIsAutomationMode/);
        expect(src).toMatch(/isAutomationNodeKind/);
        expect(src).toMatch(/AutomationInspectorPanel/);
    });
});
