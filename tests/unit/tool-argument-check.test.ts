/**
 * The saved-parameters pre-check (#4900 finding 5): what it reports, and —
 * as much as that — what it refuses to have an opinion about. A false refusal
 * here would stop a person saving arguments the server accepts.
 */
import {
    checkToolArguments,
    declaredArguments,
    MAX_ARGUMENT_PROBLEMS,
    parseToolSchema,
} from '@/lib/agentic/tool-argument-check';

const schema = {
    type: 'object',
    properties: {
        role: { type: 'string', enum: ['reader', 'writer'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        note: { type: ['string', 'null'], maxLength: 5 },
        code: { type: 'string', pattern: '^[A-Z]{3}$' },
        filter: {
            type: 'object',
            properties: { status: { type: 'string', enum: ['open', 'closed'] } },
            additionalProperties: false,
        },
        ids: { type: 'array', items: { type: 'integer' }, maxItems: 3 },
    },
    required: ['role', 'limit'],
    additionalProperties: false,
};

describe('checkToolArguments', () => {
    it('passes arguments the schema accepts', () => {
        expect(
            checkToolArguments(
                { role: 'reader', limit: 10, note: null, code: 'ABC', filter: { status: 'open' }, ids: [1, 2] },
                schema,
            ),
        ).toEqual([]);
    });

    it('checks nothing without a schema', () => {
        expect(checkToolArguments({ anything: 1 }, null)).toEqual([]);
    });

    it('names a required argument that is missing, and an unknown one', () => {
        expect(checkToolArguments({ role: 'reader', extra: true }, schema)).toEqual([
            { kind: 'MISSING', path: 'limit' },
            { kind: 'UNKNOWN', path: 'extra' },
        ]);
    });

    it('never reports an open field missing, and does not check a value typed for one', () => {
        expect(checkToolArguments({ role: 'reader', limit: 'not a number' }, schema, ['limit'])).toEqual([]);
    });

    it('allows extra names unless the schema says additionalProperties: false', () => {
        const loose = { type: 'object', properties: { a: { type: 'string' } } };
        expect(checkToolArguments({ a: 'x', b: 1 }, loose)).toEqual([]);
    });

    it('reports the wrong type with the types expected, and nothing more about that value', () => {
        expect(checkToolArguments({ role: 'reader', limit: 1.5 }, schema)).toEqual([
            { kind: 'TYPE', path: 'limit', types: ['integer'] },
        ]);
        expect(checkToolArguments({ role: 'reader', limit: 1, note: 7 }, schema)).toEqual([
            { kind: 'TYPE', path: 'note', types: ['string', 'null'] },
        ]);
    });

    it('reports a value outside the allowed list, with the list', () => {
        expect(checkToolArguments({ role: 'admin', limit: 1 }, schema)).toEqual([
            { kind: 'ENUM', path: 'role', expected: '"reader", "writer"' },
        ]);
    });

    it('checks const', () => {
        expect(
            checkToolArguments({ v: 2 }, { type: 'object', properties: { v: { const: 1 } } }),
        ).toEqual([{ kind: 'CONST', path: 'v', expected: '1' }]);
    });

    it('checks string length in code points, and the pattern', () => {
        // Five emoji are five characters to JSON Schema, ten UTF-16 units.
        expect(checkToolArguments({ role: 'reader', limit: 1, note: '😀😀😀😀😀' }, schema)).toEqual([]);
        expect(checkToolArguments({ role: 'reader', limit: 1, note: 'toolong' }, schema)).toEqual([
            { kind: 'TOO_LONG', path: 'note', expected: '5' },
        ]);
        expect(checkToolArguments({ role: 'reader', limit: 1, code: 'abc' }, schema)).toEqual([
            { kind: 'PATTERN', path: 'code', expected: '^[A-Z]{3}$' },
        ]);
    });

    it('does not check a pattern it cannot compile', () => {
        const odd = { type: 'object', properties: { p: { type: 'string', pattern: '(?<' } } };
        expect(checkToolArguments({ p: 'anything' }, odd)).toEqual([]);
    });

    it('checks inclusive and exclusive number bounds as different statements', () => {
        expect(checkToolArguments({ role: 'reader', limit: 0 }, schema)).toEqual([
            { kind: 'TOO_SMALL', path: 'limit', expected: '1' },
        ]);
        expect(checkToolArguments({ role: 'reader', limit: 101 }, schema)).toEqual([
            { kind: 'TOO_LARGE', path: 'limit', expected: '100' },
        ]);
        const exclusive = { type: 'object', properties: { n: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 } } };
        expect(checkToolArguments({ n: 0 }, exclusive)).toEqual([
            { kind: 'TOO_SMALL_EXCLUSIVE', path: 'n', expected: '0' },
        ]);
        expect(checkToolArguments({ n: 1 }, exclusive)).toEqual([
            { kind: 'TOO_LARGE_EXCLUSIVE', path: 'n', expected: '1' },
        ]);
    });

    it('follows nested objects and array items, naming the path', () => {
        expect(
            checkToolArguments(
                { role: 'reader', limit: 1, filter: { status: 'pending', other: 1 }, ids: [1, 'two', 3, 4] },
                schema,
            ),
        ).toEqual([
            { kind: 'ENUM', path: 'filter.status', expected: '"open", "closed"' },
            { kind: 'UNKNOWN', path: 'filter.other' },
            { kind: 'TOO_MANY_ITEMS', path: 'ids', expected: '3' },
            { kind: 'TYPE', path: 'ids[1]', types: ['integer'] },
        ]);
    });

    it('stays silent on keywords it does not implement, rather than guessing', () => {
        const composite = {
            type: 'object',
            properties: { a: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
            required: ['a'],
        };
        expect(checkToolArguments({ a: true }, composite)).toEqual([]);
        expect(checkToolArguments({ a: true }, { $ref: '#/defs/x' })).toEqual([]);
    });

    it('caps how many problems it reports', () => {
        const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]));
        const problems = checkToolArguments(many, { type: 'object', properties: {}, additionalProperties: false });
        expect(problems).toHaveLength(MAX_ARGUMENT_PROBLEMS);
    });
});

describe('parseToolSchema', () => {
    it('reads the catalogue text, and returns null for anything that is not an object schema', () => {
        expect(parseToolSchema(JSON.stringify(schema, null, 2))).toEqual(schema);
        expect(parseToolSchema('{ not json')).toBeNull();
        expect(parseToolSchema('[]')).toBeNull();
        expect(parseToolSchema('')).toBeNull();
        expect(parseToolSchema(undefined)).toBeNull();
    });
});

describe('declaredArguments', () => {
    it('lists the arguments, required ones first, with their types', () => {
        const args = declaredArguments(schema);
        expect(args.slice(0, 2)).toEqual([
            { name: 'role', required: true, types: ['string'] },
            { name: 'limit', required: true, types: ['integer'] },
        ]);
        expect(args.find((a) => a.name === 'note')).toEqual({
            name: 'note',
            required: false,
            types: ['string', 'null'],
        });
        expect(declaredArguments(null)).toEqual([]);
        expect(declaredArguments({ type: 'object' })).toEqual([]);
    });
});
