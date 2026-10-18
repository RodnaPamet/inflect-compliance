/**
 * WHICH DIFFERENCE BETWEEN TWO WEEKS' PASSPORTS IS A FINDING, AND WHOSE (#3672)
 * — a pure planner.
 *
 * Input: this week's passports, what is known about the last one emitted, the
 * audit entries in the window between them, and whether this pass will emit.
 * Output: the findings that are true this week (`assert`) and the ones this
 * week proves resolved (`resolve`). `usecases/integration-passport.ts`
 * reconciles the plan against stored `Finding` rows; nothing here touches a
 * database, so every rule in `docs/integration-passport.md` is a unit test.
 *
 * ── TWO KINDS OF FINDING ────────────────────────────────────────────────────
 *
 *   STATE  a condition of THIS week's passport: no owner, never tested, a
 *          BASELINE pin, a pin with no annotations hash, a rung the build does
 *          not know, a week whose passports were not evidenced. Planned every
 *          week from the current passport alone, so a first passport raises
 *          them (rule 1), and closed only on POSITIVE evidence — the subject is
 *          present and the condition is observed false. Absence closes
 *          nothing: a removed pin's BASELINE finding stays open beside its
 *          PIN_REMOVED.
 *   EVENT  a difference between the last verified passport and this one. Keyed
 *          with the ISO week (`…@2026-W42`), never closed by a sweep, never
 *          reopened. The week is in the key because the specification's
 *          (connection, field, rule) key alone would fold a second widening of
 *          one connection into the first while it is still open, and would
 *          leave a same-week re-run after somebody closed the finding to
 *          choose between reopening a triaged event and staying silent for
 *          ever. The (connection, field, rule) key is always the prefix.
 *
 * ── WHEN EVENTS ARE PLANNED AT ALL ──────────────────────────────────────────
 *
 * Only when the prior is VERIFIED and this pass EMITS. A pass that raised
 * events without emitting would leave the same old prior in place, and the next
 * pass would raise the same events again under the next week's key. A prior
 * that does not verify is never a silent baseline: it is a HIGH
 * `PASSPORT_PRIOR_UNVERIFIABLE` finding, and only then is every connection
 * treated as a first passport. A truncated read plans no event, no VANISHED and
 * no resolution, because a population that is not complete would report every
 * row past the cap as REMOVED and every connection past it as VANISHED. It
 * still raises its own finding AND the state findings of the rows it did read:
 * each is a positive condition observed on a row (an owner missing, a
 * connection never tested, a BASELINE pin), true whatever lies past the cap —
 * so a tenant over a cap is not, week after week, a tenant whose absences are
 * never raised.
 *
 * ── OWNERSHIP ───────────────────────────────────────────────────────────────
 *
 * A connection finding is assigned to the connection's accountable owner (P11:
 * a named user holding an ACTIVE membership). With no accountable owner it is
 * owned by the tenant's OWNER role, carries NO assignee, and says so in its
 * description beside the `CONNECTION_OWNER_MISSING` finding for the same
 * connection. Tenant-level findings, `CONNECTION_OWNER_MISSING` and
 * `CONNECTION_VANISHED` are always the OWNER role's. "The OWNER role" is the
 * specification's wording; in code it and the holders of
 * `admin.tenant_lifecycle` can differ through custom roles, which changes
 * nothing here because such a finding carries no assignee.
 *
 * The assignment FOLLOWS the owner while a finding is open: each sweep moves an
 * open finding about a connection to that connection's current accountable
 * owner, or to the OWNER role when it has none (`intendedAssignee`). Ownership
 * is therefore the LAST segment of every connection finding's description —
 * the fallback sentence, or the self-made sentence, or neither — so the sweep
 * can rewrite it exactly (`reassignedDescription`) without touching anything a
 * person wrote above it.
 *
 * ── WHAT A DESCRIPTION MAY SAY ──────────────────────────────────────────────
 *
 * Rule 5: identifiers, not content. Fields, from → to values, hashes, rung
 * names, ids, and the audit entries in the window that record the change. Never
 * a secret, a tool description or schema, a parameter value or a payload.
 * Descriptions and titles are sanitised again at the write.
 *
 * PURE: no clock, no I/O.
 */
import { LADDER } from '@/lib/integrations/external-write-ladder';

import type { ArtefactPeriod } from './evidence-artefact';
import {
    bareToolName,
    byCodeUnit,
    displayLabel,
    type IntegrationPassport,
    type PassportBundle,
    type PassportExtractionFailure,
    type PassportGrant,
    type PassportParameterSet,
    type PassportPairing,
    type PassportPin,
} from './integration-passport';

/** The `Finding.sourceKind` every passport finding carries — its reconcile key space. */
export const PASSPORT_FINDING_SOURCE_KIND = 'INTEGRATION_PASSPORT';

export const PASSPORT_STATE_CODES = [
    'CONNECTION_OWNER_MISSING',
    'CONNECTION_NEVER_TESTED',
    'PIN_BASELINE',
    'PIN_ANNOTATIONS_UNATTESTED',
    'WRITE_RUNG_UNRECOGNISED',
    'PASSPORT_NOT_EVIDENCED',
] as const;

