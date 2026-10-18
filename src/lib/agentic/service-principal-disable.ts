/**
 * DISABLING A CONTAINED AGENT'S ENTRA SERVICE PRINCIPAL — the pure half
 * (#3671, step 2c of the agentic IAM roadmap).
 *
 * When the owner-orphan pass contains an agent (an `OWNER_DEPARTED` kill and a
 * suspension), the agent is stopped INSIDE Inflect: its keys are refused at the
 * MCP boundary and its runs are killed. Its identity in the customer's
 * directory is untouched — a service principal with a client secret can still
 * obtain tokens for whatever else it was granted. This step closes that half,
 * and it does so ONLY through the external write ladder: a paired prior-state
 * read, a journal row, the connection's rung. Nothing here calls Microsoft
 * Graph; nothing here can.
 *
 * This module holds what both sides of the wire must agree on and that needs no
 * database: the two tool names, the target field, the population key, how an
 * agent's principal is named, how the read's answer is parsed, and the outcome
 * vocabulary the pass records.
 *
 * ═══ HOW AN AGENT NAMES ITS SERVICE PRINCIPAL ═══
 *
 * `RegisteredAgent` carries no directory column, and none is added here. The
 * link that already exists is the harness ingest's: a `DiscoveredAgent` row
 * whose `discoveredId` is `entra:sp:<objectId>` (the contract's own example,
 * `docs/agent-harness-contract.md`) and whose `registeredAgentId` points at the
 * register row. The ingest sets that column ONLY when the register row exists
 * in this tenant, and `discoveredId` is unique per tenant, so one principal
 * reconciles to at most one agent. An agent reconciled to MORE than one
 * `entra:sp:` principal is refused as ambiguous rather than resolved — a
 * directory write names one object, and the first of several is a guess.
 *
 * @module lib/agentic/service-principal-disable
 */

/** The write, as the outbound endpoint advertises it. */
export const SERVICE_PRINCIPAL_DISABLE_TOOL = 'disable_service_principal';

/** The paired prior-state read, as the outbound endpoint advertises it. */
export const SERVICE_PRINCIPAL_READ_TOOL = 'read_service_principal_state';

/**
 * The ONE argument both tools take: the principal's directory object id.
 *
 * One name for both, on purpose. The dispatch calls the paired read with the
 * WRITE's own arguments verbatim (`external-prior-state-read`), so a read whose
 * argument were spelled differently could not honestly be paired.
 */
export const SERVICE_PRINCIPAL_TARGET_FIELD = 'servicePrincipalId';

/**
 * The target population an `AUTOMATIC` template for the disable must name.
 *
 * Defined in `usecases/external-tool-target-populations.ts`; the key lives
 * here so the request path, the population registry and the tests agree on one
 * spelling.
 */
export const CONTAINED_AGENT_SP_POPULATION = 'contained_orphan_agent_entra_service_principals';

/** The harness id prefix for an Entra service principal. */
export const ENTRA_SP_DISCOVERED_PREFIX = 'entra:sp:';

/** Where the outbound endpoint is served. The binding check compares against it. */
export const SERVICE_PRINCIPAL_ENDPOINT_PATH = '/api/mcp/entra-service-principal';

const OBJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The directory object id a harness id names, LOWER-CASED, or null.
 *
 * Null for anything that is not `entra:sp:<GUID>`. The value is spliced into a
 * Graph request path on the far side, so a shape check here is the first of two
 * (the provider client re-checks), and a value that is not a GUID must not
 * become a target at all.
 *
 * Lower-cased because a GUID is case-insensitive and the same principal must
 * produce the same string in the population, in the arguments and in the
 * journal — a set-membership test over two spellings of one id would refuse
 * the write for a reason nobody could see.
 */
export function servicePrincipalObjectIdOf(discoveredId: string): string | null {
    if (!discoveredId.startsWith(ENTRA_SP_DISCOVERED_PREFIX)) return null;
    const id = discoveredId.slice(ENTRA_SP_DISCOVERED_PREFIX.length).trim();
    return OBJECT_ID_RE.test(id) ? id.toLowerCase() : null;
}

/** Is this a directory object id? The request path's argument check. */
export function isDirectoryObjectId(value: unknown): value is string {
    return typeof value === 'string' && OBJECT_ID_RE.test(value.trim());
}

/** One principal as the read tool reports it. Identifying fields only. */
export interface ServicePrincipalFacts {
    /** Lower-cased object id. */
    readonly id: string;
    /** TRUE means enabled; FALSE disabled. Never inferred. */
    readonly accountEnabled: boolean;
    readonly appId: string | null;
    readonly displayName: string | null;
    readonly servicePrincipalType: string | null;
    readonly appOwnerOrganizationId: string | null;
}

/**
 * The read tool's answer, unwrapped from the MCP envelope — or null when it is
 * not a readable answer at all.
 *
 * ONE parser, used by the request path (is there something to disable?) and by
 * the reconcile (did it become disabled?). Two parsers of one shape is the
 * defect `external-write-reconcile.ts` records for the grant: the copy that
 * read the wrong field promoted nothing for weeks.
 *
 * NULL IS NOT "ENABLED" AND NOT "DISABLED". An error result, a missing text
 * part, unparseable JSON, a missing id or an `accountEnabled` that is not a
 * boolean all return null, and every caller treats null as "we could not
 * look". The dangerous misreading is an absent `accountEnabled` read as
 * `false` — that would promote a write that never landed.
 */
