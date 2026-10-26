/**
 * AUDIT PROCEDURE LIBRARY v1 — the five procedures the auditor agent runs
 * (#3676, step 3c; `docs/agentic-audit-procedures.md`, procedures 1 to 5).
 *
 * Pure: no database, no key, no server import. The handlers in
 * `src/app-layer/services/audit-procedures/` read the raw rows and ask the
 * questions here, so every rule below is unit-tested without a tenant.
 *
 * ── LIBRARY v1 IS PROPOSED, NOT APPROVED ────────────────────────────────────
 *
 * The repository owner's merge adopted catalogue version 1 for this repository.
 * Internal audit's approval and the managed-service provider's agreement of it
 * are OPEN, and so is each procedure's provider methodology reference: each is
 * recorded on issue #3663 when given. `LIBRARY_V1_STATUS` says so in code, and every finding proposal and
 * every evidence row the handlers write carries that status, so nothing a
 * person reads presents the library as approved. Changing a value there is a
 * claim about an external party's act; it belongs in the pull request that
 * records the act on #3663, never in a tidy-up.
 *
 * ── FOUR RULES THE SHAPES CARRY ─────────────────────────────────────────────
 *
 *  • ZERO IS NEVER COMPLETE. `decideConclusion` writes a PASS only as
 *    `populationCount > 0 && tested === sampleSize && exceptions === 0`, never
 *    as `exceptions === 0` alone, which is also true of nothing.
 *  • THE ORDER IS THE CATALOGUE'S. A failed precondition is INCONCLUSIVE with
 *    no sample; then an exception anywhere is a FAIL; then an untestable unit
 *    is INCONCLUSIVE; and only then a PASS.
 *  • THE SAMPLE IS REPRODUCIBLE FROM ITS EPOCH. `drawAuditSample` is the ASI09
 *    sampler unchanged (`proposal-sampling.ts`): the same seed, epoch and
 *    frozen ids always give the same sample, because the sampler breaks ties on
 *    the unit id. The seed is keyed per tenant and never stored; the workpaper
 *    stores its fingerprint.
 *  • THE AUDITOR READS AND PROPOSES, NEVER CHANGES. `AUDITOR_TOOL_REMIT` is
 *    every built-in read tool and `propose_finding`, and nothing else — no other
 *    propose tool and no external tool.
 */
import { createHmac } from 'node:crypto';

import { MCP_READ_TOOL_NAMES } from '@/lib/mcp/tool-catalogue';

import { PERIOD_LABEL, periodBounds } from './audit-workpaper';
import { sampleSizeFor, selectSample } from './proposal-sampling';

// ─── The library ────────────────────────────────────────────────────────────

/** Procedures 1 to 5 of catalogue version 1: library v1. */
export const LIBRARY_V1_PROCEDURE_IDS = [
    'iam.leaver_timeliness',
    'iam.recertification_completeness',
    'iam.time_bounded_access_expiry',
    'iam.privileged_access',
    'agent.authority_conformance',
] as const;
export type LibraryV1ProcedureId = (typeof LIBRARY_V1_PROCEDURE_IDS)[number];

export function isLibraryV1Procedure(id: string): id is LibraryV1ProcedureId {
    return (LIBRARY_V1_PROCEDURE_IDS as readonly string[]).includes(id);
}

/**
 * Where library v1 stands with the parties whose act it waits on. Every value
 * that names an external party is OPEN until that party's act is recorded on
 * #3663 — the merge of a pull request is the repository owner's sign-off and
 * supplies neither.
 */
export const LIBRARY_V1_STATUS = {
    catalogueVersion: 1,
    /** Adopted for this repository by the owner's merge; proposed to the two parties below. */
    status: 'PROPOSED',
    internalAuditApproval: 'OPEN',
    providerAgreement: 'OPEN',
    providerMethodologyReference: 'OPEN',
    recordedOn: '#3663',
} as const;

/** One sentence every finding proposal and evidence row carries about the library's standing. */
export const LIBRARY_V1_STATUS_SENTENCE =
    'Audit procedure library v1 is proposed to internal audit and the managed-service provider: ' +
    'their approval, their agreement and each procedure\'s provider methodology reference are ' +
    'open on #3663, so this procedure is not an approved or agreed definition.';

export type PeriodKind = 'MONTH' | 'QUARTER';

