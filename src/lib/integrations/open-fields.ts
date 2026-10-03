/**
 * The OPEN FIELDS of a bounded template — the wire shape, the save-time
 * refusal, and the projection the model is shown (#3051 steps 5b and 5c).
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
 * ── THE FIFTH KIND: `target` (#3051 step 5c) ─────────────────────────
 *
 * A fifth entry kind, `{"kind":"target"}`, says THIS argument is the one that
 * names the row. It carries no bound of its own — the bound is the named
 * population in `ExternalToolParameterSet.targetPopulation`, resolved from data
 * at dispatch — so it is a MARKER and not a `ValueConstraint`.
 *
 * WHY THE MARKER LIVES HERE AND NOT IN ITS OWN COLUMN. The target IS an open
 * field: the agent chooses its value. Everything this structure already carries
 * for a value field is exactly what a target field needs too — the advertised
 * union, the strict `argsSchema` that admits only names some set opens, the
 * "you supplied a name this set does not open" refusal, the "you left a
 * declared field out" refusal, the shadow-an-approved-value refusal, and the
 * `MAX_OPEN_FIELDS` review budget. A `targetField` column would need a second
 * branch in each of those five derivations, and a name that has to be added in
 * five places is a name that will be forgotten in one.
 *
 * The POPULATION stays a column, because "which templates name population X"
 * is the question a deploy that removes or narrows a registry entry has to
 * answer, and a scan over a JSONB blob is not an answer. So the two facts are
 * each stored exactly once: which argument, here; which population, there. A
 * database CHECK makes them agree in both directions, and `parseOpenFields`
 * fails CLOSED if they ever do not.
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
 * The STORED shape of a target marker — the kind and nothing else.
 *
 * `.strict()` matters more here than anywhere: a `{"kind":"target","population":
 * "…"}` that quietly lost its extra key would read as a target bound by the
 * column while naming something else, which is the one disagreement a reviewer
 * could not see. The population is the row's column; it is never written here.
 */
const TargetMarkerSchema = z.object({ kind: z.literal('target') }).strict();

const OpenFieldEntrySchema = z.discriminatedUnion('kind', [
    ...ValueConstraintSchema.options,
    TargetMarkerSchema,
]);

/** Count the entries that claim to be the target. */
function targetNames(o: Record<string, { kind: string }>): string[] {
    return Object.entries(o)
        .filter(([, v]) => v.kind === 'target')
        .map(([k]) => k);
}

/**
 * The wire shape. `.strict()` on every member, so an unknown key inside a
 * constraint is a parse failure rather than a silently dropped field — a
 * `{"kind":"regex","pattern":"^a$","flags":"i"}` that quietly lost its `flags`
 * would be approved as case-sensitive and stored as something else.
 */
export const OpenFieldsSchema = z
    .record(z.string(), OpenFieldEntrySchema)
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
    })
    // AT MOST ONE TARGET. The template carries ONE `targetPopulation`, so a
    // second target field would be a second row-identifier bounded by the same
    // set of values — which is not one row, and nothing downstream could say
    // which. Refused here and by a database CHECK.
    .refine((o) => targetNames(o).length <= 1, {
        message:
            'A template may mark at most one open field as the target. The target names the ' +
            'row the write is about, and a template has one target population.',
    });

/**
 * The target marker, HYDRATED with the population its row names.
 *
 * Distinct from the stored shape on purpose: everything downstream of the parse
 * needs the population beside the field (to advertise it, to compare two sets'
 * bounds, to resolve it at dispatch), and reaching back to the row at each of
 * those points is how one of them ends up reading a different row's column.
 */
export type TargetBound = { kind: 'target'; population: string };

/** One open field's bound: a typed value constraint, or the target marker. */
export type OpenFieldBound = ValueConstraint | TargetBound;

export type OpenFields = Record<string, OpenFieldBound>;

/**
 * No `targetFieldOf(fields)` helper, deliberately. The one place that needs to
 * act on the target walks every open field anyway (the dispatch loop in
 * `external-tools.ts`, which must check each declared field is supplied), so a
 * finder would be a second way to reach the same entry and an exported surface
 * with no production caller.
 */

/**
 * Does this stored `openFields` blob mark a target? Asked WITHOUT a population,
 * so a caller can decide whether a `targetPopulation` is required before it has
 * one — which is what `proposeParameterChange` needs to refuse an incoherent
 * edit with a sentence rather than a parse artefact.
 */
export function declaresTargetField(value: unknown): boolean {
    const parsed = z.record(z.string(), OpenFieldEntrySchema).safeParse(value);
    return parsed.success && targetNames(parsed.data).length > 0;
}

