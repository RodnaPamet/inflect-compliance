/**
 * THE PII FIXTURE SET — the ground truth a record is measured against
 * (Phase 0.2, G11).
 *
 * A record's rates mean something only if the spans it was scored against are
 * the ones a reviewer committed, not ones the record wrote for itself. So the
 * ground truth lives HERE, in a committed set of synthetic texts with their
 * expected spans, and `checkPiiEvaluationRecord` takes the set as an argument:
 * a record cannot be checked without it. A record whose `fixtureDigest` is not
 * this set's digest, or whose cases are not exactly this set's cases with this
 * set's spans, is `SET_MISMATCH` — so adding a hard case to the set refuses the
 * old record until somebody re-records (the skills mount gate's rule).
 *
 * The set is where support is counted, so it is where "zero is never complete"
 * is held: every D-L1-1 type needs at least `PII_MIN_SUPPORT` expected spans in
 * EVERY D-L1-1 locale, and every case kind must appear. A set of one span per
 * type would make a 0.95 recall floor read "1 of 1".
 *
 * PURE: no file reads (that is `./mount.ts`).
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { canonicalJson } from '@/lib/canonical-json';

import { PII_ENTITY_TYPES, PII_LOCALES, type PiiEntityType, type PiiLocale } from './entities';

export const PII_FIXTURE_SET_SCHEMA_ID = 'inflect-pii-fixtures/1';

/**
 * The four case kinds, all required (the house shape: a set that only has the
 * happy path measures the happy path).
 *
 *   positive      text carrying in-scope PII, with its spans
 *   negative      ordinary text with none — the false-positive check
 *   near-miss     lookalikes that are NOT PII: an ЕГН with a bad checksum, a
 *                 10-digit invoice number, an IBAN-shaped reference
 *   mixed-script  Latin and Cyrillic in one text, the BG product's normal case
 */
export const PII_CASE_KINDS = ['positive', 'negative', 'near-miss', 'mixed-script'] as const;
export type PiiCaseKind = (typeof PII_CASE_KINDS)[number];

/**
 * Expected spans per type per locale, at least. PROPOSED (2026-11-12) beside
 * the floors, not yet initialled: at 20, a 0.95 recall floor tolerates one
 * miss, so the floor is a measurement rather than "all of a handful".
 */
export const PII_MIN_SUPPORT = 20;

export const PiiSpanSchema = z
    .object({
        type: z.enum(PII_ENTITY_TYPES),
        start: z.number().int().min(0),
        end: z.number().int().min(1),
    })
    .strict()
    .refine((s) => s.start < s.end, { message: 'span start must precede end' });

/** A case kind that carries PII expects spans; the other two expect none. */
export function kindExpectsSpans(kind: PiiCaseKind): boolean {
    return kind === 'positive' || kind === 'mixed-script';
}

const FixtureCaseSchema = z
    .object({
        caseId: z.string().min(1),
        locale: z.enum(PII_LOCALES),
        kind: z.enum(PII_CASE_KINDS),
        /** Synthetic, generated text. No real person is named in a fixture. */
        text: z.string().min(1),
        /** UTF-16 offsets into `text`. */
        expected: z.array(PiiSpanSchema),
    })
    .strict();

export const PiiFixtureSetSchema = z
    .object({
        schema: z.literal(PII_FIXTURE_SET_SCHEMA_ID),
        cases: z.array(FixtureCaseSchema).min(PII_CASE_KINDS.length),
    })
    .strict();

export type PiiFixtureSet = z.infer<typeof PiiFixtureSetSchema>;
export type PiiFixtureCase = PiiFixtureSet['cases'][number];

export type PiiFixtureSetRefusal =
    | 'SET_MALFORMED'
    | 'SET_DUPLICATE_CASE'
    | 'SET_SPAN_OUT_OF_RANGE'
    | 'SET_MISSING_KIND'
    | 'SET_LOW_SUPPORT';

export type PiiFixtureSetCheck =
    | { readonly ok: true; readonly set: PiiFixtureSet; readonly digest: string }
    | { readonly ok: false; readonly reason: PiiFixtureSetRefusal; readonly detail: string };

/** `sha256:` over the set's canonical JSON — what a record's `fixtureDigest` must equal. */
export function piiFixtureDigest(set: PiiFixtureSet): string {
    return `sha256:${createHash('sha256').update(canonicalJson(set), 'utf8').digest('hex')}`;
}

export function checkPiiFixtureSet(raw: unknown): PiiFixtureSetCheck {
    const parsed = PiiFixtureSetSchema.safeParse(raw);
    if (!parsed.success) {
        return { ok: false, reason: 'SET_MALFORMED', detail: parsed.error.issues.map((i) => i.message).join('; ') };
    }
    const set = parsed.data;

    const ids = new Set<string>();
    const support = {} as Record<PiiLocale, Record<PiiEntityType, number>>;
    for (const l of PII_LOCALES) {
        support[l] = {} as Record<PiiEntityType, number>;
        for (const t of PII_ENTITY_TYPES) support[l][t] = 0;
    }
    for (const c of set.cases) {
        if (ids.has(c.caseId)) return { ok: false, reason: 'SET_DUPLICATE_CASE', detail: c.caseId };
        ids.add(c.caseId);
        if (kindExpectsSpans(c.kind) !== c.expected.length > 0) {
            const want = kindExpectsSpans(c.kind) ? 'at least one span' : 'no span';
            return { ok: false, reason: 'SET_MALFORMED', detail: `${c.kind} case ${c.caseId} must expect ${want}` };
        }
        for (const s of c.expected) {
            if (s.end > c.text.length) {
                return { ok: false, reason: 'SET_SPAN_OUT_OF_RANGE', detail: `${c.caseId} ${s.type} ${s.start}-${s.end} past ${c.text.length}` };
            }
            support[c.locale][s.type] += 1;
        }
    }
    for (const kind of PII_CASE_KINDS) {
        if (!set.cases.some((c) => c.kind === kind)) return { ok: false, reason: 'SET_MISSING_KIND', detail: `no ${kind} case` };
    }
    const thin: string[] = [];
    for (const l of PII_LOCALES) {
        for (const t of PII_ENTITY_TYPES) {
            if (support[l][t] < PII_MIN_SUPPORT) thin.push(`${t}/${l} ${support[l][t]}`);
        }
    }
    if (thin.length > 0) return { ok: false, reason: 'SET_LOW_SUPPORT', detail: `below ${PII_MIN_SUPPORT}: ${thin.join(', ')}` };

    return { ok: true, set, digest: piiFixtureDigest(set) };
}
