/**
 * The OPEN FIELDS of a bounded template — the wire shape, the save-time
 * refusal, and the projection the model is shown (#3051 step 5b).
 *
 * `parameter-constraints.ts` is the vocabulary: four `ValueConstraint` kinds,
 * `refusalForConstraint` for "is this tight enough to approve", and
 * `refusalForValue` for "may this value be dispatched". Nothing here reimplements
 * or widens any of that — this module only
 *
 *   · PARSES a stored or submitted `openFields` blob into that vocabulary,
 *   · composes the per-field refusals into a per-TEMPLATE one, and
 *   · projects a constraint into the JSON Schema the model reads.
 *
 * ── WHY A PARSER AT ALL, AND WHY IT FAILS CLOSED ────────────────────
 *
 * `openFields` is a `Json?` column, so the value coming back from Prisma is
 * `unknown` whatever was written. At the TOOL BOUNDARY that is read on the
 * dispatch path, where there is no human to show an error to and no reason to
 * guess: a blob that does not parse makes the whole parameter set unusable,
 * rather than being treated as "no open fields".
 *
 * That direction matters and the other one looks safe until you follow it.
 * Treating an unparseable blob as "no open fields" would dispatch the approved
 * exact values and refuse the model's arguments — which reads as narrower, and
 * is, for THAT call. But it also means a template whose constraints were
 * corrupted silently becomes a different, un-reviewed tool shape, and the
 * operator sees a working set. `parseOpenFields` returning `null` for "absent"
 * and throwing nothing is therefore not enough on its own; the caller has to
 * distinguish ABSENT from UNREADABLE, so this module returns a discriminated
 * result rather than a nullable one.
 */
import { z } from 'zod';

import {
    MAX_ENUM_VALUES,
    MAX_PATTERN_LENGTH,
    MAX_VALUE_LENGTH,
    refusalForConstraint,
    type ConstraintRefusal,
    type ValueConstraint,
} from './parameter-constraints';

/**
 * How many fields one template may open.
 *
 * A reviewer approves the WHOLE template in one act, so this is a bound on what
 * one such act can be asked to cover — not a storage limit. Eight is the number
 * of constraints a person can hold in their head at once while asking "is each
 * of these tight enough"; past that the review becomes a skim, which is the
 * failure mode decision 2 already accepts the risk of once.
 */
export const MAX_OPEN_FIELDS = 8;

/**
 * A field name a tool could plausibly advertise, and nothing else.
 *
 * The name goes into an advertised JSON Schema property and into the dispatched
 * argument object, so it is restricted to the identifier shape rather than
 * accepting an arbitrary string: a key like `__proto__`, `constructor`, or one
 * carrying a quote has no legitimate use here and several illegitimate ones.
 *
 * (The wording avoids the two words "as" and "any" adjacent on purpose —
 * `tests/guards/no-explicit-any-ratchet.test.ts` counts that sequence in RAW
 * source, comments included, and its cap is zero.)
 */
export const OPEN_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * Keys that are never a field name even though they match the pattern above.
 *
 * `parameterSet` is the label argument the tool boundary adds, so an open field
 * of that name would collide with it. The prototype keys are excluded because
 * the merged argument object is built with object spread, and a template is
 * written by a tenant admin.
 */
const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set([
    'parameterSet',
    '__proto__',
    'prototype',
    'constructor',
]);

const ValueConstraintSchema = z.discriminatedUnion('kind', [
    z
        .object({ kind: z.literal('regex'), pattern: z.string().min(1).max(MAX_PATTERN_LENGTH) })
        .strict(),
    z
        .object({
            kind: z.literal('enum'),
            values: z.array(z.string().max(MAX_VALUE_LENGTH)).min(1).max(MAX_ENUM_VALUES),
        })
        .strict(),
    z
        .object({ kind: z.literal('integer'), min: z.number().int(), max: z.number().int() })
        .strict(),
    z.object({ kind: z.literal('length'), min: z.number().int(), max: z.number().int() }).strict(),
]);

/**
 * The wire shape. `.strict()` on every member, so an unknown key inside a
 * constraint is a parse failure rather than a silently dropped field — a
 * `{"kind":"regex","pattern":"^a$","flags":"i"}` that quietly lost its `flags`
 * would be approved as case-sensitive and stored as something else.
 */
