/**
 * Automation Epic 4 — structural ratchet for the Filter DSL v2.
 *
 * Locks: the recursive FilterGroup types exist, the evaluator handles BOTH
 * the new group shape and the legacy flat map (so no migration is
 * load-bearing), and the builder Step 2 emits operators + AND/OR.
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

const TYPES = 'src/app-layer/automation/types.ts';
const FILTERS = 'src/app-layer/automation/filters.ts';
const MODAL = 'src/components/processes/RuleBuilderModal.tsx';

describe('Automation Epic 4 — Filter DSL v2', () => {
    it('types define the recursive FilterGroup + operators', () => {
        const src = read(TYPES);
        expect(src).toMatch(/export type FilterOperator/);
        expect(src).toMatch(/export interface FilterCondition/);
        expect(src).toMatch(/export interface FilterGroup/);
        expect(src).toMatch(/export function isFilterGroup/);
    });

    it('the evaluator supports BOTH the group shape and the legacy flat map', () => {
        const src = read(FILTERS);
        expect(src).toMatch(/isFilterGroup/);
        expect(src).toMatch(/evalGroup/);
        expect(src).toMatch(/evalLegacy/);
        // every operator is handled
        for (const op of ['eq', 'neq', 'in', 'not_in', 'gt', 'lt', 'contains']) {
            expect(src).toMatch(new RegExp(`case '${op}'`));
        }
    });

    it('the builder Step 2 emits operators + AND/OR logic', () => {
        const src = read(MODAL);
        expect(src).toMatch(/buildOperatorOptions/);
        expect(src).toMatch(/logic: form\.logic/);
        // the equality-only note from Epic 3 is gone
        expect(src).not.toMatch(/match by equality\. Operators and AND\/OR/);
    });
});
