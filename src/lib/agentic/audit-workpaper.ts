/**
 * THE AUDIT WORKPAPER CONTRACT (#3675, step 3b) — what an auditor agent may
 * store as one workpaper, as `docs/agentic-audit-procedures.md` defines it
 * ("What a workpaper records", "How every procedure runs").
 *
 * Pure: the record usecase (`src/app-layer/usecases/audit-workpaper.ts`) parses
 * through `RecordAuditWorkpaperSchema` and asks the questions here; the
 * migration's CHECKs and triggers pin the same shapes below it.
 *
 * Four rules the shapes carry:
 *
 *  • EVERY FACT IS A CODE, AN IDENTIFIER OR A COUNT. A unit id matches
 *    `UNIT_ID`, which admits no space, no `@` and no `.` — so it cannot carry a
 *    name or an e-mail address — and every outcome, exception and basis is an
 *    upper-case code. The one text field, `populationDefinition`, is the
 *    catalogue's own definition.
 *  • ZERO IS NEVER COMPLETE. A PASS needs a non-empty population, a drawn
 *    sample, an outcome for every sampled unit, every outcome PASS and no
 *    exception — `populationCount > 0 && tested === sampleSize &&
 *    exceptions === 0`, never `exceptions === 0` alone, which is also true of
 *    nothing. A FAIL names an exception.
 *  • THE EPOCH IS FIXED BY THE PERIOD. `<procedureId>@<periodLabel>`, or that
 *    followed by `/<sub-population>`; never the run date.
 *  • A PERIOD THAT HAS NOT ENDED IS NOT AUDITED. Such a workpaper can only be
 *    INCONCLUSIVE on `PERIOD_OPEN`, with no sample.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

/** The catalogue version this build implements (docs/agentic-audit-procedures.md). */
export const AUDIT_PROCEDURE_CATALOGUE_VERSION = 1;

/**
 * The eight procedure ids of catalogue version 1. A procedure id is never
 * renamed and never reused, so this list only grows.
 */
export const AUDIT_PROCEDURE_IDS = [
    'iam.leaver_timeliness',
    'iam.recertification_completeness',
    'iam.time_bounded_access_expiry',
    'iam.privileged_access',
    'agent.authority_conformance',
    'agent.stop_control',
    'agent.approval_quality',
    'assurance.evidence_sufficiency',
] as const;
export type AuditProcedureId = (typeof AUDIT_PROCEDURE_IDS)[number];

/** `YYYY-MM` (a UTC month) or `YYYY-Qn` (a UTC quarter). */
export const PERIOD_LABEL = /^(\d{4})-(0[1-9]|1[0-2]|Q[1-4])$/;
/** An outcome, exception, attribute or basis code. */
export const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** A unit or record identifier: no space, `@` or `.`, so never a name or an address. */
export const UNIT_ID = /^[A-Za-z0-9_:-]{1,128}$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The most units a population read keeps, and therefore the largest sample (MAX_SUBJECTS). */
export const MAX_POPULATION_UNITS = 5000;

export const ITEM_OUTCOMES = ['PASS', 'EXCEPTION', 'UNTESTABLE'] as const;
export const WORKPAPER_CONCLUSIONS = ['PASS', 'FAIL', 'INCONCLUSIVE'] as const;

/** The start (inclusive) and end (exclusive) of a period, in UTC. */
export function periodBounds(label: string): { start: Date; end: Date } {
    const m = PERIOD_LABEL.exec(label);
    if (!m) throw new Error(`not a period label: ${label}`);
    const year = Number(m[1]);
    if (m[2].startsWith('Q')) {
        const q = Number(m[2].slice(1));
        return {
            start: new Date(Date.UTC(year, (q - 1) * 3, 1)),
            end: new Date(Date.UTC(year, q * 3, 1)),
        };
    }
    const month = Number(m[2]);
    return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
}

/** A procedure runs only for a period that has ended. */
export function periodHasEnded(label: string, now: Date): boolean {
    return periodBounds(label).end.getTime() <= now.getTime();
}

