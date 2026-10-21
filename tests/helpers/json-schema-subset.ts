/**
 * A JSON Schema validator covering EXACTLY the keywords the A2A v0.3.0
 * `AgentCard` subtree uses, and no more (#3862).
 *
 * ## Why not a dependency
 *
 * The repo has no JSON Schema validator — `ajv` is not a dependency and adding
 * one for one test means a lockfile change in a repo several sessions push to.
 * Measured on the vendored spec, the `AgentCard` subtree reaches 17 definitions
 * and uses nine keywords over four types (`array`, `boolean`, `object`,
 * `string`). That is a closed set, so implementing it is smaller than taking
 * the dependency.
 *
 * ## Why this is not "grading my own transcription"
 *
 * The constraint comes from the VENDORED SPEC BYTES, not from anything written
 * here: this module walks whatever schema it is handed. What it could get wrong
 * is being BLIND to a keyword — a schema using `oneOf` or `minItems` would be
 * silently under-checked, and an under-checking validator passes everything,
 * which reads as success. So `IMPLEMENTED_KEYWORDS` is published and
 * `collectKeywords` re-derives what the spec actually uses; the test asserts
 * the second is a subset of the first. Refresh the spec to a version that uses
 * a tenth keyword and that assertion fails, rather than the card quietly
 * ceasing to be checked.
 */

export type SchemaNode = Record<string, unknown>;

export interface SchemaViolation {
    /** JSON-pointer-ish path into the VALUE, e.g. `skills[0].tags`. */
    readonly path: string;
    readonly message: string;
}

/** The keywords this validator enforces. Anything else is not understood. */
export const IMPLEMENTED_KEYWORDS = [
    '$ref',
    'additionalProperties',
    'anyOf',
    'const',
    'enum',
    'items',
    'properties',
    'required',
    'type',
] as const;

/**
 * Keys that carry documentation rather than constraint. Skipped deliberately —
 * note `examples` is in here as a SCHEMA KEYWORD (a sample value); it is also a
 * PROPERTY NAME in `AgentSkill`, and the walk below never confuses the two
 * because property names are only ever read as keys of a `properties` object.
 */
export const ANNOTATION_KEYWORDS = ['description', 'examples', 'default', 'title', '$comment', 'deprecated'] as const;

function defsOf(root: SchemaNode): Record<string, SchemaNode> {
    return (root['definitions'] ?? root['$defs'] ?? {}) as Record<string, SchemaNode>;
}

function deref(root: SchemaNode, node: SchemaNode): SchemaNode {
    const ref = node['$ref'];
    if (typeof ref !== 'string') return node;
    const name = ref.replace(/^#\/(?:definitions|\$defs)\//, '');
    const target = defsOf(root)[name];
    if (!target) throw new Error(`Unresolvable $ref in schema: ${ref}`);
    // A $ref sits alongside nothing else in this spec, but deref defensively.
    return deref(root, target);
}

/**
 * Every schema keyword reachable from `defName`, following `$ref`. Used to
 * prove the validator's vocabulary covers the schema it is pointed at.
 */
export function collectKeywords(root: SchemaNode, defName: string): Set<string> {
    const found = new Set<string>();
    const seen = new Set<string>();
    const walk = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            node.forEach(walk);
            return;
        }
        for (const [k, v] of Object.entries(node as SchemaNode)) {
            if ((ANNOTATION_KEYWORDS as readonly string[]).includes(k)) continue;
            if (k === '$ref') {
                found.add('$ref');
                const name = String(v).replace(/^#\/(?:definitions|\$defs)\//, '');
                if (!seen.has(name)) {
                    seen.add(name);
                    walk(defsOf(root)[name]);
                }
                continue;
            }
            found.add(k);
            // `properties` maps NAMES to schemas, so descend into the values
            // only. Every other keyword's value is itself schema-shaped.
            if (k === 'properties') {
                Object.values(v as Record<string, unknown>).forEach(walk);
                continue;
            }
            if (k === 'type' || k === 'const' || k === 'enum' || k === 'required') continue;
            walk(v);
        }
    };
    const start = defsOf(root)[defName];
    if (!start) throw new Error(`No such definition: ${defName}`);
    seen.add(defName);
    walk(start);
    return found;
}

