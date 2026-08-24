/**
 * Task + test search coverage + single-char query support.
 *
 * Three problems closed in one PR:
 *
 *   1. MIN_QUERY_LENGTH was 2 — single-character queries like `1`
 *      (looking for "Risk 1") returned an empty set before
 *      reaching the DB.
 *   2. Tasks weren't searchable from the palette.
 *   3. Tests (ControlTestPlan) weren't searchable from the palette.
 *
 * Each item is locked structurally so a future "tighten MIN to 2
 * again for safety" or "remove task hits to keep the palette small"
 * PR has to argue against this ratchet.
 *
 * The asset coverage PR established the four-touchpoint contract
 * (type union, defaults, usecase wiring, palette UI). This PR
 * applies the same pattern twice — once for task, once for test.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    MIN_QUERY_LENGTH,
    SEARCH_TYPE_DEFAULTS,
    type SearchHitType,
} from '@/lib/search/types';
import { __SEARCHABLE_TYPES__ } from '@/app-layer/usecases/search';

const ROOT = path.resolve(__dirname, '../..');

describe('MIN_QUERY_LENGTH allows single-char queries', () => {
    it('MIN_QUERY_LENGTH is 1 (not 2)', () => {
        // Pre-2026-05-12 this was 2, which blocked queries like `1`
        // before reaching the DB. The contract is now: the
        // server accepts any non-empty query; the per-type-limit +
        // ILIKE-indexed columns bound the cost.
        expect(MIN_QUERY_LENGTH).toBe(1);
    });
});

describe('Task search coverage', () => {
    it('SearchHitType union includes "task"', () => {
        const types: SearchHitType[] = [
            'control',
            'risk',
            'policy',
            'evidence',
            'framework',
            'asset',
            'task',
            'test',
        ];
        expect(types).toContain('task');
    });

    it('SEARCH_TYPE_DEFAULTS.task exists', () => {
        expect(SEARCH_TYPE_DEFAULTS.task).toBeDefined();
        expect(SEARCH_TYPE_DEFAULTS.task.iconKey).toBe('check-square');
        expect(SEARCH_TYPE_DEFAULTS.task.category).toBe('Tasks');
    });

    it('__SEARCHABLE_TYPES__ includes "task"', () => {
        expect(__SEARCHABLE_TYPES__).toContain('task');
    });

    it('rank.ts TYPE_BASELINE includes "task"', () => {
        const src = fs.readFileSync(
            path.join(ROOT, 'src/lib/search/rank.ts'),
            'utf8',
        );
        expect(src).toMatch(
            /TYPE_BASELINE:\s*Record<SearchHitType,\s*number>\s*=\s*\{[\s\S]*?\btask:\s*\d+/,
        );
    });

    it('search usecase queries db.task.findMany', () => {
        const src = fs.readFileSync(
            path.join(ROOT, 'src/app-layer/usecases/search.ts'),
            'utf8',
        );
        expect(src).toMatch(/db\.task\.findMany\(/);

        // BOUNDED to the task query. The previous assertion was
        //   /title:\s*\{\s*contains[\s\S]+?description:\s*\{\s*contains[\s\S]+?key:.../
        // over the WHOLE file, and `[\s\S]+?` happily bridges from one
        // domain's query into another's — so it matched a `description:
        // { contains }` belonging to a different entity and reported that the
        // TASK query searched description. It kept passing after the task
        // clause was removed, which is how a stale assertion survives.
        const taskQuery = src.slice(
            src.indexOf('db.task.findMany('),
            src.indexOf('db.controlTestPlan.findMany('),
        );
        expect(taskQuery.length).toBeGreaterThan(100); // the slice found something
        expect(taskQuery).toMatch(/title:\s*\{\s*contains/);
        expect(taskQuery).toMatch(/key:\s*\{\s*contains/);

        // description is DELIBERATELY not searched: `Task.description` is in
        // the encryption manifest, so the ILIKE ran against `v1:` ciphertext
        // and could never match a plaintext query. Worse than dead — a row
        // written by anything bypassing the middleware WOULD have matched, so
        // the clause searched an arbitrary legacy subset while appearing to
        // search all descriptions. Asserting its ABSENCE here, bounded to this
        // query, is what stops it being re-added by someone reading the select
        // list and assuming a gap.
        expect(taskQuery).not.toMatch(/description:\s*\{\s*contains/);
    });

    it('palette UI ENTITY_META + ENTITY_ORDER include "task"', () => {
        const src = fs.readFileSync(
            path.join(
                ROOT,
                'src/components/command-palette/command-palette.tsx',
            ),
            'utf8',
        );
        expect(src).toMatch(
            /task:\s*\{\s*heading:\s*t\('entityTask'\)[^}]*icon:\s*CheckSquare/,
        );
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        expect(require('../../messages/en.json').commandPalette.entityTask).toBe('Tasks');
        expect(src).toMatch(
            /import\s+\{[^}]*\bCheckSquare\b[^}]*\}\s+from\s+['"]lucide-react['"]/,
        );
        expect(src).toMatch(
            /ENTITY_ORDER:\s*EntityKind\[\]\s*=\s*\[[\s\S]+?['"]task['"]/,
        );
    });
});

describe('Test (ControlTestPlan) search coverage', () => {
    it('SEARCH_TYPE_DEFAULTS.test exists', () => {
        expect(SEARCH_TYPE_DEFAULTS.test).toBeDefined();
        expect(SEARCH_TYPE_DEFAULTS.test.iconKey).toBe('flask');
        expect(SEARCH_TYPE_DEFAULTS.test.category).toBe('Tests');
    });

    it('__SEARCHABLE_TYPES__ includes "test"', () => {
        expect(__SEARCHABLE_TYPES__).toContain('test');
    });

    it('rank.ts TYPE_BASELINE includes "test"', () => {
        const src = fs.readFileSync(
            path.join(ROOT, 'src/lib/search/rank.ts'),
            'utf8',
        );
        expect(src).toMatch(
            /TYPE_BASELINE:\s*Record<SearchHitType,\s*number>\s*=\s*\{[\s\S]*?\btest:\s*\d+/,
        );
    });

    it('search usecase queries db.controlTestPlan.findMany', () => {
        // Plans, not Runs — runs have no `name` field. The
        // palette searches the discoverable "what tests exist"
        // surface.
        const src = fs.readFileSync(
            path.join(ROOT, 'src/app-layer/usecases/search.ts'),
            'utf8',
        );
        expect(src).toMatch(/db\.controlTestPlan\.findMany\(/);
        expect(src).toMatch(/name:\s*\{\s*contains[\s\S]+?description:\s*\{\s*contains/);
        // The query fetches the control relation so the hit
        // builder can render "test for control X" subtitle + href.
        expect(src).toMatch(/control:\s*\{\s*select:\s*\{\s*code:\s*true,\s*name:\s*true\s*\}\s*\}/);
    });

    it('palette UI ENTITY_META + ENTITY_ORDER include "test"', () => {
        const src = fs.readFileSync(
            path.join(
                ROOT,
                'src/components/command-palette/command-palette.tsx',
            ),
            'utf8',
        );
        expect(src).toMatch(
            /test:\s*\{\s*heading:\s*t\('entityTest'\)[^}]*icon:\s*FlaskConical/,
        );
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        expect(require('../../messages/en.json').commandPalette.entityTest).toBe('Tests');
        expect(src).toMatch(
            /import\s+\{[^}]*\bFlaskConical\b[^}]*\}\s+from\s+['"]lucide-react['"]/,
        );
        expect(src).toMatch(
            /ENTITY_ORDER:\s*EntityKind\[\]\s*=\s*\[[\s\S]+?['"]test['"]/,
        );
    });
});
