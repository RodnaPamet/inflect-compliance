/**
 * The model is told what a tool's arguments MEAN, not only what type they are.
 *
 * ── THE LOSS THIS CLOSES ────────────────────────────────────────────────────
 *
 * `JsonSchemaProperty` declared `description` from the day the converter was
 * written and nothing ever read it. So every per-property description in
 * `src/lib/mcp/tools/` was dropped on the way to the model: the types survived
 * the conversion and the contract did not.
 *
 * That is not cosmetic, and the propose surface is where it shows. Its `items`
 * description carries the real contract — "Each is validated against the risk
 * create-schema; malformed items are rejected, never queued" — which is
 * precisely what stops a model shaping a propose call the funnel will refuse.
 * Telling the model less than the enforcement layer will hold it to is the
 * exact failure the converter's own `additionalProperties` note was written
 * about, arriving through a different door.
 *
 * ── WHY BEHAVIOURAL ─────────────────────────────────────────────────────────
 *
 * A source assertion could only say `v.description` appears somewhere. What
 * matters is whether the description is READABLE off the produced schema, and
 * whether it survives the `v.optional` wrapper an optional property gets — two
 * things a needle cannot judge and a reader would reasonably get wrong.
 */
import * as v from 'valibot';

import { toValibotInputSchema } from '@/lib/agentic/flue/json-schema-to-valibot';
import { PROPOSE_TOOLS } from '@/lib/mcp/tools/propose-tools';

/** Pull the description metadata off a produced schema, unwrapping optionality. */
function describedText(schema: unknown): string | undefined {
    const seen = new Set<unknown>();
    const walk = (s: unknown): string | undefined => {
        if (!s || typeof s !== 'object' || seen.has(s)) return undefined;
        seen.add(s);
        const node = s as { type?: string; description?: string; pipe?: unknown[]; wrapped?: unknown };
        if (node.type === 'description' && typeof node.description === 'string') return node.description;
        for (const item of node.pipe ?? []) {
            const hit = walk(item);
            if (hit !== undefined) return hit;
        }
        return walk(node.wrapped);
    };
    return walk(schema);
}

const entriesOf = (schema: unknown) =>
    (schema as { entries: Record<string, unknown> }).entries;

describe('a description survives the conversion', () => {
    it('on a required scalar', () => {
        const out = toValibotInputSchema('t', {
            type: 'object',
            properties: { title: { type: 'string', description: 'The risk title.' } },
            required: ['title'],
            additionalProperties: false,
        });
        expect(describedText(entriesOf(out).title)).toBe('The risk title.');
    });

    it('on an OPTIONAL one — and INSIDE the wrapper, not around it', () => {
        // Placement, not merely presence, because `describedText` walks through
        // `wrapped` and would find the description either way. A mutation that
        // moved it outside the `v.optional` proved exactly that: the presence
        // assertion could not discriminate, so it was not testing what its name
        // claimed.
        //
        // Inside is the correct placement: the description belongs to the TYPE,
        // not to the optionality of it, and a consumer reading the unwrapped
        // schema is the one that needs it.
        const out = toValibotInputSchema('t', {
            type: 'object',
            properties: { note: { type: 'string', description: 'Optional note.' } },
            additionalProperties: false,
        });
        const node = entriesOf(out).note as { type: string; wrapped?: unknown };
        expect(node.type).toBe('optional');
        // Found through `wrapped`, and NOT sitting on the optional node itself.
        expect(describedText(node.wrapped)).toBe('Optional note.');
        expect((node as { description?: string }).description).toBeUndefined();
    });

    it('on an ARRAY property, which is where the propose contract lives', () => {
        const out = toValibotInputSchema('t', {
            type: 'object',
            properties: {
                items: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 20,
                    items: { type: 'object' },
                    description: 'The candidates to propose.',
                },
            },
            required: ['items'],
            additionalProperties: false,
        });
        expect(describedText(entriesOf(out).items)).toBe('The candidates to propose.');
    });

    it('and the schema still VALIDATES the same — description is metadata, not a rule', () => {
        // The risk of piping a new action in: changing what the schema accepts.
        const out = toValibotInputSchema('t', {
            type: 'object',
            properties: {
                items: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'object' }, description: 'd' },
            },
            required: ['items'],
            additionalProperties: false,
        });
        expect(v.safeParse(out, { items: [{ a: 1 }] }).success).toBe(true);
        // The bounds the description sits beside must still bite.
        expect(v.safeParse(out, { items: [] }).success).toBe(false);
        expect(v.safeParse(out, { items: [{}, {}, {}] }).success).toBe(false);
    });
});

describe('the properties with no description are left alone', () => {
    it('carries no empty description action', () => {
        // A schema stating `description: ""` asserts something false about the
        // argument, which is worse than saying nothing.
        const out = toValibotInputSchema('t', {
            type: 'object',
            properties: { a: { type: 'string' }, b: { type: 'string', description: '   ' } },
            additionalProperties: false,
        });
        expect(describedText(entriesOf(out).a)).toBeUndefined();
        expect(describedText(entriesOf(out).b)).toBeUndefined();
    });
});

describe('the real shipped tools, not a fixture', () => {
    it('every propose tool carries its items contract through to the model', () => {
        // The population assertion and the point of the change in one: these
        // are the descriptions that were being dropped.
        expect(PROPOSE_TOOLS.length).toBeGreaterThanOrEqual(4);
        for (const tool of PROPOSE_TOOLS) {
            const converted = toValibotInputSchema(
                tool.name,
                tool.inputSchema as Record<string, unknown>,
            );
            const text = describedText(entriesOf(converted).items);
            expect({ tool: tool.name, hasDescription: typeof text === 'string' && text.length > 0 })
                .toEqual({ tool: tool.name, hasDescription: true });
            // And it is the tool's OWN description, not some other tool's.
            expect(text).toBe(
                ((tool.inputSchema as { properties: Record<string, { description: string }> })
                    .properties.items).description,
            );
        }
    });
});