export interface ParameterSpec {
    readonly name: string;
    readonly min: number;
    readonly max: number;
}

export interface ProcedureDefinition {
    readonly id: LibraryV1ProcedureId;
    readonly title: string;
    readonly periodKind: PeriodKind;
    /** Control identifiers, identifiers only (the catalogue's library table). */
    readonly controls: readonly string[];
    /** The attribute ids the procedure tests, in the order a unit is judged. */
    readonly attributes: readonly string[];
    /** Parameters the second line sets on the plan; each is required. */
    readonly parameters: readonly ParameterSpec[];
    /** Two sub-populations, each sampled on its own with `/<name>` on the epoch. */
    readonly subPopulations?: readonly string[];
    /** Sample the whole population (procedure 2), drawn in keyed order. */
    readonly wholePopulation?: boolean;
    /** Hours after the period end before the procedure may run (procedure 3). */
    readonly settleMarginHours?: number;
    /** The population as the catalogue writes it, as the workpaper records it. */
    readonly populationDefinition: string;
}

export const AUDIT_PROCEDURE_LIBRARY_V1: Readonly<Record<LibraryV1ProcedureId, ProcedureDefinition>> = {
    'iam.leaver_timeliness': {
        id: 'iam.leaver_timeliness',
        title: 'Leaver timeliness',
        periodKind: 'MONTH',
        controls: ['ISO/IEC 27001:2022 A.5.16', 'A.5.18', 'A.6.5', 'SOC 2 CC6.1', 'NIS2 Art. 21(2)(i)'],
        attributes: ['L1', 'L2', 'L3'],
        parameters: [{ name: 'leaverWindowHours', min: 1, max: 24 * 365 }],
        populationDefinition:
            'Employee rows of this tenant with status TERMINATED and endDate inside the period (OVER_WINDOW). ' +
            'Accounts considered: ConnectedIdentityAccount rows reached through an IdentityAccountLink on the ' +
            'employee with contradictedAt null, and any ConnectedIdentityAccount whose email equals the ' +
            'employee workEmail ignoring case; protected accounts included; accounts on disabled connections ' +
            'and contradicted links excluded and counted. Population-level check: every TERMINATED employee ' +
            'with endDate null whose considered accounts include an ACTIVE one is an exception.',
    },
    'iam.recertification_completeness': {
        id: 'iam.recertification_completeness',
        title: 'Recertification completeness',
        periodKind: 'QUARTER',
        controls: ['ISO/IEC 27001:2022 A.5.18', 'SOC 2 CC6.1', 'NIS2 Art. 21(2)(i)'],
        attributes: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'],
        parameters: [{ name: 'remediationWindowDays', min: 1, max: 365 }],
        wholePopulation: true,
        populationDefinition:
            'The review populations of this tenant (units AS_OF_GENERATION): memberships, present when a ' +
            'TenantMembership is ACTIVE; each enabled okta, google-workspace, entra-id or active-directory ' +
            'IntegrationConnection holding an ACTIVE ConnectedIdentityAccount; each enabled legacy-mcp ' +
            'connection holding a COMPLETE LegacyAccessSnapshot. Covering campaign (OVER_WINDOW): the latest ' +
            'CLOSED, undeleted AccessReview closed inside the period whose decisions reach the unit ' +
            '(ALL_USERS, CONNECTED_APP or LEGACY_APP). ADMIN_ONLY, CUSTOM and AGENT campaigns do not cover.',
    },
    'iam.time_bounded_access_expiry': {
        id: 'iam.time_bounded_access_expiry',
        title: 'Time-bounded access expiry',
        periodKind: 'MONTH',
        controls: ['ISO/IEC 27001:2022 A.5.15', 'A.5.18', 'SOC 2 CC6.1', 'OWASP ASI03'],
        attributes: ['T1', 'T2', 'T3', 'T4'],
        parameters: [],
        settleMarginHours: 24,
        populationDefinition:
            'ExternalWriteJournal rows of this tenant whose advertisedToolName is a key of GRANT_EXPIRY_ARGS, ' +
            'outcome APPLIED, ACCEPTED or INDETERMINATE, and an end date inside the period (OVER_WINDOW); a ' +
            'row whose end date does not parse or lies more than MAX_GRANT_DAYS after attemptedAt belongs to ' +
            'the period of its attemptedAt. FAILED, RECORDED_ONLY and PENDING rows excluded.',
    },
    'iam.privileged_access': {
        id: 'iam.privileged_access',
        title: 'Privileged access',
        periodKind: 'QUARTER',
        controls: [
            'ISO/IEC 27001:2022 A.5.18',
            'A.8.2',
            'A.8.5',
            'SOC 2 CC6.1',
            'NIS2 Art. 21(2)(i)',
            'Art. 21(2)(j)',
        ],
        attributes: ['PD1', 'PD2', 'PD3', 'PM1', 'PM2'],
        parameters: [],
        subPopulations: ['directory', 'membership'],
        populationDefinition:
            'Two sub-populations AS_OF_GENERATION. directory: ConnectedIdentityAccount rows of this tenant ' +
            'with isAdmin true and status ACTIVE on an enabled connection, break-glass accounts included. ' +
            'membership: TenantMembership rows with role OWNER or ADMIN and status ACTIVE. Custom-role ' +
            'privilege, legacy accounts, registered agents and service principals excluded. The directory ' +
            'sub-population is a lower bound: an undetermined isAdmin is stored as false.',
    },
    'agent.authority_conformance': {
        id: 'agent.authority_conformance',
        title: 'Agent authority conformance',
        periodKind: 'MONTH',
        controls: [
            'OWASP ASI02',
            'ASI03',
            'ISO/IEC 27001:2022 A.5.15',
            'A.8.2',
            'ISO/IEC 42001 A.9.4',
            'SOC 2 CC6.1',
        ],
        attributes: ['A1', 'A2', 'A3', 'A4', 'A5'],
        parameters: [],
        populationDefinition:
            'AgentBehaviourWindow rows of this tenant with windowStart inside the period (OVER_WINDOW) whose ' +
            'RegisteredAgent is not the legacy placeholder: one agent, one hour, the calls authorizeToolCall ' +
            'allowed. Refused calls, calls by a credential bound to no agent, and the windows of auditor agents ' +
            '(the auditor is not the auditee) are excluded and counted.',
    },
};