function jsonTypeOf(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    const t = typeof value;
    if (t === 'number') return Number.isInteger(value) ? 'integer' : 'number';
    return t; // 'string' | 'boolean' | 'object' | 'undefined' | ...
}

function typeMatches(expected: string, value: unknown): boolean {
    const actual = jsonTypeOf(value);
    if (expected === 'number') return actual === 'number' || actual === 'integer';
    if (expected === 'integer') return actual === 'integer';
    return actual === expected;
}

/**
 * Validate `value` against the definition `defName` of `root`.
 * Returns every violation found, empty when the value conforms.
 */
export function validateAgainstDefinition(root: SchemaNode, defName: string, value: unknown): SchemaViolation[] {
    const start = defsOf(root)[defName];
    if (!start) throw new Error(`No such definition: ${defName}`);
    const out: SchemaViolation[] = [];
    validateNode(root, start, value, '', out);
    return out;
}

function validateNode(root: SchemaNode, rawSchema: SchemaNode, value: unknown, path: string, out: SchemaViolation[]) {
    const schema = deref(root, rawSchema);

    if (Array.isArray(schema['anyOf'])) {
        const branches = schema['anyOf'] as SchemaNode[];
        const satisfied = branches.some((b) => {
            const probe: SchemaViolation[] = [];
            validateNode(root, b, value, path, probe);
            return probe.length === 0;
        });
        if (!satisfied) out.push({ path: path || '(root)', message: 'matches no anyOf branch' });
        // anyOf in this spec is the whole constraint; nothing else to check.
        return;
    }

    const type = schema['type'];
    if (typeof type === 'string' && !typeMatches(type, value)) {
        out.push({ path: path || '(root)', message: `expected type ${type}, got ${jsonTypeOf(value)}` });
        return; // Further checks would all be noise against the wrong shape.
    }

    if ('const' in schema && value !== schema['const']) {
        out.push({ path: path || '(root)', message: `expected const ${JSON.stringify(schema['const'])}` });
    }

    const enumValues = schema['enum'];
    if (Array.isArray(enumValues) && !enumValues.includes(value)) {
        out.push({ path: path || '(root)', message: `not one of ${JSON.stringify(enumValues)}` });
    }

    if (Array.isArray(schema['required']) && value && typeof value === 'object') {
        for (const key of schema['required'] as string[]) {
            if ((value as Record<string, unknown>)[key] === undefined) {
                out.push({ path: path ? `${path}.${key}` : key, message: 'required member missing' });
            }
        }
    }

    const items = schema['items'];
    if (items && Array.isArray(value)) {
        value.forEach((el, i) => validateNode(root, items as SchemaNode, el, `${path}[${i}]`, out));
    }

    const properties = (schema['properties'] ?? {}) as Record<string, SchemaNode>;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        for (const [key, sub] of Object.entries(properties)) {
            if (record[key] === undefined) continue; // absence is `required`'s business
            validateNode(root, sub, record[key], path ? `${path}.${key}` : key, out);
        }
        const additional = schema['additionalProperties'];
        if (additional === false) {
            for (const key of Object.keys(record)) {
                if (!(key in properties)) {
                    out.push({ path: path ? `${path}.${key}` : key, message: 'additional property not allowed' });
                }
            }
        } else if (additional && typeof additional === 'object') {
            for (const key of Object.keys(record)) {
                if (key in properties) continue;
                validateNode(root, additional as SchemaNode, record[key], path ? `${path}.${key}` : key, out);
            }
        }
    }
}
