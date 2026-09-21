/**
 * VR-5 — visual chain edges ratchet.
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

describe('VR-5 — chain edges', () => {
    it('the edge-kind inference module exists with the 6 automation kinds', () => {
        const p = 'src/lib/processes/edge-kind-inference.ts';
        expect(exists(p)).toBe(true);
        const src = read(p);
        for (const k of [
            'trigger-flow',
            'condition-pass',
            'condition-fail',
            'chain-delay',
            'sla-breach',
            'sla-pass',
        ]) {
            expect(src).toMatch(new RegExp(k));
        }
        expect(src).toMatch(/export function inferEdgeKind/);
    });

    it('ProcessEdge renders a per-kind automation style + chip', () => {
        const src = read('src/components/processes/ProcessEdge.tsx');
        expect(src).toMatch(/buildAutomationEdgeStyle/);
        expect(src).toMatch(/data-edge-kind-chip/);
    });
});