export function servicePrincipalFactsOf(result: unknown): ServicePrincipalFacts | null {
    if (!result || typeof result !== 'object') return null;
    const r = result as { content?: unknown; isError?: unknown };
    if (r.isError === true) return null;
    if (!Array.isArray(r.content)) return null;

    let text: string | null = null;
    for (const part of r.content) {
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
            text = (part as { text: string }).text;
            break;
        }
    }
    if (text === null) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    const sp = (parsed as { servicePrincipal?: unknown } | null)?.servicePrincipal;
    if (!sp || typeof sp !== 'object') return null;
    const o = sp as Record<string, unknown>;
    if (typeof o.id !== 'string' || !OBJECT_ID_RE.test(o.id)) return null;
    if (typeof o.accountEnabled !== 'boolean') return null;

    const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
    return {
        id: o.id.toLowerCase(),
        accountEnabled: o.accountEnabled,
        appId: str(o.appId),
        displayName: str(o.displayName),
        servicePrincipalType: str(o.servicePrincipalType),
        appOwnerOrganizationId: str(o.appOwnerOrganizationId),
    };
}

/**
 * What one request to disable a contained agent's principal came to.
 *
 * Every arm is a FACT about this pass, never a guess, and each one is fixed by a
 * different action — which is why they are not collapsed into "skipped".
 */
export type ServicePrincipalDisableStatus =
    /** No `entra:sp:` principal is reconciled to this agent. Nothing to do. */
    | 'NOT_LINKED'
    /** More than one is. Refused rather than choosing. */
    | 'AMBIGUOUS_LINK'
    /** No `OWNER_DEPARTED` kill is in force for the agent, so it is not contained. */
    | 'NOT_CONTAINED'
    /** No `disable_service_principal` write has a nominated prior-state read here. */
    | 'NO_PAIRED_ENDPOINT'
    /** More than one has. Refused rather than choosing a directory. */
    | 'AMBIGUOUS_PAIRED_ENDPOINT'
    /** The paired connection is missing, disabled, has no URL or unusable credentials. */
    | 'CONNECTION_UNUSABLE'
    /** The connection's external-write rung is DISABLED. Nothing was read or written. */
    | 'RUNG_DISABLED'
    /** AUTOMATIC with no approved template bound to the contained-agent population. */
    | 'NO_APPROVED_TEMPLATE'
    /** AUTOMATIC with more than one such template. Refused rather than choosing. */
    | 'AMBIGUOUS_TEMPLATE'
    /** AUTOMATIC, and the population does not admit this principal right now. */
    | 'NOT_IN_POPULATION'
    /** The paired read failed or did not answer in the read tool's shape. Refused. */
    | 'PRIOR_STATE_UNREADABLE'
    /** The read shows the principal already disabled. Nothing to write. */
    | 'ALREADY_DISABLED'
    /** DRY_RUN: the intent and its prior state were journalled; nothing was sent. */
    | 'RECORDED_INTENT'
    /** PROPOSE_ONLY: an EXTERNAL_WRITE proposal is waiting for a human. */
    | 'PROPOSED'
    /** PROPOSE_ONLY: the proposal guard quarantined it. It will not be reviewed. */
    | 'QUARANTINED'
    /** AUTOMATIC: a PENDING journal row carrying the prior state awaits the dispatch. */
    | 'QUEUED'
    /** The ladder's own arm refused (rate cap, Art 12 record, guard). Nothing was sent. */
    | 'REFUSED'
    /** Something threw that this module did not expect. Nothing is assumed sent. */
    | 'FAILED';

/** One request's record — what the orphan pass writes on the decision. */
export interface ServicePrincipalDisableRecord {
    readonly status: ServicePrincipalDisableStatus | 'WOULD_REQUEST_DISABLE';
    /**
     * The `DiscoveredAgent` row that named the principal — a cuid. The
     * principal's own object id is deliberately NOT recorded on the execution
     * row: `IntegrationExecution.resultJson` is not encrypted, and a directory
     * identifier belongs in the encrypted journal, not beside it.
     */
    readonly discoveredAgentId?: string;
    /** The rung the paired connection was at, when one was resolved. */
    readonly rung?: string;
    readonly connectionId?: string;
    readonly journalId?: string;
    readonly proposalId?: string;
    /** Our own sentence, bounded. Never the far end's text, never an id. */
    readonly detail?: string;
}

/**
 * The outcomes that mean "a disable was due and did not happen for a reason an
 * operator must fix" — they make the orphan pass PARTIAL.
 *
 * NOT in this set, and deliberately: `NOT_LINKED`, `NO_PAIRED_ENDPOINT` and
 * `RUNG_DISABLED`. Those are the DEFAULT for every tenant that has not set this
 * up, and counting them would turn every pass in the product PARTIAL — a status
 * that is always on is a status nobody reads.
 */
const ATTENTION: ReadonlySet<ServicePrincipalDisableRecord['status']> = new Set([
    'AMBIGUOUS_LINK',
    'NOT_CONTAINED',
    'AMBIGUOUS_PAIRED_ENDPOINT',
    'CONNECTION_UNUSABLE',
    'NO_APPROVED_TEMPLATE',
    'AMBIGUOUS_TEMPLATE',
    'NOT_IN_POPULATION',
    'PRIOR_STATE_UNREADABLE',
    'QUARANTINED',
    'REFUSED',
    'FAILED',
]);

export function servicePrincipalDisableNeedsAttention(
    record: Pick<ServicePrincipalDisableRecord, 'status'>,
): boolean {
    return ATTENTION.has(record.status);
}