// ─── Plan configuration ─────────────────────────────────────────────────────

/**
 * What a control-test plan's `automationConfig` carries to run one procedure.
 * The second line sets it (decision 3): the auditor agent, the parameters, an
 * optional larger sample, and optionally a pinned period.
 */
export interface AuditProcedurePlanConfig {
    readonly procedure: LibraryV1ProcedureId;
    readonly auditorAgentId: string;
    readonly parameters: Readonly<Record<string, number>>;
    /** A larger sample than the default, up to the whole population. */
    readonly sampleSize: number | null;
    /** A pinned period; otherwise the latest period of the procedure's kind that has ended. */
    readonly periodLabel: string | null;
}

export type AuditProcedureConfigParse =
    /** The config names no procedure: not this engine's plan. */
    | { readonly kind: 'NOT_OURS' }
    /** It names a procedure and is malformed, or names one outside library v1. */
    | { readonly kind: 'INVALID'; readonly reason: string }
    | { readonly kind: 'OK'; readonly config: AuditProcedurePlanConfig };

const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CONFIG_KEYS = new Set(['procedure', 'auditorAgentId', 'parameters', 'sampleSize', 'periodLabel']);

/**
 * Read a plan's `automationConfig`. A config with no `procedure` key is not
 * ours (the agentic checks own `check`). One that names a procedure is held to
 * the whole shape, strictly: an undeclared key is refused rather than ignored,
 * because a parameter the handler silently dropped would be a workpaper run
 * under rules the second line did not set.
 *
 * A missing PARAMETER is not malformed: it is the catalogue's
 * `PARAMETER_UNSET` precondition, which the handler records as INCONCLUSIVE.
 */