export const PASSPORT_EVENT_CODES = [
    'ENDPOINT_CHANGED',
    'CONNECTION_REENABLED',
    'CONNECTION_DISABLED',
    'GRANT_KIND_CHANGED',
    'EFFECTIVE_SCOPE_CHANGED',
    'AUDIENCE_CHANGED',
    'PIN_ADDED',
    'PIN_REMOVED',
    'PIN_CHANGED',
    'GRANT_ADDED',
    'GRANT_REMOVED',
    'WRITE_RUNG_WIDENED',
    'WRITE_RUNG_NARROWED',
    'PAIRING_ADDED',
    'PAIRING_REMOVED',
    'PAIRING_REPOINTED',
    'PARAMETER_SET_ADDED',
    'PARAMETER_SET_REMOVED',
    'PARAMETER_SET_REVISED',
    'PARAMETER_SET_TARGET_CHANGED',
    'OWNER_CHANGED',
    'CONNECTION_TEST_FAILED',
    'CONNECTION_VANISHED',
    'PASSPORT_PRIOR_UNVERIFIABLE',
] as const;

export type PassportStateCode = (typeof PASSPORT_STATE_CODES)[number];
export type PassportEventCode = (typeof PASSPORT_EVENT_CODES)[number];
export type PassportFindingCode = PassportStateCode | PassportEventCode;

export type PassportField = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8' | 'P9' | 'P10' | 'P11' | 'P12';

/** Why a week's passports were not emitted. */
export const NOT_EVIDENCED_REASONS = ['NO_TARGET_CONTROL', 'POPULATION_TRUNCATED', 'BUNDLE_TOO_LARGE'] as const;
export type NotEvidencedReason = (typeof NOT_EVIDENCED_REASONS)[number];

/** Why the newest prior emission could not be compared against. */
export type PriorUnverifiableReason = 'WITHDRAWN' | 'EVIDENCE_MISSING' | PassportExtractionFailure;

/** What is known about the last passports emitted strictly before this week. */
export type PassportPrior =
    /** Nothing was ever emitted: this week is every connection's baseline. */
    | { readonly status: 'NONE' }
    /** The newest prior verified. `emittedAt` opens the citation window. */
    | { readonly status: 'VERIFIED'; readonly bundle: PassportBundle; readonly emittedAt: Date }
    /** The newest prior exists and did not verify. */
    | {
          readonly status: 'UNVERIFIABLE';
          readonly periodLabel: string;
          readonly reason: PriorUnverifiableReason;
      };

/**
 * One audit row in the window, as the planner matches it. The usecase selects
 * `metadataJson` as well as `detailsJson`: a prior-state pairing's write tool is
 * recorded in the former.
 */
export interface PassportAuditEntry {
    readonly id: string;
    readonly action: string;
    readonly entity: string;
    readonly entityId: string;
    readonly userId: string | null;
    readonly createdAt: Date;
    readonly detailsJson: unknown;
    readonly metadataJson: unknown;
}

const CONNECTION_ACTIONS = [
    'INTEGRATION_CONNECTION_CREATED',
    'INTEGRATION_CONNECTION_UPDATED',
    'INTEGRATION_CONNECTION_DISABLED',
    'MCP_CONNECTION_AUTHORIZED',
    'MCP_GRANT_TOKEN_MINTED',
    'MCP_GRANT_TOKEN_ROTATED',
] as const;
const WRITE_MODE_ACTION = 'EXTERNAL_WRITE_MODE_CHANGED';
const PAIRING_ACTIONS = ['EXTERNAL_PRIOR_STATE_READ_SET', 'EXTERNAL_PRIOR_STATE_READ_CLEARED'] as const;
const OWNER_ACTION = 'INTEGRATION_CONNECTION_OWNER_SET';
const PIN_ACTION = 'MCP_TOOL_MANIFEST_APPROVED';
const GRANT_ACTIONS = ['AGENT_TOOL_GRANTED', 'AGENT_TOOL_REVOKED'] as const;
const PARAMETER_ACTIONS = [
    'EXTERNAL_TOOL_PARAMETERS_SAVED',
    'EXTERNAL_TOOL_PARAMETERS_PROPOSED',
    'EXTERNAL_TOOL_PARAMETERS_SIGNED',
    'EXTERNAL_TOOL_PARAMETERS_APPROVED',
] as const;

/** Every audit action a passport finding may cite — the window read's `action IN`. */
export const PASSPORT_CITED_ACTIONS: readonly string[] = [
    ...CONNECTION_ACTIONS,
    WRITE_MODE_ACTION,
    ...PAIRING_ACTIONS,
    OWNER_ACTION,
    PIN_ACTION,
    ...GRANT_ACTIONS,
    ...PARAMETER_ACTIONS,
];

export interface PassportPlanInput {
    readonly period: ArtefactPeriod;
    readonly current: readonly IntegrationPassport[];
    readonly prior: PassportPrior;
    /** Audit entries after the prior's `emittedAt`, oldest first. Empty without a verified prior. */
    readonly citations: readonly PassportAuditEntry[];
    /** The window read hit its cap. */
    readonly citationsTruncated: boolean;
    /** Why this pass does not emit. Empty means it emits. */
    readonly notEvidenced: readonly NotEvidencedReason[];
}

export interface PlannedPassportFinding {
    readonly code: PassportFindingCode;
    /** STATE findings reopen when the condition returns; EVENT findings never do. */
    readonly nature: 'STATE' | 'EVENT';
    readonly sourceRef: string;
    /** Null for a tenant-level finding. */
    readonly connectionId: string | null;
    readonly field: PassportField | null;
    /** The tool, grant, pairing or set the finding is about, when it is about one. */
    readonly item: string | null;
    readonly severity: 'LOW' | 'MEDIUM' | 'HIGH';
    readonly type: 'NONCONFORMITY' | 'OBSERVATION';
    /** Null means the tenant's OWNER role, which the description names. */
    readonly assigneeUserId: string | null;
    readonly title: string;
    readonly description: string;
}

export interface PassportResolution {
    readonly sourceRef: string;
    /** The positive evidence, for `verificationNotes`. */
    readonly because: string;
}

