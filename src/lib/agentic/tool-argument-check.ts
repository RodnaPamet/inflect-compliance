/**
 * Check a saved parameter set's arguments against the external tool's own
 * argument schema, BEFORE a person saves them (#4900 finding 5).
 *
 * The saved-parameters page took arguments as raw JSON and checked only that
 * the JSON parsed. The catalogue it already reads carries each tool's live
 * `inputSchema`, so a wrong argument name, a missing required one or a value of
 * the wrong type was discovered only when an agent's call reached the server
 * and failed there — after two people may have signed and approved it.
 *
 * ## What this is, and is not
 *
 * A PRE-CHECK for the person typing, not a gate. The external server still
 * validates every call, and this file never replaces that. So it is built to
 * have no false refusals: it implements a common subset of JSON Schema and
 * IGNORES every keyword it does not implement (`$ref`, `anyOf`, `oneOf`,
 * `allOf`, `if`, `format`, `patternProperties`, …) rather than guessing. A
 * property whose schema uses one of those is not checked at all. A schema that
 * does not parse, or is not an object, checks nothing.
 *
 * Pure, with no server imports, because the page is a client component.
 *
 * ## Open fields
 *
 * A field a set leaves open is filled by the agent at call time, within its
 * approved bound. So it is never reported missing, and a value typed for it is
 * not checked here: the bound, not this value, is what the call will use.
 */

export type ArgumentProblemKind =
    | 'MISSING'
    | 'UNKNOWN'
    | 'TYPE'
    | 'ENUM'
    | 'CONST'
    | 'TOO_SHORT'
    | 'TOO_LONG'
    | 'PATTERN'
    | 'TOO_SMALL'
    | 'TOO_SMALL_EXCLUSIVE'
    | 'TOO_LARGE'
    | 'TOO_LARGE_EXCLUSIVE'
    | 'TOO_FEW_ITEMS'
    | 'TOO_MANY_ITEMS';

export interface ArgumentProblem {
    readonly kind: ArgumentProblemKind;
    /** Dotted path from the top-level argument, `filter.status` or `ids[2]`. */
    readonly path: string;
    /**
     * What was expected, as data for the sentence: the allowed values, a
     * number, or a pattern. Never prose: the page words it.
     */
    readonly expected?: string;
    /** For `TYPE`: the JSON Schema type names the value should have had. */
    readonly types?: readonly string[];
}

/** One argument the tool declares, for the form's hint. */
export interface DeclaredArgument {
    readonly name: string;
    readonly required: boolean;
    /** The declared JSON Schema type names, or null when none is declared. */
    readonly types: readonly string[] | null;
}

type Schema = Record<string, unknown>;

/** Keywords whose meaning this file does not implement; their presence stops a check. */
const UNIMPLEMENTED = ['$ref', 'anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else', 'dependentSchemas'];

/** How deep nested objects and arrays are followed. Deeper values are not checked. */
const MAX_DEPTH = 5;

/** At most this many problems are reported; the first ones are what a person fixes first. */
export const MAX_ARGUMENT_PROBLEMS = 20;

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The catalogue sends `liveSchema` as pretty-printed JSON text. Anything that is
 * not a JSON object schema returns null, and null checks nothing.
 */