export function parseAuditProcedureConfig(raw: unknown): AuditProcedureConfigParse {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { kind: 'NOT_OURS' };
    const cfg = raw as Record<string, unknown>;
    if (!('procedure' in cfg)) return { kind: 'NOT_OURS' };

    const unknownKeys = Object.keys(cfg).filter((k) => !CONFIG_KEYS.has(k));
    if (unknownKeys.length > 0) return { kind: 'INVALID', reason: `UNKNOWN_KEY:${unknownKeys.sort().join(',')}` };

    const procedure = cfg.procedure;
    if (typeof procedure !== 'string' || !isLibraryV1Procedure(procedure)) {
        return { kind: 'INVALID', reason: 'PROCEDURE_NOT_IN_LIBRARY_V1' };
    }
    const def = AUDIT_PROCEDURE_LIBRARY_V1[procedure];

    const auditorAgentId = cfg.auditorAgentId;
    if (typeof auditorAgentId !== 'string' || !AGENT_ID.test(auditorAgentId)) {
        return { kind: 'INVALID', reason: 'AUDITOR_AGENT_ID_INVALID' };
    }

    const parameters: Record<string, number> = {};
    if (cfg.parameters !== undefined) {
        if (typeof cfg.parameters !== 'object' || cfg.parameters === null || Array.isArray(cfg.parameters)) {
            return { kind: 'INVALID', reason: 'PARAMETERS_NOT_AN_OBJECT' };
        }
        const given = cfg.parameters as Record<string, unknown>;
        const declared = new Map(def.parameters.map((p) => [p.name, p] as const));
        for (const [name, value] of Object.entries(given)) {
            const spec = declared.get(name);
            if (!spec) return { kind: 'INVALID', reason: `PARAMETER_UNKNOWN:${name}` };
            if (typeof value !== 'number' || !Number.isInteger(value) || value < spec.min || value > spec.max) {
                return { kind: 'INVALID', reason: `PARAMETER_OUT_OF_RANGE:${name}` };
            }
            parameters[name] = value;
        }
    }

    let sampleSize: number | null = null;
    if (cfg.sampleSize !== undefined && cfg.sampleSize !== null) {
        if (typeof cfg.sampleSize !== 'number' || !Number.isInteger(cfg.sampleSize) || cfg.sampleSize < 1) {
            return { kind: 'INVALID', reason: 'SAMPLE_SIZE_INVALID' };
        }
        sampleSize = cfg.sampleSize;
    }

    let periodLabel: string | null = null;
    if (cfg.periodLabel !== undefined && cfg.periodLabel !== null) {
        if (typeof cfg.periodLabel !== 'string' || !PERIOD_LABEL.test(cfg.periodLabel)) {
            return { kind: 'INVALID', reason: 'PERIOD_LABEL_INVALID' };
        }
        if (periodKindOf(cfg.periodLabel) !== def.periodKind) {
            return { kind: 'INVALID', reason: 'PERIOD_KIND_MISMATCH' };
        }
        periodLabel = cfg.periodLabel;
    }

    return { kind: 'OK', config: { procedure, auditorAgentId, parameters, sampleSize, periodLabel } };
}

/** The parameters a procedure needs and the config does not set: `PARAMETER_UNSET`. */
export function unsetParameters(config: AuditProcedurePlanConfig): string[] {
    return AUDIT_PROCEDURE_LIBRARY_V1[config.procedure].parameters
        .map((p) => p.name)
        .filter((name) => config.parameters[name] === undefined);
}

// ─── Periods ────────────────────────────────────────────────────────────────

export function periodKindOf(label: string): PeriodKind {
    return /-Q[1-4]$/.test(label) ? 'QUARTER' : 'MONTH';
}

/**
 * The latest period of `kind` that has ended at `now` — the period a scheduled
 * run audits when its plan pins none. A procedure runs only for a period that
 * has ended, so this is never the period `now` is in.
 */
export function latestEndedPeriod(kind: PeriodKind, now: Date): string {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth(); // 0-based
    if (kind === 'MONTH') {
        const prev = new Date(Date.UTC(y, m - 1, 1));
        return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
    }
    const q = Math.floor(m / 3); // 0-based quarter `now` is in
    const prevQ = q === 0 ? 4 : q;
    const prevY = q === 0 ? y - 1 : y;
    return `${prevY}-Q${prevQ}`;
}

/** Has the settle margin after the period's end passed at `now`? */
export function periodSettled(label: string, marginHours: number, now: Date): boolean {
    return periodBounds(label).end.getTime() + marginHours * 3_600_000 <= now.getTime();
}

// ─── The sample ─────────────────────────────────────────────────────────────

/**
 * The purpose string the per-tenant sampling key is derived from
 * (`deriveSubkey`). Distinct from the ASI09 sampler's
 * `inflect-agent-proposal-sample-audit-v1`, so an approval sample and an audit
 * sample never share a key.
 */
