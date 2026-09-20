/**
 * Automation Epic 1 — structural ratchet.
 *
 * Locks the shape of the Rule inventory slice so a refactor can't quietly
 * drop the platform primitive or the API surface:
 *   1. RulesTab composes the shared `EntityListPage` (not a hand-rolled
 *      ListPageShell + DataTable block).
 *   2. The automation rules API routes exist (list/create + detail/update/
 *      delete) and authorise via the automation usecases (which gate on the
 *      automation RBAC policies).
 *   3. ProcessesClient mounts the Rules tab.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so a guard can no
// longer be satisfied by a COMMENT naming the thing its assertion is about.
// Applied here rather than per assertion so a new `expect(read(...))` inherits
// it. String literals are KEPT: masking them would silently empty assertions
// that harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike (re-derived per file, not assumed from the directory), so
// `codeOf` is the right lexer and no language split is needed.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

const RULES_TAB = 'src/app/t/[tenantSlug]/(app)/processes/RulesTab.tsx';
const PROCESSES = 'src/app/t/[tenantSlug]/(app)/processes/ProcessesClient.tsx';
const ROUTE_LIST = 'src/app/api/t/[tenantSlug]/automation/rules/route.ts';
const ROUTE_DETAIL = 'src/app/api/t/[tenantSlug]/automation/rules/[id]/route.ts';
const USECASE = 'src/app-layer/usecases/automation-rules.ts';

describe('Automation Epic 1 — Rule list & API', () => {
    it('RulesTab composes the EntityListPage platform primitive', () => {
        const src = read(RULES_TAB);
        expect(src).toMatch(/import \{ EntityListPage \}/);
        expect(src).toMatch(/<EntityListPage/);
        // reads the typed cache key, not a hand-spelled URL
        expect(src).toMatch(/CACHE_KEYS\.automation\.rules\.list\(\)/);
    });

    it('the rules API routes exist with the documented verbs', () => {
        expect(exists(ROUTE_LIST)).toBe(true);
        expect(exists(ROUTE_DETAIL)).toBe(true);
        const list = read(ROUTE_LIST);
        expect(list).toMatch(/export const GET/);
        expect(list).toMatch(/export const POST/);
        const detail = read(ROUTE_DETAIL);
        expect(detail).toMatch(/export const GET/);
        expect(detail).toMatch(/export const PUT/);
        expect(detail).toMatch(/export const DELETE/);
    });

    it('routes call usecases (not the repository directly)', () => {
        const list = read(ROUTE_LIST);
        const detail = read(ROUTE_DETAIL);
        expect(list).toMatch(/from '@\/app-layer\/usecases\/automation-rules'/);
        expect(detail).toMatch(/from '@\/app-layer\/usecases\/automation-rules'/);
        // no route reaches past the usecase layer into the repo
        expect(list).not.toMatch(/AutomationRuleRepository/);
        expect(detail).not.toMatch(/AutomationRuleRepository/);
    });

    it('the usecase gates every path on the automation RBAC policies', () => {
        const src = read(USECASE);
        expect(src).toMatch(/assertCanReadAutomation/);
        expect(src).toMatch(/assertCanManageAutomation/);
    });

    it('ProcessesClient mounts the Rules tab via the canonical tablist pattern', () => {
        const src = read(PROCESSES);
        expect(src).toMatch(/RulesTab/);
        // EntityDetailLayout tab pattern (border-b accent), not TabSelect —
        // the single-tab-pattern ratchet reserves TabSelect out of app pages.
        expect(src).toMatch(/role="tablist"/);
        expect(src).not.toMatch(/TabSelect/);
    });
});
