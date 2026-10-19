/**
 * ONE PERIOD'S WORKPAPERS, AS A READER IS SHOWN THEM (#3749).
 *
 * The shape `list_audit_workpapers` returns: what each workpaper of a period
 * records, bounded, as codes, identifiers, counts and digests. It is what the
 * auditor workflow reads to explain a period's work, so it carries what a
 * narrative needs and no more.
 *
 *   • BOUNDED. At most `MAX_WORKPAPERS_PER_PERIOD_READ` workpapers, oldest
 *     first, with `truncated` set when there were more. Per workpaper, the
 *     outcomes as counts, the exceptions as counts per code, and the first
 *     `MAX_EXCEPTIONS_SHOWN` exceptions in full — a population can hold
 *     thousands, and the reader needs the shape of them, not every one.
 *   • RE-VALIDATED. The per-unit columns are JSON, and a JSON column is not a
 *     type: each is read back against the shape the recorder enforced, and one
 *     that no longer passes is `null` and named in `unreadable`, never read as
 *     "no exceptions".
 *   • NO PERSON. The reviewer's user id is left out (`reviewed` says whether
 *     the stamp is set), as are the evidence and proposal ids.
 *
 * PURE: no database.
 */
import { z } from 'zod';

import { CODE, ITEM_OUTCOMES, UNIT_ID } from './audit-workpaper';

/** The most workpapers one read returns for a period. */
export const MAX_WORKPAPERS_PER_PERIOD_READ = 50;
/** The most exceptions shown in full per workpaper; the rest are counted. */
export const MAX_EXCEPTIONS_SHOWN = 50;

const code = z.string().regex(CODE);
const unitId = z.string().regex(UNIT_ID);

const StoredOutcomesSchema = z.array(
    z.object({ unitId, outcome: z.enum(ITEM_OUTCOMES), code: code.nullable() }).strict(),
);
const StoredExceptionsSchema = z.array(
    z.object({ unitId: unitId.nullable(), code, proposalId: unitId.optional() }).strict(),
);
const StoredParametersSchema = z.record(
    z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/),
    z.union([z.number().finite(), z.boolean(), code]),
);

/** The stored row the view is built from: `AuditWorkpaperRepository.listForPeriod`'s select. */
export interface StoredWorkpaperRow {
    readonly id: string;
    readonly procedureId: string;
    readonly catalogueVersion: number;
    readonly periodLabel: string;
    readonly populationDefinition: string;
    readonly populationCount: number;
    readonly populationDigest: string;
    readonly sampleSize: number | null;
    readonly parametersJson: unknown;
    readonly attributesTested: readonly string[];
    readonly itemOutcomesJson: unknown;
    readonly exceptionsJson: unknown;
    readonly exceptionCount: number;
    readonly conclusion: string;
    readonly conclusionBasis: string;
    readonly auditorAgentId: string;
    readonly reviewedAt: Date | null;
    readonly createdAt: Date;
}

export interface WorkpaperView {
    readonly workpaperId: string;
    readonly procedureId: string;
    readonly catalogueVersion: number;
    readonly periodLabel: string;
    readonly populationDefinition: string;
    readonly populationCount: number;
    readonly populationDigest: string;
    /** `null` when a precondition stopped the run before a sample was drawn. */
    readonly sampleSize: number | null;
    readonly attributesTested: readonly string[];
    /** `null` when none was set, or when the stored value is unreadable. */
    readonly parameters: Readonly<Record<string, number | boolean | string>> | null;
    /** Sampled units by outcome. */
    readonly outcomes: { readonly PASS: number; readonly EXCEPTION: number; readonly UNTESTABLE: number } | null;
    readonly exceptionCount: number;
    /** Exceptions per code, most frequent first. */
    readonly exceptionCodes: ReadonlyArray<{ readonly code: string; readonly count: number }> | null;
    /** The first `MAX_EXCEPTIONS_SHOWN` exceptions, in recorded order. */
    readonly exceptions: ReadonlyArray<{ readonly unitId: string | null; readonly code: string }> | null;
    readonly conclusion: string;
    readonly conclusionBasis: string;
    readonly auditorAgentId: string;
    /** Whether the second or third line has stamped it reviewed. */
    readonly reviewed: boolean;
    readonly createdAt: string;
    /** The members whose stored value did not re-validate, so read `null`. */
    readonly unreadable: readonly string[];
}

export interface PeriodWorkpapersView {
    readonly periodLabel: string;
    readonly workpapers: readonly WorkpaperView[];
    /** More workpapers exist for the period than one read returns. */
    readonly truncated: boolean;
}

export function toWorkpaperView(row: StoredWorkpaperRow): WorkpaperView {
    const unreadable: string[] = [];

    let parameters: WorkpaperView['parameters'] = null;
    if (row.parametersJson !== null && row.parametersJson !== undefined) {
        const parsed = StoredParametersSchema.safeParse(row.parametersJson);
        if (parsed.success) parameters = parsed.data;
        else unreadable.push('parameters');
    }

    let outcomes: WorkpaperView['outcomes'] = null;
    const outcomeRows = StoredOutcomesSchema.safeParse(row.itemOutcomesJson);
    if (outcomeRows.success) {
        const count = (o: (typeof ITEM_OUTCOMES)[number]) => outcomeRows.data.filter((r) => r.outcome === o).length;
        outcomes = { PASS: count('PASS'), EXCEPTION: count('EXCEPTION'), UNTESTABLE: count('UNTESTABLE') };
    } else {
        unreadable.push('outcomes');
    }

    let exceptionCodes: WorkpaperView['exceptionCodes'] = null;
    let exceptions: WorkpaperView['exceptions'] = null;
    const exceptionRows = StoredExceptionsSchema.safeParse(row.exceptionsJson);
    if (exceptionRows.success) {
        const byCode = new Map<string, number>();
        for (const e of exceptionRows.data) byCode.set(e.code, (byCode.get(e.code) ?? 0) + 1);
        exceptionCodes = [...byCode.entries()]
            .map(([c, count]) => ({ code: c, count }))
            .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
        exceptions = exceptionRows.data.slice(0, MAX_EXCEPTIONS_SHOWN).map((e) => ({ unitId: e.unitId, code: e.code }));
    } else {
        unreadable.push('exceptionCodes', 'exceptions');
    }

    return {
        workpaperId: row.id,
        procedureId: row.procedureId,
        catalogueVersion: row.catalogueVersion,
        periodLabel: row.periodLabel,
        populationDefinition: row.populationDefinition,
        populationCount: row.populationCount,
        populationDigest: row.populationDigest,
        sampleSize: row.sampleSize,
        attributesTested: [...row.attributesTested],
        parameters,
        outcomes,
        exceptionCount: row.exceptionCount,
        exceptionCodes,
        exceptions,
        conclusion: row.conclusion,
        conclusionBasis: row.conclusionBasis,
        auditorAgentId: row.auditorAgentId,
        reviewed: row.reviewedAt !== null,
        createdAt: row.createdAt.toISOString(),
        unreadable,
    };
}