export const AUDIT_SAMPLE_SEED_PURPOSE_PREFIX = 'inflect-audit-procedure-sample-v1';

export function auditSampleSeedPurpose(tenantId: string): string {
    return `${AUDIT_SAMPLE_SEED_PURPOSE_PREFIX}:${tenantId}`;
}

/** The fixed label the seed fingerprint is taken over. It holds no NUL, so it is never a unit's score input. */
export const SEED_FINGERPRINT_LABEL = 'inflect-audit-procedure-seed-fingerprint-v1';

/**
 * HMAC-SHA256 under the seed over a fixed label. Not secret: it reveals neither
 * the seed nor a score, and tells a verifier whether the seed they hold is the
 * one that drew a sample (a master-KEK rotation derives a different one).
 */
export function seedFingerprint(seed: string): string {
    return createHmac('sha256', seed).update(SEED_FINGERPRINT_LABEL).digest('hex');
}

/**
 * How many units to draw: `sampleSizeFor(n)` (10%, at least one, at most 25),
 * or the second line's larger size, never more than the population.
 */
export function auditSampleSize(populationCount: number, requested: number | null): number {
    if (populationCount <= 0) return 0;
    const base = sampleSizeFor(populationCount);
    return Math.min(populationCount, Math.max(base, requested ?? 0));
}

/**
 * Draw the keyed sample. Rank, not threshold: the units with the lowest
 * HMAC-SHA256(seed, epoch NUL id). Reproducible from the seed, the epoch and
 * the frozen ids; ties break on the id, so the order is total.
 */
export function drawAuditSample(input: {
    seed: string;
    epoch: string;
    unitIds: readonly string[];
    size: number;
}): string[] {
    return selectSample(
        input.unitIds.map((id) => ({ id })),
        { seed: input.seed, epoch: input.epoch, count: input.size },
    ).map((u) => u.id);
}

// ─── Judging a unit and concluding ──────────────────────────────────────────

export type AttributeResult =
    | { readonly attribute: string; readonly result: 'MET' }
    | { readonly attribute: string; readonly result: 'NOT_APPLICABLE'; readonly code: string }
    | { readonly attribute: string; readonly result: 'EXCEPTION'; readonly code: string }
    | { readonly attribute: string; readonly result: 'UNTESTABLE'; readonly code: string };

export interface UnitJudgement {
    readonly unitId: string;
    readonly outcome: 'PASS' | 'EXCEPTION' | 'UNTESTABLE';
    /** The first exception code, else the first untestable code, else a scope-limit note or null. */
    readonly code: string | null;
    /** Every distinct exception code, in attribute order — one finding proposal each. */
    readonly exceptionCodes: readonly string[];
}

/**
 * One unit's outcome from its attribute results. EXCEPTION when any attribute
 * was not met; UNTESTABLE when none failed and one could not be evaluated;
 * PASS otherwise. A unit where nothing applied passes with its
 * not-applicable code, which the workpaper lists as a scope limit — it is
 * neither a pass of the attribute nor an exception.
 */
export function judgeUnit(unitId: string, results: readonly AttributeResult[]): UnitJudgement {
    const exceptionCodes = [
        ...new Set(results.filter((r) => r.result === 'EXCEPTION').map((r) => (r as { code: string }).code)),
    ];
    if (exceptionCodes.length > 0) {
        return { unitId, outcome: 'EXCEPTION', code: exceptionCodes[0], exceptionCodes };
    }
    const untestable = results.find((r) => r.result === 'UNTESTABLE') as { code: string } | undefined;
    if (untestable) return { unitId, outcome: 'UNTESTABLE', code: untestable.code, exceptionCodes: [] };
    const anyMet = results.some((r) => r.result === 'MET');
    const na = results.find((r) => r.result === 'NOT_APPLICABLE') as { code: string } | undefined;
    return { unitId, outcome: 'PASS', code: anyMet ? null : (na?.code ?? null), exceptionCodes: [] };
}

export type Conclusion = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export interface ConclusionInput {
    /** The first precondition that failed, or null. */
    readonly precondition: string | null;
    readonly populationCount: number;
    /** Exceptions a population-level check raised (procedure 1's undated leavers). */
    readonly populationExceptions: number;
    readonly sampleSize: number;
    readonly units: readonly UnitJudgement[];
}

