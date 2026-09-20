/**
 * VR-10 — governance graph ratchet.
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

describe('VR-10 — governance graph', () => {
    it('the builder + route + page exist', () => {
        expect(exists('src/app-layer/services/governance-graph-builder.ts')).toBe(true);
        expect(
            exists('src/app/api/t/[tenantSlug]/processes/governance-graph/route.ts'),
        ).toBe(true);
        expect(
            exists('src/app/t/[tenantSlug]/(app)/processes/governance/page.tsx'),
        ).toBe(true);
    });

    it('the builder derives nodes/edges + health from posture', () => {
        const src = read('src/app-layer/services/governance-graph-builder.ts');
        expect(src).toMatch(/export function buildGovernanceGraph/);
        expect(src).toMatch(/export function healthFor/);
        // sub-flow links come from subFlowGroupId
        expect(src).toMatch(/subFlowGroupId/);
        expect(src).toMatch(/'subflow-call'/);
    });
});