export interface PassportFindingPlan {
    readonly assert: readonly PlannedPassportFinding[];
    readonly resolve: readonly PassportResolution[];
    /** Were this week's passports compared with a verified prior? */
    readonly compared: boolean;
}

// ── Keys ────────────────────────────────────────────────────────────────────

const enc = encodeURIComponent;

/** `<subject>:<field>:<RULE>[:<item>]` — the state key, and every event key's prefix. */
function stateRef(subject: string, field: string, rule: string, item?: string): string {
    return item === undefined ? `${subject}:${field}:${rule}` : `${subject}:${field}:${rule}:${enc(item)}`;
}

function eventRef(subject: string, field: string, rule: string, week: string, item?: string): string {
    return `${stateRef(subject, field, rule, item)}@${week}`;
}

/** Every passport `sourceRef` about one connection starts with this. */
export function connectionRefPrefix(connectionId: string): string {
    return `${connectionId}:`;
}

export const TENANT_SUBJECT = 'tenant';

export function notEvidencedRef(reason: NotEvidencedReason): string {
    return `${TENANT_SUBJECT}:NOT_EVIDENCED:${reason}`;
}

export function priorUnverifiableRef(priorPeriodLabel: string): string {
    return `${TENANT_SUBJECT}:PRIOR_UNVERIFIABLE:${enc(priorPeriodLabel)}`;
}

export function vanishedRef(connectionId: string): string {
    // No week: an id vanishes once.
    return `${connectionId}:VANISHED`;
}

// ── Wording ─────────────────────────────────────────────────────────────────

const OWNER_ROLE = "the tenant's OWNER role (the holders of admin.tenant_lifecycle)";

/** The sentence every connection finding with no accountable owner carries. */
export const OWNER_ROLE_FALLBACK =
    `Owned by ${OWNER_ROLE}: this connection has no accountable owner — see CONNECTION_OWNER_MISSING.`;

const OWNER_ROLE_OWNED = `Owned by ${OWNER_ROLE}.`;

/** Ends a description whose every cited change was made by its assignee. Leading space included. */
export const SELF_MADE_SENTENCE = ' This change was made by the assignee.';

/** How many citations a description lists before summarising. */
const MAX_CITATIONS = 10;
/** The longest a single from/to value is repeated in a description. */
const VALUE_MAX = 512;

function shortId(id: string): string {
    return id.length <= 12 ? id : `…${id.slice(-8)}`;
}

function titleFor(code: PassportFindingCode, name: string | null, connectionId: string | null): string {
    if (connectionId === null) return `Integration passport — ${code} — tenant`;
    return `Integration passport — ${code} — ${displayLabel(name)} (${shortId(connectionId)})`;
}

function v(value: string | null | undefined): string {
    if (value === null || value === undefined) return 'none';
    return value.length > VALUE_MAX ? `${value.slice(0, VALUE_MAX - 1)}…` : value;
}

function audienceText(a: IntegrationPassport['audience']): string {
    return a === 'unknown' ? 'unknown' : a.length === 0 ? '(empty)' : `[${a.map(v).join(', ')}]`;
}

function sameAudience(a: IntegrationPassport['audience'], b: IntegrationPassport['audience']): boolean {
    if (a === 'unknown' || b === 'unknown') return a === b;
    return a.length === b.length && a.every((x, i) => x === b[i]);
}

// ── Citations ───────────────────────────────────────────────────────────────

