/**
 * The JSON-Schema → valibot converter that lets an external agent runtime be
 * told what this product's MCP tools accept.
 *
 * ── THE TEST THAT MATTERS IS THE POPULATION ONE ─────────────────────────────
 *
 * Hand-picked fixtures prove the converter handles the shapes somebody thought
 * of. The assertion with real teeth runs it over EVERY tool in `READ_TOOLS`, so
 * a tool added later with a nested object — the construct a new tool is most
 * likely to reach for — fails here rather than being silently dropped from the
 * set the model is offered.
 *
 * The count is printed beside the result, because "every tool converted" and
 * "the loop ran zero times" are the same empty failure list otherwise.
 *
 * ── AND THE CROSS-CHECK IS THE OTHER HALF ───────────────────────────────────
 *
 * Each tool now declares its arguments three times: JSON Schema (the MCP wire
 * format), Zod (what `runReadTool` actually enforces), and the valibot schema
 * derived here. Three representations of one fact are three chances to
 * disagree. The derivation removes one of those chances by construction; the
 * cross-check below closes the other, by running the same inputs through the
 * derived valibot schema and the tool's own Zod schema and requiring them to
 * agree on accept/reject.
 */
import * as v from 'valibot';

import {
    toValibotInputSchema,
    UnsupportedToolSchemaError,
} from '@/lib/agentic/flue/json-schema-to-valibot';
import { READ_TOOLS } from '@/lib/mcp/tools/registry';

describe('every live tool converts', () => {
    it('converts all of READ_TOOLS, and says how many it examined', () => {
        const failures: string[] = [];
        for (const tool of READ_TOOLS) {
            try {
                toValibotInputSchema(tool.name, tool.inputSchema);
            } catch (err) {
                failures.push(`${tool.name}: ${(err as Error).message}`);
            }
        }
        // The denominator is part of the result. A converter that examined
        // nothing reports the same empty failure list as one that examined ten.
        expect({ examined: READ_TOOLS.length, failures }).toEqual({
            examined: READ_TOOLS.length,
            failures: [],
        });
        expect(READ_TOOLS.length).toBeGreaterThan(0);
    });

    it('rejects the empty object for exactly the tools that require an argument', () => {
        // An earlier version of this test asserted that `{}` is legal for EVERY
        // tool. That was a wrong assumption about the catalogue rather than a
        // finding: `search_controls` and `find_coverage_gaps` genuinely declare
        // required arguments. The invariant worth holding is the derived one —
        // a tool rejects `{}` if and only if its JSON Schema says something is
        // required — which tests that `required` is honoured, in both
        // directions, without hard-coding which tools those are today.
        const mismatched: string[] = [];
        for (const t of READ_TOOLS) {
            const declaresRequired =
                Array.isArray((t.inputSchema as { required?: unknown }).required) &&
                ((t.inputSchema as { required: unknown[] }).required.length > 0);
            const rejectsEmpty = !v.safeParse(
                toValibotInputSchema(t.name, t.inputSchema),
                {},
            ).success;
            if (declaresRequired !== rejectsEmpty) {
                mismatched.push(
                    `${t.name}: declaresRequired=${declaresRequired} rejectsEmpty=${rejectsEmpty}`,
                );
            }
        }
        expect({ examined: READ_TOOLS.length, mismatched }).toEqual({
            examined: READ_TOOLS.length,
            mismatched: [],
        });
    });
});

describe('the derived schema agrees with the Zod schema it was NOT derived from', () => {
    // The JSON Schema and the Zod schema are written independently, by hand,
    // in the same file. This walks both with the same inputs and requires the
    // same verdict — so a tool whose two hand-written schemas have drifted from
    // each other is caught here, by a test that is nominally about neither.
    const CASES: ReadonlyArray<[string, Record<string, unknown>]> = [
        ['empty', {}],
        ['a plausible string filter', { status: 'OPEN', q: 'access' }],
        ['a legal limit', { limit: 25 }],
        ['a limit of the wrong type', { limit: 'twenty' }],
        ['an unknown key', { nonsenseKeyNobodyDeclared: true }],
    ];

    it.each(CASES)('agrees on %s', (_label, input) => {
        const disagreements: string[] = [];
        for (const tool of READ_TOOLS) {
            const valibotOk = v.safeParse(
                toValibotInputSchema(tool.name, tool.inputSchema),
                input,
            ).success;
            const zodOk = tool.argsSchema.safeParse(input).success;
            if (valibotOk !== zodOk) {
                disagreements.push(`${tool.name}: valibot=${valibotOk} zod=${zodOk}`);
            }
        }
        expect({ examined: READ_TOOLS.length, disagreements }).toEqual({
            examined: READ_TOOLS.length,
            disagreements: [],
        });
    });
});

