/**
 * Automation rule routes forward EVERY schema field.
 *
 * ── Why this exists ─────────────────────────────────────────────────
 *
 * `elseRuleId` and `scheduleConfig` were accepted by the Zod schema, persisted
 * by the repository and constructed by the builder — and referenced ZERO times
 * in either route. The routes enumerate fields by hand and simply stopped after
 * `nextRuleDelay`.
 *
 * The failure was silent and total:
 *   - the entire "Else / when conditions fail" control was write-only theatre;
 *   - `scheduleConfigJson` stayed null, so the schedule sweep COULD NEVER FIRE
 *     a SCHEDULE rule — despite an in-code comment claiming that was fixed.
 *
 * Forwarding the two fields fixes today. This test fixes tomorrow: the root
 * cause is hand-enumeration, so the only durable guard is one that fails when
 * the NEXT field is added to the schema and forgotten in the route.
 *
 * Deliberately structural (source-scanning) rather than behavioural: a
 * round-trip test proves the fields that ARE forwarded survive, but cannot
 * notice a field nobody wired up. Absence is what needs guarding.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SCHEMA_SRC = read('src/app-layer/schemas/automation.schemas.ts');
const CREATE_ROUTE = read('src/app/api/t/[tenantSlug]/automation/rules/route.ts');
const UPDATE_ROUTE = read('src/app/api/t/[tenantSlug]/automation/rules/[id]/route.ts');

/**
 * Fields the routes are NOT expected to forward, each with a written reason.
 * Adding an entry here is a deliberate act a reviewer can weigh — which is the
 * point. Silence was the bug.
 */
const NOT_FORWARDED: Record<string, string> = {
    // `status` is forwarded, but the dedicated toggle endpoint owns transitions;
    // both routes do pass it, so it is not exempt — listed here only if that
    // ever changes.
};

/** Keys declared directly in a `{ ... }` block, at any indent. */
function keysIn(block: string): string[] {
    return Array.from(block.matchAll(/^\s+([a-zA-Z][a-zA-Z0-9]*):\s/gm)).map((m) => m[1]);
}

function blockAfter(marker: string): string {
    const start = SCHEMA_SRC.indexOf(marker);
    if (start === -1) throw new Error(`not found: ${marker}`);
    const rest = SCHEMA_SRC.slice(start + marker.length);
    const end = rest.indexOf('\nexport const ');
    const untilNextExport = end === -1 ? rest : rest.slice(0, end);
    // Stop at the closing `})` of the object literal so a trailing
    // `.superRefine((val, ctx) => {` body does not contribute stray keys.
    const close = untilNextExport.indexOf('\n    })');
    return close === -1 ? untilNextExport : untilNextExport.slice(0, close);
}

/**
 * Collects a schema's field names, EXPANDING spreads like `...SlaFields`.
 *
 * The spread matters: elseRuleId and scheduleConfig — the two fields that were
 * dropped — live inside `SlaFields`, not in the schema literal. A parser that
 * ignored spreads would report them as absent from the schema and quietly pass.
 */
function schemaFieldsOf(schemaName: string): string[] {
    const block = blockAfter(`export const ${schemaName}`);
    const direct = keysIn(block);
    const spreads = Array.from(block.matchAll(/\.\.\.([A-Z][A-Za-z0-9]*)/g)).map((m) => m[1]);
    const fromSpreads = spreads.flatMap((name) => keysIn(blockAfter(`const ${name}`)));
    return Array.from(new Set([...direct, ...fromSpreads]));
}

describe('automation rule routes forward every schema field', () => {
    it.each([
        ['POST /automation/rules', 'CreateAutomationRuleSchema', CREATE_ROUTE],
        ['PUT /automation/rules/[id]', 'UpdateAutomationRuleSchema', UPDATE_ROUTE],
    ])('%s forwards all of %s', (_label, schemaName, routeSrc) => {
        const fields = schemaFieldsOf(schemaName);
        expect(fields.length).toBeGreaterThan(5); // sanity: the parser found a real schema

        const missing = fields.filter(
            (f) => !(f in NOT_FORWARDED) && !new RegExp(`body\\.${f}\\b`).test(routeSrc),
        );

        if (missing.length > 0) {
            throw new Error(
                [
                    `Route does not forward these ${schemaName} fields: ${missing.join(', ')}`,
                    '',
                    'The schema accepts them and the repository persists them, so a',
                    'field missing here is silently discarded — the exact shape of the',
                    'elseRuleId / scheduleConfig bug this guard exists to prevent.',
                    '',
                    'Either forward `body.<field>` in the route, or add the field to',
                    'NOT_FORWARDED in this file with a written reason.',
                ].join('\n'),
            );
        }
    });

    it('specifically forwards elseRuleId and scheduleConfig — the two that were dropped', () => {
        for (const route of [CREATE_ROUTE, UPDATE_ROUTE]) {
            expect(route).toMatch(/body\.elseRuleId\b/);
            expect(route).toMatch(/body\.scheduleConfig\b/);
        }
    });
});
