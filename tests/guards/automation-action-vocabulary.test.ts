/**
 * Every `AutomationActionType` is wired into every surface that names one.
 *
 * ── Why this exists ─────────────────────────────────────────────────
 *
 * `INVOKE_SUBFLOW` shipped in the Prisma enum, the Zod config union, the
 * executor and the Rule Builder — and was missing from exactly two places, both
 * hand-written lists. The consequences were invisible rather than loud:
 *
 *   - the Rules tab's Action filter could not select sub-flow rules AT ALL, so
 *     they were unfindable by their defining attribute;
 *   - `buildRuleActionLabels` had no entry, so the rules table and the detail
 *     sheet fell through to the raw `INVOKE_SUBFLOW` enum string;
 *   - the canvas inspector's action picker had no matching option, so selecting
 *     a sub-flow node showed an EMPTY control.
 *
 * The root cause is hand-enumeration against an enum that grows. The durable
 * fix is a test that reads the enum and fails when the NEXT member is added
 * without being wired — the same shape as the route field-forwarding guard.
 *
 * Structural (source-scanning) on purpose: a rendering test proves the values
 * that ARE listed render, but cannot notice one nobody listed.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const ENUMS = read('prisma/schema/enums.prisma');
const FILTER_DEFS = read('src/app/t/[tenantSlug]/(app)/processes/automation-filter-defs.ts');
const INSPECTOR = read('src/components/processes/AutomationInspectorPanel.tsx');
const SCHEMAS = read('src/app-layer/schemas/automation.schemas.ts');
const EN = JSON.parse(read('messages/en.json'));
const BG = JSON.parse(read('messages/bg.json'));

/** Members of `enum AutomationActionType` in the Prisma schema. */
function actionTypesFromPrisma(): string[] {
    const m = ENUMS.match(/enum AutomationActionType \{([\s\S]*?)\n\}/);
    if (!m) throw new Error('enum AutomationActionType not found in enums.prisma');
    return m[1]
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^[A-Z][A-Z0-9_]*$/.test(l));
}

const ACTION_TYPES = actionTypesFromPrisma();

describe('automation action-type vocabulary is complete', () => {
    it('the parser found the real enum', () => {
        // Sanity: a parser returning [] would make every assertion below vacuous.
        expect(ACTION_TYPES.length).toBeGreaterThanOrEqual(5);
        expect(ACTION_TYPES).toContain('INVOKE_SUBFLOW');
    });

    it.each(ACTION_TYPES)('%s is a member of RuleActionKey', (type) => {
        const union = FILTER_DEFS.match(/export type RuleActionKey =([\s\S]*?);/);
        expect(union).not.toBeNull();
        expect(union![1]).toContain(`'${type}'`);
    });

    it.each(ACTION_TYPES)('%s has a buildRuleActionLabels entry', (type) => {
        expect(FILTER_DEFS).toMatch(
            new RegExp(`${type}:\\s*t\\('ruleActionLabels\\.${type}'\\)`),
        );
    });

    it.each(ACTION_TYPES)('%s has an en + bg ruleActionLabels string', (type) => {
        expect(EN.processes.ruleActionLabels[type]).toEqual(expect.any(String));
        expect(BG.processes.ruleActionLabels[type]).toEqual(expect.any(String));
    });

    it.each(ACTION_TYPES)('%s has a canvas-inspector label', (type) => {
        // The inspector renders the label as text (it does not offer a picker —
        // see the comment there), so a missing entry means the panel shows a
        // raw enum string for that action.
        expect(INSPECTOR).toMatch(new RegExp(`${type}:\\s*t\\(`));
    });

    it.each(ACTION_TYPES)('%s has an ACTION_CONFIG_BY_TYPE schema', (type) => {
        expect(SCHEMAS).toMatch(new RegExp(`${type}:\\s*\\w+Config`));
    });
});