/** ABSENT, READABLE, or UNREADABLE — never a nullable that conflates the last two. */
export type ParsedOpenFields =
    | { state: 'absent' }
    | { state: 'ok'; fields: OpenFields }
    | { state: 'unreadable'; detail: string };

/**
 * Read a stored `openFields` column, with the row's `targetPopulation` beside it.
 *
 * `null` and `undefined` are ABSENT — the degenerate template every row written
 * before #3051 is. Anything else that will not parse is UNREADABLE, which the
 * tool boundary must treat as "this set cannot be dispatched", not as absent.
 *
 * THE TWO COLUMNS MUST AGREE, AND DISAGREEMENT IS UNREADABLE. A target marker
 * with no population has no bound at all — the agent would choose a row nobody
 * named, which is the one outcome step 5c exists to prevent. A population with
 * no marker is the mirror: harmless on its own (nothing is opened), but it means
 * the row says something about a target that the field list does not, and a
 * reviewer approved one of the two readings. Both refuse. A database CHECK makes
 * either state unreachable; this is the fail-closed reader behind it, because the
 * reader runs on the dispatch path where there is nobody to ask.
 */
export function parseOpenFields(value: unknown, targetPopulation: unknown): ParsedOpenFields {
    const population =
        typeof targetPopulation === 'string' && targetPopulation.length > 0
            ? targetPopulation
            : null;

    if (value === null || value === undefined) {
        if (population !== null) {
            return {
                state: 'unreadable',
                detail:
                    `this parameter set names target population "${population}" but opens no ` +
                    `fields, so there is no argument for that population to bound.`,
            };
        }
        return { state: 'absent' };
    }

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

    const names = targetNames(parsed.data);
    if (names.length > 0 && population === null) {
        return {
            state: 'unreadable',
            detail:
                `"${names[0]}" is marked as the target but this parameter set names no target ` +
                `population, so nothing bounds which row it may address.`,
        };
    }
    if (names.length === 0 && population !== null) {
        return {
            state: 'unreadable',
            detail:
                `this parameter set names target population "${population}" but no open field ` +
                `is marked as the target, so the population bounds nothing.`,
        };
    }

    // Hydrated here, in the one place that holds both halves.
    const fields: OpenFields = {};
    for (const [name, bound] of Object.entries(parsed.data)) {
        fields[name] =
            bound.kind === 'target'
                ? { kind: 'target', population: population as string }
                : (bound as ValueConstraint);
    }
    return { state: 'ok', fields };
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
        // A TARGET HAS NO WIDTH TO JUDGE, so `refusalForConstraint` is skipped
        // rather than given a fifth arm. Its whole subject is how much a PATTERN
        // admits; a target admits whatever the population currently returns,
        // which is not a property of this row and cannot be read off it. The
        // bound on a target is checked where it can be — the key must name a
        // registry entry (at propose time) and the value must be in the resolved
        // set (at dispatch).
        if (constraint.kind === 'target') continue;
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
export function jsonSchemaForConstraint(constraint: OpenFieldBound): Record<string, unknown> {
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
        case 'target':
            // THE POPULATION IS NOT ENUMERATED INTO THE SCHEMA, and that is the
            // point of resolving at dispatch. An `enum` of the current members
            // would be a snapshot taken when the invocation was assembled,
            // presented to the model as the live bound — so a row that left the
            // population mid-run would still look addressable, and a row that
            // joined it would look forbidden. It would also put tenant
            // identifiers into a tool listing that nothing asked to read them.
            //
            // So the model is told the SHAPE and the NAME of the bound, and
            // learns membership by being refused.
            return { type: 'string', maxLength: MAX_VALUE_LENGTH };
    }
}

/** Are two bounds the same bound? Used only to decide what to ADVERTISE. */
export function sameConstraint(a: OpenFieldBound, b: OpenFieldBound): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'regex') return a.pattern === (b as typeof a).pattern;
    if (a.kind === 'enum') {
        const other = (b as typeof a).values;
        return a.values.length === other.length && a.values.every((v, i) => v === other[i]);
    }
    // Two target fields share a bound only when they name the SAME population.
    // The population lives on the SET, so two sets can mark the same argument as
    // their target against different populations — and advertising one of them
    // would tell the model a bound that does not apply to half the labels.
    if (a.kind === 'target') return a.population === (b as typeof a).population;
    const other = b as { min: number; max: number };
    return a.min === other.min && a.max === other.max;
}