export function parseToolSchema(text: string | null | undefined): Schema | null {
    if (typeof text !== 'string' || text.trim() === '') return null;
    try {
        const parsed: unknown = JSON.parse(text);
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function typesOf(schema: Schema): string[] | null {
    const t = schema.type;
    if (typeof t === 'string') return [t];
    if (Array.isArray(t) && t.every((x) => typeof x === 'string')) return t as string[];
    return null;
}

function matchesType(value: unknown, type: string): boolean {
    switch (type) {
        case 'string':
            return typeof value === 'string';
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'integer':
            return typeof value === 'number' && Number.isInteger(value);
        case 'boolean':
            return typeof value === 'boolean';
        case 'null':
            return value === null;
        case 'array':
            return Array.isArray(value);
        case 'object':
            return isRecord(value);
        default:
            // A type name JSON Schema does not define: say nothing about it.
            return true;
    }
}

function render(value: unknown): string {
    return typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
}

function checkValue(
    value: unknown,
    schema: Schema,
    path: string,
    depth: number,
    out: ArgumentProblem[],
): void {
    if (out.length >= MAX_ARGUMENT_PROBLEMS) return;
    if (UNIMPLEMENTED.some((k) => k in schema)) return;

    const types = typesOf(schema);
    if (types && !types.some((type) => matchesType(value, type))) {
        out.push({ kind: 'TYPE', path, types });
        // A value of the wrong type has no length, range or properties worth
        // reporting on top of that.
        return;
    }

    if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
        out.push({ kind: 'CONST', path, expected: render(schema.const) });
        return;
    }
    if (Array.isArray(schema.enum)) {
        const allowed = schema.enum as unknown[];
        if (!allowed.some((a) => JSON.stringify(a) === JSON.stringify(value))) {
            out.push({ kind: 'ENUM', path, expected: allowed.map(render).join(', ') });
            return;
        }
    }

    if (typeof value === 'string') {
        // Lengths in code points, as JSON Schema counts them, not UTF-16 units.
        const length = [...value].length;
        if (typeof schema.minLength === 'number' && length < schema.minLength) {
            out.push({ kind: 'TOO_SHORT', path, expected: String(schema.minLength) });
        }
        if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
            out.push({ kind: 'TOO_LONG', path, expected: String(schema.maxLength) });
        }
        if (typeof schema.pattern === 'string') {
            let re: RegExp | null = null;
            try {
                // `u` because JSON Schema patterns are ECMA-262 with Unicode;
                // a pattern this engine cannot compile is not checked.
                re = new RegExp(schema.pattern, 'u');
            } catch {
                re = null;
            }
            if (re && !re.test(value)) {
                out.push({ kind: 'PATTERN', path, expected: schema.pattern });
            }
        }
    }

    if (typeof value === 'number') {
        if (typeof schema.minimum === 'number' && value < schema.minimum) {
            out.push({ kind: 'TOO_SMALL', path, expected: `${schema.minimum}` });
        }
        if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
            out.push({ kind: 'TOO_SMALL_EXCLUSIVE', path, expected: `${schema.exclusiveMinimum}` });
        }
        if (typeof schema.maximum === 'number' && value > schema.maximum) {
            out.push({ kind: 'TOO_LARGE', path, expected: `${schema.maximum}` });
        }
        if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
            out.push({ kind: 'TOO_LARGE_EXCLUSIVE', path, expected: `${schema.exclusiveMaximum}` });
        }
    }

    if (Array.isArray(value)) {
        if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
            out.push({ kind: 'TOO_FEW_ITEMS', path, expected: String(schema.minItems) });
        }
        if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
            out.push({ kind: 'TOO_MANY_ITEMS', path, expected: String(schema.maxItems) });
        }
        if (depth < MAX_DEPTH && isRecord(schema.items)) {
            const items = schema.items;
            value.forEach((item, i) => checkValue(item, items, `${path}[${i}]`, depth + 1, out));
        }
    }

    if (isRecord(value) && depth < MAX_DEPTH) {
        checkObject(value, schema, path, depth + 1, new Set(), out);
    }
}

function checkObject(
    value: Record<string, unknown>,
    schema: Schema,
    prefix: string,
    depth: number,
    open: ReadonlySet<string>,
    out: ArgumentProblem[],
): void {
    if (UNIMPLEMENTED.some((k) => k in schema)) return;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const join = (name: string) => (prefix ? `${prefix}.${name}` : name);

    if (Array.isArray(schema.required)) {
        for (const name of schema.required) {
            if (typeof name !== 'string' || open.has(name)) continue;
            if (!(name in value)) out.push({ kind: 'MISSING', path: join(name) });
        }
    }

    for (const [name, v] of Object.entries(value)) {
        if (out.length >= MAX_ARGUMENT_PROBLEMS) return;
        if (open.has(name)) continue;
        const propSchema = properties[name];
        if (isRecord(propSchema)) {
            checkValue(v, propSchema, join(name), depth, out);
        } else if (schema.additionalProperties === false) {
            // Only an explicit `false` makes an extra name wrong. Absent means
            // allowed, and a schema object for extras is not followed.
            out.push({ kind: 'UNKNOWN', path: join(name) });
        }
    }
}

/**
 * Every problem this file can see with `parameters` under `schema`, in the
 * order a person reads the form: missing names first, then each typed argument.
 * Empty when the schema is null, or uses only keywords this file ignores.
 */
export function checkToolArguments(
    parameters: Record<string, unknown>,
    schema: Schema | null,
    openFields: ReadonlyArray<string> = [],
): ArgumentProblem[] {
    if (!schema) return [];
    const out: ArgumentProblem[] = [];
    checkObject(parameters, schema, '', 0, new Set(openFields), out);
    return out.slice(0, MAX_ARGUMENT_PROBLEMS);
}

/** The top-level arguments a tool declares, required ones first, for the form's hint. */
export function declaredArguments(schema: Schema | null): DeclaredArgument[] {
    if (!schema || !isRecord(schema.properties)) return [];
    const required = new Set(
        Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : [],
    );
    return Object.entries(schema.properties)
        .map(([name, s]) => ({
            name,
            required: required.has(name),
            types: isRecord(s) ? typesOf(s) : null,
        }))
        .sort((a, b) => Number(b.required) - Number(a.required));
}