export interface ConclusionVerdict {
    readonly conclusion: Conclusion;
    readonly basis: string;
}

/**
 * The catalogue's order, exactly:
 *
 *   1. a precondition failed → INCONCLUSIVE on it, no sample. The one
 *      exception is `EMPTY_POPULATION` while a population-level check raised
 *      something: such a population does not count as empty, and it FAILs.
 *   2. any exception → FAIL.
 *   3. any untestable unit → INCONCLUSIVE `ITEM_UNTESTABLE`.
 *   4. PASS, written as `populationCount > 0 && tested === sampleSize &&
 *      exceptions === 0`. Anything short of that is INCONCLUSIVE, not a PASS.
 */
export function decideConclusion(input: ConclusionInput): ConclusionVerdict {
    if (input.precondition !== null) {
        if (input.precondition === 'EMPTY_POPULATION' && input.populationExceptions > 0) {
            return { conclusion: 'FAIL', basis: 'EXCEPTIONS_FOUND' };
        }
        return { conclusion: 'INCONCLUSIVE', basis: input.precondition };
    }
    const unitExceptions = input.units.filter((u) => u.outcome === 'EXCEPTION').length;
    if (unitExceptions > 0 || input.populationExceptions > 0) {
        return { conclusion: 'FAIL', basis: 'EXCEPTIONS_FOUND' };
    }
    if (input.units.some((u) => u.outcome === 'UNTESTABLE')) {
        return { conclusion: 'INCONCLUSIVE', basis: 'ITEM_UNTESTABLE' };
    }
    const tested = input.units.length;
    if (input.populationCount > 0 && input.sampleSize > 0 && tested === input.sampleSize) {
        return { conclusion: 'PASS', basis: 'ALL_SAMPLED_UNITS_PASSED' };
    }
    return { conclusion: 'INCONCLUSIVE', basis: input.populationCount === 0 ? 'EMPTY_POPULATION' : 'ITEM_UNTESTABLE' };
}

// ─── The auditor's remit ────────────────────────────────────────────────────

/** The one write an auditor makes: a finding PROPOSAL, which a person decides. */
export const AUDITOR_PROPOSE_TOOL = 'propose_finding';

/**
 * Every tool an auditor agent may hold: Inflect's own read tools and
 * `propose_finding`. Not another propose tool (an auditor raises findings, it
 * does not draft the risk or the control), and not an external tool (the
 * procedures re-perform from this tenant's rows; reach outside is no part of
 * the remit).
 */
export const AUDITOR_TOOL_REMIT: ReadonlySet<string> = new Set<string>([
    ...MCP_READ_TOOL_NAMES,
    AUDITOR_PROPOSE_TOOL,
]);

/** The tools in `granted` an auditor may not hold, sorted. Empty when within remit. */
export function toolsOutsideAuditorRemit(granted: Iterable<string>): string[] {
    return [...new Set(granted)].filter((t) => !AUDITOR_TOOL_REMIT.has(t)).sort();
}

// ─── Exceptions as finding proposals ────────────────────────────────────────

type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/**
 * The severity a person sees on each exception's finding proposal. A live
 * account or grant that should have ended is HIGH; a control that did not
 * operate (no campaign, no follow-up) is HIGH; a late or incomplete act is
 * MEDIUM. A person decides the proposal and may change it.
 *
 * One exception to the last rule: a leaver disabled LATE is HIGH, not MEDIUM
 * (owner decision 9, 2026-10-19). The account was live for a departed person
 * past the window, which is the exposure the procedure exists to find; that it
 * was closed afterwards does not undo the hours it was open.
 *
 * `POPULATION_COVERAGE_UNVERIFIED` (procedure 2, R3, a legacy application's
 * campaign) sits with `CAMPAIGN_TRUNCATED`: both say the campaign may not have
 * reached every account, and neither names an account that is live.
 */