/** The epoch a sample of this procedure and period is drawn with. */
export function sampleEpochFor(procedureId: string, periodLabel: string, subPopulation?: string): string {
    const base = `${procedureId}@${periodLabel}`;
    return subPopulation ? `${base}/${subPopulation}` : base;
}

/** Is `epoch` an epoch of this procedure and period (the base, or a sub-population of it)? */
export function isEpochOf(epoch: string, procedureId: string, periodLabel: string): boolean {
    const base = sampleEpochFor(procedureId, periodLabel);
    return epoch === base || (epoch.startsWith(`${base}/`) && epoch.length > base.length + 1);
}

/**
 * The frozen population's digest: SHA-256 over the procedure id, the period
 * label and the SORTED unit ids, one per line. Sorted here, so a caller cannot
 * produce two digests for one population by handing the ids over in another
 * order.
 */
export function populationDigest(procedureId: string, periodLabel: string, unitIds: readonly string[]): string {
    const lines = [procedureId, periodLabel, ...[...unitIds].sort()];
    return createHash('sha256').update(lines.join('\n') + '\n', 'utf8').digest('hex');
}

const code = z.string().regex(CODE, 'must be an upper-case code');
const unitId = z.string().regex(UNIT_ID, 'must be an identifier');
const recordId = z.string().regex(UNIT_ID, 'must be an identifier');

const ParameterValue = z.union([z.number().finite(), z.boolean(), code]);

const SampleSchema = z
    .object({
        epoch: z.string().min(1).max(200),
        seedFingerprint: z.string().regex(SHA256_HEX, 'must be a SHA-256 hex digest'),
        sampledUnitIds: z.array(unitId).min(1).max(MAX_POPULATION_UNITS),
    })
    .strict();

/**
 * The input of `recordAuditWorkpaper`. `.strict()` everywhere: an undeclared
 * key — a `reviewedAt`, a free-text `summary` — is a 400, never silently
 * dropped, because a workpaper that quietly lost a field it was sent is a
 * record of something other than what the auditor wrote.
 */
export const RecordAuditWorkpaperSchema = z
    .object({
        procedureId: z.enum(AUDIT_PROCEDURE_IDS),
        catalogueVersion: z.number().int().min(1).max(AUDIT_PROCEDURE_CATALOGUE_VERSION),
        periodLabel: z.string().regex(PERIOD_LABEL, 'must be YYYY-MM or YYYY-Qn'),
        populationDefinition: z.string().trim().min(1).max(2000),
        populationCount: z.number().int().min(0),
        populationDigest: z.string().regex(SHA256_HEX, 'must be a SHA-256 hex digest'),
        sample: SampleSchema.nullable(),
        parameters: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/), ParameterValue).optional(),
        attributesTested: z.array(code).max(64),
        itemOutcomes: z
            .array(z.object({ unitId, outcome: z.enum(ITEM_OUTCOMES), code: code.nullable() }).strict())
            .max(MAX_POPULATION_UNITS),
        exceptions: z
            .array(z.object({ unitId: unitId.nullable(), code }).strict())
            .max(MAX_POPULATION_UNITS * 4),
        conclusion: z.enum(WORKPAPER_CONCLUSIONS),
        conclusionBasis: code,
        evidenceRefs: z.array(recordId).max(200),
        proposalIds: z.array(recordId).max(MAX_POPULATION_UNITS),
        findingIds: z.array(recordId).max(MAX_POPULATION_UNITS).optional(),
        auditorAgentId: recordId,
        controlTestRunId: recordId,
    })
    .strict()
    .superRefine((v, ctx) => {
        const issue = (path: (string | number)[], message: string) =>
            ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

        const sampled = v.sample?.sampledUnitIds ?? [];
        if (v.sample) {
            if (!isEpochOf(v.sample.epoch, v.procedureId, v.periodLabel)) {
                issue(['sample', 'epoch'], 'the epoch is <procedureId>@<periodLabel>, fixed by the period');
            }
            if (new Set(sampled).size !== sampled.length) {
                issue(['sample', 'sampledUnitIds'], 'a unit is sampled at most once');
            }
            if (sampled.length > v.populationCount) {
                issue(['sample', 'sampledUnitIds'], 'a sample cannot be larger than its population');
            }
        }

        const inSample = new Set(sampled);
        const seen = new Set<string>();
        v.itemOutcomes.forEach((o, i) => {
            if (!inSample.has(o.unitId)) issue(['itemOutcomes', i, 'unitId'], 'an outcome is for a sampled unit');
            if (seen.has(o.unitId)) issue(['itemOutcomes', i, 'unitId'], 'one outcome per sampled unit');
            seen.add(o.unitId);
            if (o.outcome !== 'PASS' && o.code === null) {
                issue(['itemOutcomes', i, 'code'], 'an EXCEPTION or UNTESTABLE outcome names its code');
            }
        });

        if (v.conclusion === 'PASS') {
            const allTested = v.sample !== null && seen.size === sampled.length;
            const allPassed = v.itemOutcomes.every((o) => o.outcome === 'PASS');
            if (!(v.populationCount > 0 && allTested && allPassed && v.exceptions.length === 0)) {
                issue(
                    ['conclusion'],
                    'a PASS needs a non-empty population, an outcome for every sampled unit, every one ' +
                        'PASS, and no exception — an empty population can never pass',
                );
            }
        }
        if (v.conclusion === 'FAIL' && v.exceptions.length === 0) {
            issue(['conclusion'], 'a FAIL names at least one exception');
        }
    });