export const OpenFieldsSchema = z
    .record(z.string(), ValueConstraintSchema)
    .refine((o) => Object.keys(o).length >= 1, {
        message: 'An openFields object with no fields is not a template; omit it instead.',
    })
    .refine((o) => Object.keys(o).length <= MAX_OPEN_FIELDS, {
        message: `A template may open at most ${MAX_OPEN_FIELDS} fields.`,
    })
    .refine((o) => Object.keys(o).every((k) => OPEN_FIELD_NAME.test(k)), {
        message: 'An open field name must look like a tool argument name.',
    })
    .refine((o) => Object.keys(o).every((k) => !RESERVED_FIELD_NAMES.has(k)), {
        message: 'That field name is reserved by the tool boundary.',
    });

export type OpenFields = Record<string, ValueConstraint>;

/** ABSENT, READABLE, or UNREADABLE — never a nullable that conflates the last two. */
export type ParsedOpenFields =
    | { state: 'absent' }
    | { state: 'ok'; fields: OpenFields }
    | { state: 'unreadable'; detail: string };

/**
 * Read a stored `openFields` column.
 *
 * `null` and `undefined` are ABSENT — the degenerate template every row written
 * before #3051 is. Anything else that will not parse is UNREADABLE, which the
 * tool boundary must treat as "this set cannot be dispatched", not as absent.
 */
export function parseOpenFields(value: unknown): ParsedOpenFields {
    if (value === null || value === undefined) return { state: 'absent' };
    const parsed = OpenFieldsSchema.safeParse(value);
    if (!parsed.success) {
        return {
            state: 'unreadable',
            detail: parsed.error.issues
                .slice(0, 3)
                .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
                .join('; '),
        };
    }
    return { state: 'ok', fields: parsed.data as OpenFields };
}

/**
 * May this template be approved?
 *
 * Every constraint must pass `refusalForConstraint` — that module is the only
 * judge of width and this does not second-guess it — and no open field may share
 * a name with an approved exact value.
 *
 * THE COLLISION RULE IS NOT TIDINESS. The dispatched object is the exact values
 * with the validated open ones merged over them, so a field opened under the
 * name of an approved value would REPLACE that value with whatever the agent
 * chose within the bound. The approved exact value would be dead text that a
 * reviewer still reads as being in force, which is the worst of both: a
 * widening that looks like a narrowing on the screen where it is approved.
 */
export function refusalForOpenFields(
    fields: OpenFields,
    exactKeys: readonly string[],
): ConstraintRefusal | null {
    const exact = new Set(exactKeys);
    for (const [name, constraint] of Object.entries(fields)) {
        if (exact.has(name)) {
            return {
                code: 'open_field_shadows_approved_value',
                detail:
                    `"${name}" is both an approved exact value and an open field. The open value ` +
                    `is merged OVER the approved one, so the approved value would never be sent ` +
                    `while still reading as being in force. Remove it from one side.`,
            };
        }
        const refusal = refusalForConstraint(constraint);
        if (refusal) {
            // The refusal's OWN message, named by its field. `parameter-constraints`
            // writes these for the human who has to fix the pattern; rewording
            // them here would lose the half that says what to write instead.
            return {
                code: refusal.code,
                detail: `Open field "${name}": ${refusal.detail}`,
            };
        }
    }
    return null;
}

/**
 * The JSON Schema fragment the MODEL reads for one open field.
 *
 * A HINT, not a gate. `refusalForValue` is the gate, and it runs on the
 * dispatch path over the stored constraint; if the two ever disagree the model
 * gets a refusal rather than a widened call. The projection exists so a model
 * supplies something plausible on the first attempt instead of guessing.
 *
 * `maxLength` is carried on a `regex` field even though the pattern already
 * bounds it (`refusalForConstraint` refuses a pattern that matches anything
 * longer), because a length a model can see is a length it will respect.
 */
export function jsonSchemaForConstraint(constraint: ValueConstraint): Record<string, unknown> {
    switch (constraint.kind) {
        case 'regex':
            return {
                type: 'string',
                pattern: constraint.pattern,
                maxLength: MAX_VALUE_LENGTH,
            };
        case 'enum':
            return { type: 'string', enum: [...constraint.values] };
        case 'integer':
            return { type: 'integer', minimum: constraint.min, maximum: constraint.max };
        case 'length':
            return { type: 'string', minLength: constraint.min, maxLength: constraint.max };
    }
}

/** Are two constraints the same bound? Used only to decide what to ADVERTISE. */
export function sameConstraint(a: ValueConstraint, b: ValueConstraint): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'regex') return a.pattern === (b as typeof a).pattern;
    if (a.kind === 'enum') {
        const other = (b as typeof a).values;
        return a.values.length === other.length && a.values.every((v, i) => v === other[i]);
    }
    const other = b as { min: number; max: number };
    return a.min === other.min && a.max === other.max;
}