export const EXCEPTION_SEVERITY: Readonly<Record<string, Severity>> = {
    LEAVER_ACCOUNT_ACTIVE: 'HIGH',
    LEAVER_ACCOUNT_ACTIVE_UNDATED: 'HIGH',
    LEAVER_DISABLED_LATE: 'HIGH',
    NOT_RECERTIFIED_IN_PERIOD: 'HIGH',
    CAMPAIGN_INCOMPLETE: 'MEDIUM',
    CAMPAIGN_TRUNCATED: 'MEDIUM',
    POPULATION_COVERAGE_UNVERIFIED: 'MEDIUM',
    CLOSED_AFTER_DUE: 'LOW',
    SELF_REVIEW: 'HIGH',
    REVOCATION_NOT_EXECUTED: 'HIGH',
    REVOKED_ACCESS_STILL_ACTIVE: 'HIGH',
    EVIDENCE_NOT_GENERATED: 'MEDIUM',
    END_DATE_UNREADABLE: 'MEDIUM',
    GRANT_UNBOUNDED: 'HIGH',
    GRANT_OUTLIVED_WINDOW: 'HIGH',
    OUTLIVED_GRANT_NOT_TASKED: 'MEDIUM',
    PRIVILEGED_UNATTRIBUTED: 'HIGH',
    PRIVILEGED_HOLDER_DEPARTING: 'HIGH',
    PRIVILEGED_WITHOUT_MFA: 'HIGH',
    PRIVILEGE_NOT_RECERTIFIED: 'MEDIUM',
    TOOL_NOT_GRANTED: 'CRITICAL',
    TOOL_NOT_ON_CARD: 'HIGH',
    NO_CARD_IN_FORCE: 'MEDIUM',
    TOOL_UNEXERCISABLE: 'HIGH',
    AGENT_NOT_ACTIVE: 'CRITICAL',
};

/** The finding's provenance tag, so a person can find every exception one procedure raised. */
export const AUDIT_PROCEDURE_FINDING_SOURCE_KIND = 'AUDIT_PROCEDURE';

/**
 * The `propose_finding` item for one exception. Codes, identifiers and counts
 * only: no name, no address, no tool argument — the workpaper's digest
 * discipline, because the proposal outlives the rows it describes. The finding
 * is raised against the plan's control and tagged with the procedure, period,
 * unit and code, so the same exception is recognisable on the next run.
 */
export function exceptionFindingProposal(input: {
    procedureId: LibraryV1ProcedureId;
    periodLabel: string;
    unitId: string | null;
    code: string;
    controlId: string;
    auditorAgentId: string;
    epoch: string | null;
}): { item: Record<string, unknown>; rationale: string } {
    const def = AUDIT_PROCEDURE_LIBRARY_V1[input.procedureId];
    const subject = input.unitId ? `unit ${input.unitId}` : 'the population';
    return {
        item: {
            severity: EXCEPTION_SEVERITY[input.code] ?? 'MEDIUM',
            type: 'NONCONFORMITY',
            title: `${def.title} ${input.periodLabel}: ${input.code} on ${subject}`.slice(0, 200),
            description:
                `The auditor agent ${input.auditorAgentId} re-performed audit procedure ${input.procedureId} ` +
                `(catalogue version ${LIBRARY_V1_STATUS.catalogueVersion}) for period ${input.periodLabel} from ` +
                `raw rows and recorded exception ${input.code} on ${subject}` +
                (input.epoch ? `, drawn with epoch ${input.epoch}` : ', from a population-level check') +
                `. Control identifiers: ${def.controls.join(', ')}. ${LIBRARY_V1_STATUS_SENTENCE} ` +
                'A person decides this proposal; the auditor closes and resolves nothing.',
            controlId: input.controlId,
            sourceKind: AUDIT_PROCEDURE_FINDING_SOURCE_KIND,
            sourceRef: exceptionSourceRef(input.procedureId, input.periodLabel, input.unitId, input.code),
        },
        rationale:
            `Exception ${input.code} from the re-performance of ${input.procedureId} for ${input.periodLabel}.`,
    };
}

/** `<procedureId>@<period>:<unitId|POPULATION>:<code>` — the exception's stable key. */
export function exceptionSourceRef(
    procedureId: string,
    periodLabel: string,
    unitId: string | null,
    code: string,
): string {
    return `${procedureId}@${periodLabel}:${unitId ?? 'POPULATION'}:${code}`;
}

/** The key one exception is deduplicated by across runs of the same procedure and period. */
export function exceptionKey(unitId: string | null, code: string): string {
    return `${unitId ?? ''}|${code}`;
}