export type RecordAuditWorkpaperInput = z.infer<typeof RecordAuditWorkpaperSchema>;

/**
 * The named reasons the workpaper seam refuses with a 409, carried as
 * `details.reason`. A caller who is not the auditor (for a write) or not a
 * person (for the stamp) is a 403 instead, which carries no details.
 */
export type AuditWorkpaperRefusal =
    | 'AUDITOR_NOT_FOUND'
    | 'NOT_AN_AUDITOR'
    | 'AUDITOR_NOT_ACTIVE'
    | 'AUDITOR_NOT_INDEPENDENT'
    | 'PERIOD_OPEN'
    | 'RUN_NOT_FOUND'
    | 'EVIDENCE_NOT_FOUND'
    | 'PROPOSAL_NOT_FOUND'
    | 'FINDING_NOT_FOUND'
    | 'SAMPLE_NOT_BINDING'
    | 'REVIEWER_NOT_ACTIVE_MEMBER'
    | 'REVIEWER_LINE_UNDECLARED'
    | 'REVIEWER_LINE_NOT_ELIGIBLE'
    | 'REVIEWER_OWNS_AUDITOR'
    | 'ALREADY_REVIEWED';

/** The SQLSTATE P0001 message prefixes the workpaper triggers raise. */
export const AUDIT_WORKPAPER_DB_REFUSALS = {
    authorNotAuditor: 'AUDIT_WORKPAPER_AUTHOR_NOT_AUDITOR',
    bornReviewed: 'AUDIT_WORKPAPER_BORN_REVIEWED',
    sampleNotBinding: 'AUDIT_WORKPAPER_SAMPLE_NOT_BINDING',
    immutable: 'IMMUTABLE_AUDIT_WORKPAPER',
    reviewImmutable: 'IMMUTABLE_AUDIT_WORKPAPER_REVIEW',
    linkImmutable: 'IMMUTABLE_AUDIT_WORKPAPER_FINDING',
    linkNotInTenant: 'AUDIT_WORKPAPER_FINDING_NOT_IN_TENANT',
} as const;

/**
 * Does a later run's sample reuse the binding one? The first sample drawn for a
 * procedure and period fixes the epoch, the seed fingerprint and the sampled
 * ids — in order, since the stored list is the record of the draw.
 */
export function sampleMatchesBinding(
    sample: { epoch: string; seedFingerprint: string; sampledUnitIds: readonly string[] },
    binding: { sampleEpoch: string; seedFingerprint: string; sampledUnitIds: readonly string[] },
): boolean {
    return (
        sample.epoch === binding.sampleEpoch &&
        sample.seedFingerprint === binding.seedFingerprint &&
        sample.sampledUnitIds.length === binding.sampledUnitIds.length &&
        sample.sampledUnitIds.every((id, i) => id === binding.sampledUnitIds[i])
    );
}
