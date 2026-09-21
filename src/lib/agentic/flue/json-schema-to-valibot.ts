/**
 * Convert this repo's MCP tool `inputSchema` (a draft-07 subset) into the
 * valibot schema an external agent runtime's `useTool` expects.
 *
 * ## Why a converter exists at all
 *
 * Our tools already declare their arguments twice, on purpose: `inputSchema`
 * is JSON Schema, which is the MCP wire format an external client reads, and
 * `argsSchema` is Zod, which is what `runReadTool` actually validates against.
 * Flue's `ToolInputSchema` is `v.GenericSchema<Record<string, unknown>, unknown>`
 * — valibot. So a third representation is unavoidable if the model is to be
 * told what a tool's arguments look like.
 *
 * It is DERIVED rather than hand-written, and that is the whole point. Ten
 * hand-written valibot schemas would be a third copy of the same facts, free to
 * drift from both of the others, and the drift would be silent — a tool whose
 * valibot schema forgot a field would simply never be called with it.
 *
 * ## What a bug in here can and cannot do
 *
 * It cannot weaken enforcement. `runReadTool` validates every call against the
 * tool's Zod `argsSchema` at step 2, after the authorization gate and before
 * the usecase, and nothing in this file is on that path. The worst a defect
 * here can do is misdescribe the arguments TO THE MODEL — which produces a
 * rejected call, not an unchecked one.
 *
 * That is a comfortable layering and it is exactly why this file is allowed to
 * be strict: there is no pressure to "just let it through".
 *
 * ## It throws rather than degrading
 *
 * Every construct this converter does not understand is a THROW, never a
 * permissive fallback. A converter that quietly emitted "any object" for a
 * schema it could not read would hand the model a tool it cannot call
 * correctly and give no signal — and the accompanying test converts all ten
 * live tools, so a new tool with a nested schema fails CI here rather than
 * shipping as a tool the model silently misuses.
 */
import * as v from 'valibot';

/** The draft-07 subset every tool in `src/lib/mcp/tools/` actually uses. */
interface JsonSchemaProperty {
    type?: unknown;
    enum?: unknown;
    minimum?: unknown;
    maximum?: unknown;
    description?: unknown;
}

export class UnsupportedToolSchemaError extends Error {
    constructor(toolName: string, detail: string) {
        super(`Cannot convert inputSchema for tool "${toolName}": ${detail}`);
        this.name = 'UnsupportedToolSchemaError';
    }
}

function scalarSchema(
    toolName: string,
    key: string,
    prop: JsonSchemaProperty,
): v.GenericSchema<unknown, unknown> {
    // An `enum` wins over `type`, because a declared enum is the narrower
    // statement and every live use of it is a set of string literals.
    if (prop.enum !== undefined) {
        if (!Array.isArray(prop.enum) || prop.enum.length === 0) {
            throw new UnsupportedToolSchemaError(toolName, `property "${key}" has an empty enum`);
        }
        if (!prop.enum.every((m) => typeof m === 'string')) {
            throw new UnsupportedToolSchemaError(
                toolName,
                `property "${key}" has a non-string enum member`,
            );
        }
        return v.picklist(prop.enum as string[]) as v.GenericSchema<unknown, unknown>;
    }

    switch (prop.type) {
        case 'string':
            return v.string() as v.GenericSchema<unknown, unknown>;
        case 'boolean':
            return v.boolean() as v.GenericSchema<unknown, unknown>;
        case 'integer': {
            // `minimum` / `maximum` are carried through when present. They are
            // advisory here — Zod re-checks them at the funnel — but a model
            // told the bound asks for a legal value first time.
            const pipe: unknown[] = [v.number(), v.integer()];
            if (typeof prop.minimum === 'number') pipe.push(v.minValue(prop.minimum));
            if (typeof prop.maximum === 'number') pipe.push(v.maxValue(prop.maximum));
            return v.pipe(
                ...(pipe as [v.GenericSchema<unknown, unknown>]),
            ) as v.GenericSchema<unknown, unknown>;
        }
        case 'number': {
            const pipe: unknown[] = [v.number()];
            if (typeof prop.minimum === 'number') pipe.push(v.minValue(prop.minimum));
            if (typeof prop.maximum === 'number') pipe.push(v.maxValue(prop.maximum));
            return v.pipe(
                ...(pipe as [v.GenericSchema<unknown, unknown>]),
            ) as v.GenericSchema<unknown, unknown>;
        }
        default:
            throw new UnsupportedToolSchemaError(
                toolName,
                `property "${key}" has unsupported type ${JSON.stringify(prop.type)}`,
            );
    }
}

/**
 * Convert one tool's `inputSchema`. Throws `UnsupportedToolSchemaError` on any
 * construct outside the subset — including a nested object, which is the one a
 * future tool is most likely to reach for.
 */
export function toValibotInputSchema(
    toolName: string,
    schema: Record<string, unknown>,
): v.GenericSchema<Record<string, unknown>, unknown> {
    if (schema.type !== 'object') {
        throw new UnsupportedToolSchemaError(
            toolName,
            `top-level type must be "object", got ${JSON.stringify(schema.type)}`,
        );
    }

    const properties = (schema.properties ?? {}) as Record<string, JsonSchemaProperty>;
    if (typeof properties !== 'object' || Array.isArray(properties)) {
        throw new UnsupportedToolSchemaError(toolName, '"properties" is not an object');
    }

    const required = new Set(
        Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === 'string') : [],
    );

    const entries: Record<string, v.GenericSchema<unknown, unknown>> = {};
    for (const [key, prop] of Object.entries(properties)) {
        if (prop === null || typeof prop !== 'object') {
            throw new UnsupportedToolSchemaError(toolName, `property "${key}" is not an object`);
        }
        // Nested objects and arrays are refused EXPLICITLY rather than falling
        // through the scalar switch's default, so the error names the real
        // reason. No live tool uses either; the first one that does should be a
        // deliberate extension of this converter, not a silent reshaping.
        if (prop.type === 'object' || prop.type === 'array') {
            throw new UnsupportedToolSchemaError(
                toolName,
                `property "${key}" is a nested ${prop.type} — extend this converter deliberately`,
            );
        }
        const scalar = scalarSchema(toolName, key, prop);
        entries[key] = required.has(key)
            ? scalar
            : (v.optional(scalar) as v.GenericSchema<unknown, unknown>);
    }

    // `additionalProperties: false` becomes a STRICT object, and getting this
    // wrong is what the cross-check against each tool's Zod schema caught.
    //
    // The first draft used `v.object` unconditionally, reasoning that the funnel
    // is the authority on what is accepted so this layer need not reject. That
    // reasoning was sound and the conclusion was still wrong: every live tool
    // declares `additionalProperties: false` AND a strict Zod schema, so a
    // permissive valibot schema told the model an invented key was fine and the
    // funnel then refused the call. Eight of ten tools disagreed on exactly
    // that input. Advertising something the enforcement layer will reject is
    // the precise failure this adapter exists to avoid — the same shape as a
    // tool being listed and then 403'd.
    //
    // So the converter now says what the JSON Schema says. Where
    // `additionalProperties` is absent, JSON Schema's own default is
    // permissive, and `v.object` matches it.
    const strict = schema.additionalProperties === false;
    const built = strict ? v.strictObject(entries) : v.object(entries);
    return built as unknown as v.GenericSchema<Record<string, unknown>, unknown>;
}