describe('it refuses what it cannot express, rather than degrading', () => {
    // A converter that emitted "any object" for a schema it could not read
    // would hand the model a tool it cannot call correctly, with no signal.
    // Each of these must THROW.
    it('refuses a non-object top level', () => {
        expect(() => toValibotInputSchema('t', { type: 'string' })).toThrow(
            UnsupportedToolSchemaError,
        );
    });

    it('refuses a nested object, naming it as the reason', () => {
        expect(() =>
            toValibotInputSchema('t', {
                type: 'object',
                properties: { filter: { type: 'object', properties: {} } },
            }),
        ).toThrow(/nested object/);
    });

    it('refuses an array property', () => {
        expect(() =>
            toValibotInputSchema('t', {
                type: 'object',
                properties: { ids: { type: 'array' } },
            }),
        ).toThrow(/nested array/);
    });

    it('refuses an unknown scalar type', () => {
        expect(() =>
            toValibotInputSchema('t', {
                type: 'object',
                properties: { when: { type: 'date-time' } },
            }),
        ).toThrow(/unsupported type/);
    });

    it('refuses an enum that is empty or not all strings', () => {
        expect(() =>
            toValibotInputSchema('t', { type: 'object', properties: { a: { enum: [] } } }),
        ).toThrow(/empty enum/);
        expect(() =>
            toValibotInputSchema('t', { type: 'object', properties: { a: { enum: ['x', 3] } } }),
        ).toThrow(/non-string enum member/);
    });
});

describe('the shapes it does express, it expresses correctly', () => {
    const schema = toValibotInputSchema('sample', {
        type: 'object',
        properties: {
            name: { type: 'string' },
            count: { type: 'integer', minimum: 1, maximum: 10 },
            flag: { type: 'boolean' },
            due: { type: 'string', enum: ['overdue', 'next7d'] },
        },
        required: ['name'],
    });

    const accepts = (input: unknown) => v.safeParse(schema, input).success;

    it('requires what is required and permits what is optional', () => {
        expect(accepts({ name: 'x' })).toBe(true);
        expect(accepts({})).toBe(false);
    });

    it('holds the integer bounds it was given', () => {
        expect(accepts({ name: 'x', count: 5 })).toBe(true);
        expect(accepts({ name: 'x', count: 0 })).toBe(false);
        expect(accepts({ name: 'x', count: 11 })).toBe(false);
        expect(accepts({ name: 'x', count: 2.5 })).toBe(false);
    });

    it('holds the enum as a closed set', () => {
        expect(accepts({ name: 'x', due: 'overdue' })).toBe(true);
        expect(accepts({ name: 'x', due: 'whenever' })).toBe(false);
    });

    it('follows additionalProperties in BOTH directions', () => {
        // The rule the cross-check forced. Absent `additionalProperties` means
        // permissive, which is JSON Schema's own default and what this sample
        // schema declares. `additionalProperties: false` means strict — and
        // every live tool declares it, which is why an earlier unconditional
        // `v.object` had eight of ten tools telling the model an invented key
        // was acceptable when the funnel would refuse the call.
        expect(accepts({ name: 'x', undeclared: 'whatever' })).toBe(true);

        const strict = toValibotInputSchema('strict-sample', {
            type: 'object',
            properties: { name: { type: 'string' } },
            additionalProperties: false,
        });
        expect(v.safeParse(strict, { name: 'x' }).success).toBe(true);
        expect(v.safeParse(strict, { name: 'x', undeclared: 1 }).success).toBe(false);
    });
});