function recordOf(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function stringAt(value: unknown, ...path: string[]): string | null {
    let node: unknown = value;
    for (const key of path) node = recordOf(node)[key];
    return typeof node === 'string' ? node : null;
}

/** The granted tool an AGENT_TOOL_* entry is about. */
function grantedToolOf(e: PassportAuditEntry): string | null {
    return stringAt(e.detailsJson, 'after', 'toolName') ?? stringAt(e.detailsJson, 'before', 'toolName');
}

/** The write tool an EXTERNAL_PRIOR_STATE_READ_* entry is about. */
function pairedWriteToolOf(e: PassportAuditEntry): string | null {
    return stringAt(e.metadataJson, 'writeToolName') ?? stringAt(e.detailsJson, 'writeToolName');
}

type Matcher = (e: PassportAuditEntry) => boolean;

const onConnection = (connectionId: string, actions: readonly string[]): Matcher => (e) =>
    e.entity === 'IntegrationConnection' && e.entityId === connectionId && actions.includes(e.action);

function matcherFor(field: PassportField | 'VANISHED', connectionId: string, item: string | null): Matcher | null {
    switch (field) {
        case 'P1':
        case 'P2':
        case 'P3':
        case 'P4':
        case 'P5':
        case 'VANISHED':
            return onConnection(connectionId, CONNECTION_ACTIONS);
        case 'P8':
            return onConnection(connectionId, [WRITE_MODE_ACTION]);
        case 'P9':
            return (e) => onConnection(connectionId, PAIRING_ACTIONS)(e) && pairedWriteToolOf(e) === item;
        case 'P11':
            return onConnection(connectionId, [OWNER_ACTION]);
        case 'P6':
            return (e) => e.entity === 'McpToolManifestPin' && e.entityId === item && e.action === PIN_ACTION;
        case 'P7': {
            const [agentId, toolName] = (item ?? '').split('\u0000');
            return (e) =>
                e.entity === 'RegisteredAgent'
                && e.entityId === agentId
                && (GRANT_ACTIONS as readonly string[]).includes(e.action)
                && grantedToolOf(e) === toolName;
        }
        case 'P10':
            return (e) =>
                e.entity === 'ExternalToolParameterSet'
                && e.entityId === item
                && (PARAMETER_ACTIONS as readonly string[]).includes(e.action);
        case 'P12':
            return null;
    }
}

function citationText(
    input: PassportPlanInput,
    field: PassportField | 'VANISHED',
    connectionId: string,
    item: string | null,
    assigneeUserId: string | null,
): string {
    const matcher = matcherFor(field, connectionId, item);
    if (matcher === null) {
        return 'The Test button writes no audit entry, so no change can be cited for this field.';
    }
    const since = input.prior.status === 'VERIFIED' ? input.prior.emittedAt.toISOString() : 'the last emission';
    const matched = input.citations.filter(matcher);
    const incomplete = input.citationsTruncated
        ? ' The audit read for this window reached its cap, so this list may be incomplete.'
        : '';
    if (matched.length === 0) {
        return `No audit entry in the window since ${since} records this change.${incomplete}`;
    }
    const shown = matched
        .slice(0, MAX_CITATIONS)
        .map((e) => `${e.id} ${e.action} by ${e.userId ?? 'system'} at ${e.createdAt.toISOString()}`);
    const more = matched.length > MAX_CITATIONS ? ` (+${matched.length - MAX_CITATIONS} more)` : '';
    // Roadmap rule 8 — the auditor is not the auditee. Stated, not acted on:
    // the specification assigns the finding to the owner either way. It is the
    // last thing in the citation, and the citation is the last thing before
    // the ownership sentence, so `reassignedDescription` can find it.
    const selfMade =
        assigneeUserId !== null && matched.every((e) => e.userId === assigneeUserId) ? SELF_MADE_SENTENCE : '';
    return `Audit entries in the window since ${since}: ${shown.join('; ')}${more}.${incomplete}${selfMade}`;
}

// ── The planner ─────────────────────────────────────────────────────────────

function ownerOf(p: IntegrationPassport): string | null {
    return p.owner.accountable ? p.owner.userId : null;
}

function ownershipSentence(assignee: string | null): string {
    return assignee === null ? ` ${OWNER_ROLE_FALLBACK}` : '';
}

function pinHashes(p: PassportPin): string {
    return (
        `descriptionHash ${p.descriptionHash}, schemaHash ${p.schemaHash}, manifestHash ${p.manifestHash}, `
        + `annotationsHash ${v(p.annotationsHash)}`
    );
}

function declarationText(d: boolean | null): string {
    return d === null ? 'not recorded' : d ? 'declares a write' : 'read-only';
}

/** Plan what this week's passports mean for the tenant. */
export function planPassportFindings(input: PassportPlanInput): PassportFindingPlan {
    const week = input.period.label;
    const assert: PlannedPassportFinding[] = [];
    const resolve: PassportResolution[] = [];

    // ── A TRUNCATED READ: ITS OWN FINDING, AND THE STATE OF WHAT WAS READ ───
    // Every state condition is a positive observation on a row that was read,
    // so it holds whatever lies past the cap, and rule 1 raises absences rather
    // than skipping them. Nothing is resolved (a closure is a claim the next
    // complete pass makes) and no event or VANISHED is planned: against an
    // incomplete population every row past the cap would read as removed.
    if (input.notEvidenced.includes('POPULATION_TRUNCATED')) {
        assert.push(notEvidencedFinding('POPULATION_TRUNCATED'));
        const discarded: PassportResolution[] = [];
        for (const p of input.current) planState(p, assert, discarded);
        return { assert, resolve, compared: false };
    }

    // ── TENANT-LEVEL STATE ──────────────────────────────────────────────────
    for (const reason of NOT_EVIDENCED_REASONS) {
        if (input.notEvidenced.includes(reason)) {
            assert.push(notEvidencedFinding(reason));
        } else {
            resolve.push({ sourceRef: notEvidencedRef(reason), because: `${reason} observed absent` });
        }
    }

    if (input.prior.status === 'UNVERIFIABLE') {
        assert.push({
            code: 'PASSPORT_PRIOR_UNVERIFIABLE',
            nature: 'EVENT',
            sourceRef: priorUnverifiableRef(input.prior.periodLabel),
            connectionId: null,
            field: null,
            item: null,
            severity: 'HIGH',
            type: 'NONCONFORMITY',
            assigneeUserId: null,
            title: titleFor('PASSPORT_PRIOR_UNVERIFIABLE', null, null),
            description:
                `The integration passports emitted for ${input.prior.periodLabel} could not be verified `
                + `(${input.prior.reason}), so the passports for ${week} were not compared with them and every `
                + 'connection was treated as a first passport. A change made since then is not reported as '
                + 'drift; it is visible only by reading the current passports. '
                + OWNER_ROLE_OWNED,
        });
    }

    // ── PER-CONNECTION STATE, FROM THIS WEEK'S PASSPORT ALONE ───────────────
    for (const p of input.current) planState(p, assert, resolve);

    // ── EVENTS ──────────────────────────────────────────────────────────────
    const verified = input.prior.status === 'VERIFIED' ? input.prior : null;
    const compared = verified !== null && input.notEvidenced.length === 0;
    if (compared) {
        const before = new Map(verified.bundle.connections.map((p) => [p.connectionId, p]));
        const now = new Set(input.current.map((p) => p.connectionId));
        for (const p of input.current) {
            const prior = before.get(p.connectionId);
            // A connection new since the prior is a baseline (rule 1): no ADDED.
            // Digest first: an identical passport evaluates no rule.
            if (prior === undefined || prior.digest === p.digest) continue;
            planEvents(input, prior, p, assert);
        }
        for (const prior of verified.bundle.connections) {
            if (now.has(prior.connectionId)) continue;
            assert.push({
                code: 'CONNECTION_VANISHED',
                nature: 'EVENT',
                sourceRef: vanishedRef(prior.connectionId),
                connectionId: prior.connectionId,
                field: null,
                item: null,
                severity: 'HIGH',
                type: 'NONCONFORMITY',
                assigneeUserId: null,
                title: titleFor('CONNECTION_VANISHED', prior.name, prior.connectionId),
                description:
                    `Connection ${prior.connectionId} was in the integration passports emitted for `
                    + `${verified.bundle.periodLabel} and is absent in ${week}. The product disables an `
                    + 'external agent connection and never deletes it, so it was removed outside the '
                    + `product's own paths. ${OWNER_ROLE_OWNED} `
                    + citationText(input, 'VANISHED', prior.connectionId, null, null),
            });
        }
    }

    return { assert, resolve, compared };
}

function notEvidencedFinding(reason: NotEvidencedReason): PlannedPassportFinding {
    const why: Record<NotEvidencedReason, string> = {
        NO_TARGET_CONTROL:
            'No control in this tenant discharges a requirement the integration passport evidences, so no '
            + 'passport was emitted, and next week has nothing stored to be compared with. Drift between '
            + 'weeks is not being reported for this tenant until such a control exists.',
        POPULATION_TRUNCATED:
            'One of the reads the passports are built from reached its cap, so the population is not '
            + 'complete. Nothing was compared, emitted or closed this week: a row past the cap would have '
            + 'read as removed, and a connection past it as vanished. The conditions observed on the rows '
            + 'that were read (no accountable owner, never tested, a BASELINE pin, a pin with no '
            + 'annotations hash, an unrecognised rung) are still raised.',
        BUNDLE_TOO_LARGE:
            'This week\'s passports exceed the size one evidence artefact may carry, so none was emitted '
            + 'and next week has nothing stored to be compared with.',
    };
    return {
        code: 'PASSPORT_NOT_EVIDENCED',
        nature: 'STATE',
        sourceRef: notEvidencedRef(reason),
        connectionId: null,
        field: null,
        item: reason,
        severity: 'MEDIUM',
        type: 'OBSERVATION',
        assigneeUserId: null,
        title: `${titleFor('PASSPORT_NOT_EVIDENCED', null, null)} (${reason})`,
        description: `${why[reason]} ${OWNER_ROLE_OWNED}`,
    };
}

function planState(
    p: IntegrationPassport,
    assert: PlannedPassportFinding[],
    resolve: PassportResolution[],
): void {
    const c = p.connectionId;
    const owner = ownerOf(p);
    const base = (code: PassportStateCode, field: PassportField, item: string | null) => ({
        code,
        nature: 'STATE' as const,
        connectionId: c,
        field,
        item,
        title: titleFor(code, p.name, c),
    });

    // P11 — no owner. Always the OWNER role's.
    const ownerRef = stateRef(c, 'P11', 'OWNER_MISSING');
    if (!p.owner.accountable) {
        const named =
            p.owner.userId === null
                ? 'No accountable owner is named on it.'
                : `User ${p.owner.userId} is named as its owner but holds no active membership of this tenant, `
                  + 'so nobody is accountable for it.';
        assert.push({
            ...base('CONNECTION_OWNER_MISSING', 'P11', null),
            sourceRef: ownerRef,
            severity: 'HIGH',
            type: 'NONCONFORMITY',
            assigneeUserId: null,
            description:
                `Connection ${c} lets an agent reach a system outside the platform. ${named} Owned by `
                + `${OWNER_ROLE}, who set every connection's write rung and prior-state pairings; every other `
                + 'finding on this connection falls to the same role until an owner is named.',
        });
    } else {
        resolve.push({ sourceRef: ownerRef, because: `accountable owner ${p.owner.userId} named` });
    }

    // P12 — never tested.
    const testRef = stateRef(c, 'P12', 'NEVER_TESTED');
    if (p.lastValidated.at === null) {
        assert.push({
            ...base('CONNECTION_NEVER_TESTED', 'P12', null),
            sourceRef: testRef,
            severity: 'LOW',
            type: 'OBSERVATION',
            assigneeUserId: owner,
            description:
                `Connection ${c} has never been tested: lastTestedAt is empty, so nothing on record says the `
                + 'configuration as saved can authenticate.' + ownershipSentence(owner),
        });
    } else {
        resolve.push({ sourceRef: testRef, because: `tested at ${p.lastValidated.at}` });
    }

    // P6 — a BASELINE pin, and a pin with no annotations hash.
    for (const pin of p.pinnedTools) {
        const tool = bareToolName(c, pin.toolName);
        const baselineRef = stateRef(c, 'P6', 'BASELINE', tool);
        if (pin.approvalSource === 'BASELINE') {
            assert.push({
                ...base('PIN_BASELINE', 'P6', pin.toolName),
                sourceRef: baselineRef,
                severity: 'HIGH',
                type: 'NONCONFORMITY',
                assigneeUserId: owner,
                description:
                    `The pin for tool ${pin.toolName} (revision ${pin.revision}) is a BASELINE: a definition `
                    + 'nobody accepted. External pins are written as APPROVED with a named approver, so a '
                    + `baseline here was never reviewed. Pinned hashes: ${pinHashes(pin)}.`
                    + ownershipSentence(owner),
            });
        } else if (pin.approvalSource === 'APPROVED') {
            resolve.push({
                sourceRef: baselineRef,
                because: `pin approved at revision ${pin.revision} by ${pin.approvedByUserId ?? 'unrecorded'}`,
            });
        }

        const annotationsRef = stateRef(c, 'P6', 'ANNOTATIONS_UNATTESTED', tool);
        if (pin.annotationsHash === null) {
            assert.push({
                ...base('PIN_ANNOTATIONS_UNATTESTED', 'P6', pin.toolName),
                sourceRef: annotationsRef,
                severity: 'HIGH',
                type: 'NONCONFORMITY',
                assigneeUserId: owner,
                description:
                    `The pin for tool ${pin.toolName} (revision ${pin.revision}) holds no annotationsHash. The `
                    + 'pin is compared on annotations only when it holds that hash, so the server can flip '
                    + 'readOnlyHint and the runtime still offers the tool as APPROVED: its write declaration '
                    + 'is not attested. Re-approving the tool writes the hash.' + ownershipSentence(owner),
            });
        } else {
            resolve.push({ sourceRef: annotationsRef, because: `annotationsHash ${pin.annotationsHash} pinned` });
        }
    }

    // P8 — a stored rung this build does not know.
    const rungRef = stateRef(c, 'P8', 'UNRECOGNISED');
    if (p.writeRung.storedUnrecognised !== null) {
        assert.push({
            ...base('WRITE_RUNG_UNRECOGNISED', 'P8', null),
            sourceRef: rungRef,
            severity: 'MEDIUM',
            type: 'OBSERVATION',
            assigneeUserId: owner,
            description:
                `Connection ${c} stores external write rung "${p.writeRung.storedUnrecognised}", which this `
                + `build does not recognise. It reads as ${p.writeRung.mode} and fails closed, but something `
                + 'wrote a rung this build does not know.' + ownershipSentence(owner),
        });
    } else {
        resolve.push({ sourceRef: rungRef, because: `stored rung recognised as ${p.writeRung.mode}` });
    }
}

function planEvents(
    input: PassportPlanInput,
    prior: IntegrationPassport,
    p: IntegrationPassport,
    assert: PlannedPassportFinding[],
): void {
    const c = p.connectionId;
    const week = input.period.label;
    const owner = ownerOf(p);
    const push = (
        code: PassportEventCode,
        field: PassportField,
        severity: PlannedPassportFinding['severity'],
        lead: string,
        item: { ref: string; match: string | null; label: string } | null = null,
    ) => {
        assert.push({
            code,
            nature: 'EVENT',
            sourceRef: eventRef(c, field, code, week, item?.ref),
            connectionId: c,
            field,
            item: item?.label ?? null,
            severity,
            type: 'OBSERVATION',
            assigneeUserId: owner,
            title: titleFor(code, p.name, c),
            // Ownership LAST — see the header: the sweep rewrites exactly this
            // tail when the connection's owner changes.
            description:
                `${lead} ${citationText(input, field, c, item?.match ?? null, owner)}${ownershipSentence(owner)}`,
        });
    };

    // P1 — the origin, and a keyed digest of the whole URL. The URL itself is
    // never in a passport, so it is never in a finding either.
    if (prior.endpoint.origin !== p.endpoint.origin || prior.endpoint.urlDigest !== p.endpoint.urlDigest) {
        const what =
            prior.endpoint.origin !== p.endpoint.origin
                ? `The endpoint origin of connection ${c} changed: ${v(prior.endpoint.origin)} → `
                  + `${v(p.endpoint.origin)}.`
                : `The endpoint of connection ${c} changed within origin ${v(p.endpoint.origin)}: its keyed URL `
                  + `digest moved ${v(prior.endpoint.urlDigest)} → ${v(p.endpoint.urlDigest)}. The path and query `
                  + 'are not repeated here, because either can carry a credential. Rotating the deployment\'s '
                  + 'master encryption key also re-keys this digest.';
        push('ENDPOINT_CHANGED', 'P1', 'HIGH', `${what} The stored credential is presented to whatever this field names.`);
    }

    // P2
    if (prior.enabled !== p.enabled) {
        if (p.enabled) {
            push('CONNECTION_REENABLED', 'P2', 'MEDIUM', `Connection ${c} was re-enabled: its reach is restored.`);
        } else {
            push('CONNECTION_DISABLED', 'P2', 'LOW', `Connection ${c} was disabled.`);
        }
    }

    // P3
    if (prior.grantKind !== p.grantKind) {
        const leftDelegated = prior.grantKind === 'delegated';
        push(
            'GRANT_KIND_CHANGED',
            'P3',
            leftDelegated ? 'HIGH' : 'MEDIUM',
            `The grant kind of connection ${c} changed: ${prior.grantKind} → ${p.grantKind}.`
                + (leftDelegated
                    ? ' The ceiling of a named person is removed: a token minted for this connection no longer '
                      + "carries a person's privileges."
                    : ''),
        );
    }

    // P4
    if (prior.scope.effective !== p.scope.effective) {
        push(
            'EFFECTIVE_SCOPE_CHANGED',
            'P4',
            'MEDIUM',
            `The effective scope of connection ${c} changed: ${v(prior.scope.effective)}`
                + `${prior.scope.defaulted ? ' (defaulted)' : ''} → ${v(p.scope.effective)}`
                + `${p.scope.defaulted ? ' (defaulted)' : ''}.`,
        );
    }

    // P5
    if (!sameAudience(prior.audience, p.audience)) {
        push(
            'AUDIENCE_CHANGED',
            'P5',
            'HIGH',
            `The audience of connection ${c} changed: ${audienceText(prior.audience)} → ${audienceText(p.audience)}. `
                + 'A token is minted for the new resource and presented to the same endpoint.',
        );
    }

    // P6
    planKeyed<PassportPin>(prior.pinnedTools, p.pinnedTools, (t) => t.toolName, {
        added: (t) =>
            push(
                'PIN_ADDED',
                'P6',
                'MEDIUM',
                `Tool ${t.toolName} was pinned on connection ${c} at revision ${t.revision} (${t.approvalSource}, `
                    + `approved by ${v(t.approvedByUserId)} at ${t.approvedAt}; write declaration `
                    + `${declarationText(t.declaresWrite)}). Pinned hashes: ${pinHashes(t)}.`,
                pinItem(c, t.toolName),
            ),
        removed: (t) =>
            push(
                'PIN_REMOVED',
                'P6',
                'MEDIUM',
                `The pin for tool ${t.toolName} on connection ${c} is gone. It was at revision ${t.revision} with `
                    + `manifestHash ${t.manifestHash}.`,
                pinItem(c, t.toolName),
            ),
        changed: (a, b) => {
            const moved = (['descriptionHash', 'schemaHash', 'manifestHash', 'annotationsHash'] as const).filter(
                (h) => a[h] !== b[h],
            );
            if (a.revision === b.revision && moved.length === 0) return;
            const high = moved.includes('descriptionHash') || moved.includes('annotationsHash');
            const declaration =
                a.declaresWrite === b.declaresWrite
                    ? ''
                    : a.declaresWrite === true && b.declaresWrite === false
                    ? ' Redeclared read-only: the tool leaves the external write ladder.'
                    : ` Write declaration: ${declarationText(a.declaresWrite)} → ${declarationText(b.declaresWrite)}.`;
            push(
                'PIN_CHANGED',
                'P6',
                high ? 'HIGH' : 'MEDIUM',
                `The pin for tool ${b.toolName} on connection ${c} moved from revision ${a.revision} to `
                    + `${b.revision}. Hashes moved: `
                    + (moved.length === 0
                        ? 'none'
                        : moved.map((h) => `${h} ${v(a[h])} → ${v(b[h])}`).join('; '))
                    + `. Approved by ${v(b.approvedByUserId)} (${b.approvalSource}) at ${b.approvedAt}; replaced `
                    + `previousManifestHash ${v(b.previousManifestHash)}.`
                    + (a.revision === b.revision
                        ? ' The revision did not move, which a change made through the product always does.'
                        : '')
                    + declaration,
                pinItem(c, b.toolName),
            );
        },
    });

    // P7 — a re-grant (new createdAt) counts as added.
    planKeyed<PassportGrant>(prior.grantedAgents, p.grantedAgents, (g) => `${g.agentId}\u0000${g.toolName}`, {
        added: (g) =>
            push(
                'GRANT_ADDED',
                'P7',
                'MEDIUM',
                `Agent ${g.agentId} was granted tool ${g.toolName} on connection ${c} by ${g.grantedByUserId} at `
                    + `${g.createdAt}: another agent can reach the third party.`,
                grantItem(c, g),
            ),
        removed: (g) =>
            push(
                'GRANT_REMOVED',
                'P7',
                'LOW',
                `Agent ${g.agentId} no longer holds tool ${g.toolName} on connection ${c} (granted by `
                    + `${g.grantedByUserId} at ${g.createdAt}).`,
                grantItem(c, g),
            ),
        changed: (a, b) => {
            if (a.createdAt === b.createdAt) return;
            push(
                'GRANT_ADDED',
                'P7',
                'MEDIUM',
                `Agent ${b.agentId} was granted tool ${b.toolName} on connection ${c} again, by `
                    + `${b.grantedByUserId} at ${b.createdAt} (the grant on record had been made at ${a.createdAt}).`,
                grantItem(c, b),
            );
        },
    });

    // P8 — ordinal, never an inequality.
    const from = LADDER.indexOf(prior.writeRung.mode);
    const to = LADDER.indexOf(p.writeRung.mode);
    if (from !== to) {
        push(
            to > from ? 'WRITE_RUNG_WIDENED' : 'WRITE_RUNG_NARROWED',
            'P8',
            to > from ? 'HIGH' : 'LOW',
            `The external write rung of connection ${c} moved ${prior.writeRung.mode} → ${p.writeRung.mode} `
                + `(in force since ${v(p.writeRung.since)}).`,
        );
    }

    // P9
    planKeyed<PassportPairing>(prior.priorStatePairings, p.priorStatePairings, (x) => x.writeToolName, {
        added: (x) =>
            push(
                'PAIRING_ADDED',
                'P9',
                'MEDIUM',
                `Write tool ${x.writeToolName} on connection ${c} is now paired with prior-state read `
                    + `${x.readToolName} (approved by ${v(x.approvedByUserId)}).`,
                pairingItem(c, x.writeToolName),
            ),
        removed: (x) =>
            push(
                'PAIRING_REMOVED',
                'P9',
                'MEDIUM',
                `Write tool ${x.writeToolName} on connection ${c} is no longer paired with a prior-state read `
                    + `(it was ${x.readToolName}).`,
                pairingItem(c, x.writeToolName),
            ),
        changed: (a, b) => {
            if (a.readToolName === b.readToolName) return;
            push(
                'PAIRING_REPOINTED',
                'P9',
                'MEDIUM',
                `The prior-state read for write tool ${b.writeToolName} on connection ${c} moved `
                    + `${a.readToolName} → ${b.readToolName} (approved by ${v(b.approvedByUserId)}).`,
                pairingItem(c, b.writeToolName),
            );
        },
    });

    // P10
    planKeyed<PassportParameterSet>(prior.parameterSets, p.parameterSets, (s) => s.id, {
        added: (s) =>
            push(
                'PARAMETER_SET_ADDED',
                'P10',
                'MEDIUM',
                `Parameter set ${s.id} for tool ${s.toolName} on connection ${c} was added at revision `
                    + `${s.revision} (${s.approvalSource}, parametersHash ${s.parametersHash}, target population `
                    + `${v(s.targetPopulation)}).`,
                setItem(s.id),
            ),
        removed: (s) =>
            push(
                'PARAMETER_SET_REMOVED',
                'P10',
                'MEDIUM',
                `Parameter set ${s.id} for tool ${s.toolName} on connection ${c} is gone. It was at revision `
                    + `${s.revision} with parametersHash ${s.parametersHash}.`,
                setItem(s.id),
            ),
        changed: (a, b) => {
            if (a.revision !== b.revision) {
                push(
                    'PARAMETER_SET_REVISED',
                    'P10',
                    'MEDIUM',
                    `Parameter set ${b.id} for tool ${b.toolName} on connection ${c} moved from revision `
                        + `${a.revision} to ${b.revision}: parametersHash ${a.parametersHash} → ${b.parametersHash}, `
                        + `approved by ${v(b.approvedByUserId)} (${b.approvalSource}).`,
                    setItem(b.id),
                );
            }
            if (a.targetPopulation !== b.targetPopulation) {
                push(
                    'PARAMETER_SET_TARGET_CHANGED',
                    'P10',
                    'HIGH',
                    `The target population of parameter set ${b.id} for tool ${b.toolName} on connection ${c} `
                        + `changed: ${v(a.targetPopulation)} → ${v(b.targetPopulation)}. It decides which rows an `
                        + 'AUTOMATIC write may be about.',
                    setItem(b.id),
                );
            }
        },
    });

    // P11 — a change TO nobody is CONNECTION_OWNER_MISSING, not this.
    if (prior.owner.userId !== p.owner.userId && p.owner.userId !== null) {
        push(
            'OWNER_CHANGED',
            'P11',
            'MEDIUM',
            `The accountable owner of connection ${c} changed: ${v(prior.owner.userId)} → ${p.owner.userId}`
                + (p.owner.accountable ? '.' : ', who holds no active membership of this tenant.'),
        );
    }

    // P12 — ok to error only. Age is reported, never drift.
    if (prior.lastValidated.status === 'ok' && p.lastValidated.status === 'error') {
        push(
            'CONNECTION_TEST_FAILED',
            'P12',
            'MEDIUM',
            `The last test of connection ${c} moved ok → error (tested at ${v(p.lastValidated.at)}).`,
        );
    }
}

// ── Reassignment ─────────────────────────────────────────────────────────────

/** Each connection's accountable owner this week, or null for the OWNER role. */
export function accountableOwners(passports: readonly IntegrationPassport[]): ReadonlyMap<string, string | null> {
    return new Map(passports.map((p) => [p.connectionId, ownerOf(p)]));
}

/**
 * Who a stored passport finding should be assigned to now, or `undefined` when
 * it is not this sweep's to move: a tenant-level finding, or one about a
 * connection that is not in this week's passports (vanished, or past a cap).
 *
 * Rule 3, held while the finding is open: the connection's accountable owner,
 * and the OWNER role (null) while it has none. `CONNECTION_OWNER_MISSING` and
 * `CONNECTION_VANISHED` are always the OWNER role's.
 */
export function intendedAssignee(
    sourceRef: string,
    owners: ReadonlyMap<string, string | null>,
): string | null | undefined {
    const at = sourceRef.indexOf(':');
    if (at <= 0) return undefined;
    const connectionId = sourceRef.slice(0, at);
    if (connectionId === TENANT_SUBJECT || !owners.has(connectionId)) return undefined;
    if (sourceRef === stateRef(connectionId, 'P11', 'OWNER_MISSING') || sourceRef === vanishedRef(connectionId)) {
        return null;
    }
    return owners.get(connectionId) ?? null;
}

/**
 * A stored description, its ownership tail rewritten for a move `from → to`.
 *
 * Only the tail moves, so a person's edit above it survives. The fallback
 * sentence goes when there is an owner and comes back when there is none. The
 * self-made sentence was true of the assignee it was written for, so on a move
 * it is restated about that person by id rather than left to describe the new
 * one.
 */
export function reassignedDescription(description: string, from: string | null, to: string | null): string {
    const fallback = ` ${OWNER_ROLE_FALLBACK}`;
    let d = description;
    if (d.endsWith(fallback)) d = d.slice(0, -fallback.length);
    if (from !== null && from !== to && d.endsWith(SELF_MADE_SENTENCE)) {
        d = `${d.slice(0, -SELF_MADE_SENTENCE.length)} This change was made by ${from}, its assignee when it was raised.`;
    }
    return to === null ? `${d}${fallback}` : d;
}

function pinItem(connectionId: string, toolName: string) {
    return { ref: bareToolName(connectionId, toolName), match: toolName, label: toolName };
}

function grantItem(connectionId: string, g: PassportGrant) {
    return {
        ref: `${g.agentId}/${bareToolName(connectionId, g.toolName)}`,
        match: `${g.agentId}\u0000${g.toolName}`,
        label: `${g.agentId}/${g.toolName}`,
    };
}

function pairingItem(connectionId: string, writeToolName: string) {
    return { ref: bareToolName(connectionId, writeToolName), match: writeToolName, label: writeToolName };
}

function setItem(id: string) {
    return { ref: id, match: id, label: id };
}

/** Walk two keyed lists in key order, calling added / removed / changed. */
function planKeyed<T>(
    before: readonly T[],
    after: readonly T[],
    keyOf: (t: T) => string,
    on: { added: (t: T) => void; removed: (t: T) => void; changed: (a: T, b: T) => void },
): void {
    const a = new Map(before.map((t) => [keyOf(t), t]));
    const b = new Map(after.map((t) => [keyOf(t), t]));
    const keys = [...new Set([...a.keys(), ...b.keys()])].sort(byCodeUnit);
    for (const k of keys) {
        const x = a.get(k);
        const y = b.get(k);
        if (x === undefined && y !== undefined) on.added(y);
        else if (x !== undefined && y === undefined) on.removed(x);
        else if (x !== undefined && y !== undefined) on.changed(x, y);
    }
}
