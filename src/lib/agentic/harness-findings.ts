/**
 * WHAT ONE VERIFIED HARNESS REPORT MEANS (#3665) — a pure planner.
 *
 * Input: a report body that has already passed `verifyAndParseHarnessReport`
 * (signature by a trusted key, then the strict schema), and what the tenant
 * already knows — the levels the previous scans derived, which register rows
 * exist, which shortfalls are under an active acceptance. Output: each agent's
 * DERIVED level and reach, and the findings that are currently true or that
 * this scan proves resolved. `usecases/agent-harness-scans.ts` executes the
 * plan; nothing here touches a database, so every rule below is a unit test.
 *
 * ── LEVELS ARE DERIVED, NEVER READ ──────────────────────────────────────────
 *
 * The contract has no `level` member and the strict schema refuses one. The
 * level is `scoreHarness` over the reported verdicts, where unanswered counts
 * as no and a "met" with no evidence is not met.
 *
 * ── REACH ───────────────────────────────────────────────────────────────────
 *
 *   WRITE_OR_EXTERNAL  any tool not declared read-only (an undeclared hint is a
 *                      write, as the contract says)
 *   UNKNOWN            no such tool, but the `mcp` source was not read in full,
 *                      so a write tool may be missing from the report
 *   READ_ONLY          every tool declared read-only, and the `mcp` source was
 *                      read in full
 *
 * UNKNOWN is held to the higher bar (`shortfallBarFor`). "External" is not
 * distinguished from "write-capable" yet: both meet the higher bar, and
 * telling a read-only external tool from an internal one needs an inventory
 * of which servers are internal, which the contract does not carry.
 *
 * ── THE REGISTER LINK, AND THE INTAKE'S OWN RECORD OF IT (#3712) ────────────
 *
 * A report's `registeredAgentId` links only to a row the register holds; a
 * claimed id it does not hold is no link at all (`docs/agent-harness-contract.md`).
 * When a report carries no such link, the register may still know the agent:
 * the registration intake records the discovered agent it registered a row from
 * on `RegisteredAgent.intakeDiscoveredAgentId`. That is the register's own
 * evidence, not the scanner's claim, and it links the agent when the row is
 * live and in a linkable status (`INTAKE_LINKABLE_STATUSES` — an allowlist, so
 * RETIRED and any status added later are never linked). Three rules hold it:
 *
 *   • A REPORT THAT NAMES A LIVE REGISTER ROW WINS, even one other than the
 *     intake's. The disagreement is returned as an `intakeConflicts` entry for
 *     the ingest to audit; the intake's record never overrides a claim the
 *     register holds.
 *   • THE INTAKE LINK CLOSES `SHADOW_AGENT` ONLY ON A COMPLETE SCAN
 *     (`isScanComplete`). An incomplete scan still links the agent — the link is
 *     the register's evidence, and dropping it on every incomplete scan would
 *     flip the agent between shadow and registered — but it neither raises nor
 *     resolves the finding. A link the REPORT claimed still closes it on any
 *     scan; that asymmetry is an owner decision (2026-10-18).
 *   • AN AGENT ABSENT FROM THE SCAN IS UNTOUCHED, as always: the planner only
 *     iterates the agents the report names.
 *
 * ── FINDINGS, AND WHEN THIS SCAN MAY CLOSE ONE ──────────────────────────────
 *
 * Every finding is keyed by a `sourceRef` so re-ingesting is idempotent:
 *
 *   SHADOW_AGENT:<discoveredId>              not in the register (whatever the
 *                                            report claims, the register decides)
 *   UNPINNED_WRITE_TOOL:<discoveredId>       a write-capable tool with no pin
 *   LEVEL_DROP:<discoveredId>:<scanRef>      the level fell since the last scan —
 *                                            an event, never closed by a scan
 *   HARNESS_SHORTFALL:<discoveredId>         below the report-only bar
 *   EMPTY_SCAN:<scannerAgentId>              the scanner found no agents at all
 *   INCOMPLETE_SOURCE:<scannerAgentId>:<kind> a source it could not read in full
 *   ORPHAN_CREDENTIAL:<scannerAgentId>:<kind>:<ref>
 *                                            `/2` only: a credential that source
 *                                            saw bound to no discovered agent
 *
 * A scan closes a finding only on POSITIVE evidence: an agent now in the
 * register, a level now at the bar, a source now read in full, a population now
 * non-empty, and "no unpinned write tool" only when every source that could
 * have reported the agent's tools was read in full (`toolEvidenceSourcesOf`,
 * below). An agent ABSENT from a scan closes nothing — a tenant may run more
 * than one scanner, and one scanner not seeing an agent is not evidence that
 * the agent is gone.
 *
 * ── "NO UNPINNED WRITE TOOL": WHICH READ IS THE EVIDENCE (#3754) ────────────
 *
 * Owner answer, 2026-10-19: a tool defined in code is judged by a complete
 * `code` read, and an MCP-served tool by a complete `mcp` read, as before.
 * Which a tool is follows its `server`: a `code://` locator is the contract's
 * name for a tool the agent's code defines or constructs, or for an MCP server
 * the code starts as a local command (`docs/agent-harness-contract.md`, The
 * `code` source); any other `server` is an MCP server's URL. The finding closes
 * only when EVERY source the agent's tools are judged by was read in full:
 *
 *   • each tool the report lists, by its own `server`;
 *   • a tool the report LEFT OUT, by where it would have been: in the
 *     definition a `code` source read, for an agent discovered via `code`, and
 *     on an MCP server, for an agent discovered via any other kind. An agent
 *     reported with no tools at all is therefore never closed on nothing.
 *
 * So a complete `code` read never closes an MCP-served tool, and a complete
 * `mcp` read never closes a code-defined one. Reach is unchanged by this: an
 * agent is READ_ONLY only when the `mcp` source was read in full.
 *
 * ── ORPHAN_CREDENTIAL, DERIVED FROM `unboundCredentials[]` (#3754) ──────────
 *
 * The report's own `findings` member is never acted on, so a scanner cannot
 * raise this finding by saying so. A `/2` report lists the credentials each
 * source saw bound to no agent, and the planner decides:
 *
 *   • IT OPENS ONLY WHEN THAT SOURCE, AND EVERY IDENTITY-BEARING SOURCE IN THE
 *     SAME SCAN, WAS READ IN FULL (owner answer, 2026-10-19). "Unbound" means
 *     no agent in the report holds the reference, and the agent that holds it
 *     may be one a source that stopped early never reported. An
 *     identity-bearing source is one that can report the agent a credential is
 *     bound to (`IDENTITY_BEARING_SOURCE`, below); a kind the scan does not
 *     list is not read at all, and does not hold the finding back.
 *   • IT CLOSES ONLY WHEN THE SAME SCANNER READ THE SAME SOURCE IN FULL AND NO
 *     LONGER SEES IT UNBOUND — unchanged by the tightening. The key carries the
 *     scanner and the source kind, because two scanners' `vault` sources can be
 *     two different vaults: one scanner's complete read is no evidence about
 *     the other's. An incomplete identity source cannot make a credential look
 *     BOUND, only unbound, so it does not hold a close back; but a credential
 *     the source still lists is never closed, whether or not this scan could
 *     open it.
 *   • AN ABSENT OR INCOMPLETE SOURCE CLOSES NOTHING, and neither does a `/1`
 *     report: it has no member to say anything about unbound credentials, and
 *     its silence is not a statement that there are none. An incomplete
 *     identity source therefore opens nothing and closes nothing.
 *
 * The open findings it may close are the ingest's to read
 * (`PriorHarnessState.openOrphanCredentials`), because closing is about rows the
 * report does not mention.
 *
 * ── THE BAR IS REPORT-ONLY ──────────────────────────────────────────────────
 *
 * A shortfall is a finding, never a refusal. Nothing here is consulted by the
 * authority funnel, and `eslint.config.mjs` keeps the ladder out of it.
 *
 * PURE: no clock, no I/O.
 */
import {
    isShortfall,
    rungOf,
    scoreHarness,
    shortfallBarFor,
    type CriterionVerdict,
    type HarnessCriterionId,
    type HarnessLevel,
    type HarnessReach,
} from './harness-ladder';
import type { HarnessReportAgent, HarnessReportBody, HarnessUnboundCredential, SOURCE_KINDS } from './harness-contract';
import { HARNESS_CONTRACT_V2, isScanComplete, looksLikeSecret } from './harness-contract-rules';

/**
 * The path of the first string member of a verified body whose value is
 * secret-shaped, or null (DPIA condition 10, `docs/agentic-harness-scanner-dpia.md`).
 *
 * The contract refuses a secret-shaped value inside a credential reference
 * only. Every other string — an id, a tool name, an evidence pointer, a server
 * URL — is free for a careless or compromised scanner to fill, and the ingest
 * stores most of them. So the ingest refuses a report in which ANY string
 * matches, and names the member, never the value: the refusal reaches a log
 * line, and repeating the secret there would be the leak it prevents.
 */
export function firstSecretShapedMember(body: HarnessReportBody): string | null {
    const walk = (node: unknown, path: string): string | null => {
        if (typeof node === 'string') return looksLikeSecret(node) ? path : null;
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) {
                const hit = walk(node[i], `${path}[${i}]`);
                if (hit) return hit;
            }
            return null;
        }
        if (node !== null && typeof node === 'object') {
            for (const [key, value] of Object.entries(node)) {
                const hit = walk(value, path ? `${path}.${key}` : key);
                if (hit) return hit;
            }
        }
        return null;
    };
    return walk(body, '');
}

/** The `Finding.sourceKind` every harness finding carries — its reconcile key space. */
export const HARNESS_FINDING_SOURCE_KIND = 'AGENT_HARNESS';

export const HARNESS_FINDING_CODES = [
    'SHADOW_AGENT',
    'UNPINNED_WRITE_TOOL',
    'LEVEL_DROP',
    'HARNESS_SHORTFALL',
    'EMPTY_SCAN',
    'INCOMPLETE_SOURCE',
    'ORPHAN_CREDENTIAL',
] as const;
export type HarnessFindingCode = (typeof HARNESS_FINDING_CODES)[number];

/** The stored reach, as the `AgentHarnessReach` enum spells it. */
export type StoredReach = 'READ_ONLY' | 'WRITE_OR_EXTERNAL' | 'UNKNOWN';

const LADDER_REACH: Record<StoredReach, HarnessReach | 'unknown'> = {
    READ_ONLY: 'read-only',
    WRITE_OR_EXTERNAL: 'write-or-external',
    UNKNOWN: 'unknown',
};

/** How many unpinned tools a finding names before it stops listing. */
const MAX_TOOLS_NAMED = 10;

export interface PlannedFinding {
    readonly code: HarnessFindingCode;
    readonly sourceRef: string;
    readonly severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    readonly type: 'NONCONFORMITY' | 'OBSERVATION';
    readonly title: string;
    readonly description: string;
}

export interface PlannedAgent {
    readonly discoveredId: string;
    readonly discoveredVia: readonly string[];
    /** The register row, when it exists in this tenant; null is SHADOW. */
    readonly registeredAgentId: string | null;
    /**
     * Where the link came from: a claim of the report's that the register
     * holds, the registration intake's own record, or nothing (SHADOW).
     */
    readonly linkBasis: 'REPORT' | 'INTAKE' | null;
    readonly ownerKind: 'user' | 'group' | null;
    readonly ownerRef: string | null;
    readonly level: HarnessLevel;
    readonly reach: StoredReach;
    readonly blockingNextRung: readonly HarnessCriterionId[];
    readonly verdicts: readonly CriterionVerdict[];
    readonly tools: HarnessReportAgent['tools'];
}

/**
 * A register row the registration intake created from a discovered agent, as
 * the register stores it (#3669): `RegisteredAgent.intakeDiscoveredAgentId`.
 */
export interface IntakeClaim {
    readonly registeredAgentId: string;
    /** The row's `AgentStatus`, as stored. */
    readonly status: string;
    /** Soft-deleted (`deletedAt` set). */
    readonly deleted: boolean;
}

/**
 * The statuses in which an intake row links its discovered agent. An
 * ALLOWLIST: RETIRED is out of service and never linked, and a status added to
 * the enum later is not linked until somebody adds it here.
 */
export const INTAKE_LINKABLE_STATUSES: readonly string[] = ['DRAFT', 'ACTIVE', 'SUSPENDED'];

/** May this intake row link the discovered agent it was registered from? Live, and in a linkable status. */
export function isIntakeClaimLinkable(claim: Pick<IntakeClaim, 'status' | 'deleted'>): boolean {
    return !claim.deleted && INTAKE_LINKABLE_STATUSES.includes(claim.status);
}

/**
 * The intake rows a scan's known discovered agents were registered into, keyed
 * by `discoveredId` — the key the report speaks in. A row naming a discovered
 * agent the ingest did not load (another tenant's, or one this scan does not
 * report) is dropped here, so it can link nothing.
 */
export function intakeClaimsByDiscoveredId(
    known: readonly { readonly id: string; readonly discoveredId: string }[],
    rows: readonly {
        readonly id: string;
        readonly status: string;
        readonly deletedAt: Date | null;
        readonly intakeDiscoveredAgentId: string | null;
    }[],
): ReadonlyMap<string, IntakeClaim> {
    const discoveredIdOf = new Map(known.map((k) => [k.id, k.discoveredId]));
    const claims = new Map<string, IntakeClaim>();
    for (const r of rows) {
        const discoveredId = r.intakeDiscoveredAgentId === null ? undefined : discoveredIdOf.get(r.intakeDiscoveredAgentId);
        if (discoveredId === undefined) continue;
        claims.set(discoveredId, { registeredAgentId: r.id, status: r.status, deleted: r.deletedAt !== null });
    }
    return claims;
}

export interface PriorHarnessState {
    /** The level each already-known discovered agent was last derived at. */
    readonly previousLevels: ReadonlyMap<string, HarnessLevel>;
    /** Register rows that exist (and are not deleted) in this tenant. */
    readonly registeredAgentIds: ReadonlySet<string>;
    /** Discovered agents whose shortfall is under an unexpired, unrevoked acceptance. */
    readonly acceptedShortfalls: ReadonlySet<string>;
    /** The intake row each known discovered agent was registered into, by `discoveredId` (#3712). */
    readonly intakeClaims: ReadonlyMap<string, IntakeClaim>;
    /**
     * The `sourceRef`s of this scanner's ORPHAN_CREDENTIAL findings that are not
     * CLOSED (#3754). The planner closes one only on a complete read of its
     * source that no longer sees it unbound; a ref of another scanner's is
     * ignored, whoever passed it.
     */
    readonly openOrphanCredentials: ReadonlySet<string>;
}

/**
 * A report linked an agent to a live register row OTHER than the one the
 * intake registered from it. The report's link stands; this records that the
 * register's own record disagreed.
 */
export interface IntakeConflict {
    readonly discoveredId: string;
    readonly reportedRegisteredAgentId: string;
    readonly intakeRegisteredAgentId: string;
}

export interface HarnessPlan {
    readonly agents: readonly PlannedAgent[];
    /** Conditions true as of this scan: open, or reopen if closed. */
    readonly assert: readonly PlannedFinding[];
    /** Findings this scan proves resolved, by `sourceRef`. */
    readonly resolve: readonly string[];
    /** Reports overriding the intake's record (#3712), for the ingest to audit. */
    readonly intakeConflicts: readonly IntakeConflict[];
}

/** Is this tool one the bar treats as a write? An undeclared hint is a write. */
export function isWriteCapable(tool: { readOnlyHint: boolean | null }): boolean {
    return tool.readOnlyHint !== true;
}

export function reachOf(agent: Pick<HarnessReportAgent, 'tools'>, mcpReadInFull: boolean): StoredReach {
    if (agent.tools.some(isWriteCapable)) return 'WRITE_OR_EXTERNAL';
    return mcpReadInFull ? 'READ_ONLY' : 'UNKNOWN';
}

/** A source kind any accepted contract id can carry. */
export type HarnessSourceKind = (typeof SOURCE_KINDS)[number];

/** The source a tool is judged by: its definition in code, or the MCP server that serves it. */
export type ToolEvidenceSource = Extract<HarnessSourceKind, 'code' | 'mcp'>;

/** How the contract names a tool defined in code: its `server` is the `code://` locator of that definition. */
const CODE_LOCATOR_PREFIX = 'code://';

/**
 * The source whose complete read is evidence about one tool (#3754, owner
 * answer 2026-10-19): `code` for a tool whose `server` is a `code://` locator,
 * `mcp` for any other.
 */
export function toolEvidenceSource(tool: { readonly server: string }): ToolEvidenceSource {
    return tool.server.startsWith(CODE_LOCATOR_PREFIX) ? 'code' : 'mcp';
}

/**
 * Every source that must have been read in full before this agent's report is
 * evidence that it has no unpinned write tool: each listed tool's own, and,
 * for a tool the report left out, where it would have been — the definition
 * for an agent discovered via `code`, an MCP server for one discovered via any
 * other kind. Never empty: `discoveredVia` holds at least one kind.
 */
export function toolEvidenceSourcesOf(
    agent: Pick<HarnessReportAgent, 'tools' | 'discoveredVia'>,
): ReadonlySet<ToolEvidenceSource> {
    const sources = new Set<ToolEvidenceSource>(agent.tools.map(toolEvidenceSource));
    for (const via of agent.discoveredVia) sources.add(via === 'code' ? 'code' : 'mcp');
    return sources;
}

/**
 * Which source kinds are IDENTITY-BEARING (#3754, owner answer 2026-10-19):
 * a source that can report the agent a credential is bound to, by reporting
 * the credential among that agent's `credentials[]`. An `ORPHAN_CREDENTIAL`
 * opens only when every one of these the scan lists was read in full, because
 * the agent that binds the credential may be the part an incomplete one did
 * not read.
 *
 * A `Record` over every kind, so a kind added to the contract is a compile
 * error here until somebody decides which it is — never a silent default.
 *
 *   entra-sp          a service principal, and the password and key credentials it holds
 *   okta-app          an app, and its client credentials and API tokens
 *   vault             a credential, tagged with the principal it belongs to
 *   runtime           a deployment, and the secrets it runs with: LangSmith's
 *                     deployment listing carries them, and the reference reader
 *                     declining to read them is that reader's choice, not the
 *                     kind's limit
 *   cicd              a pipeline identity, and the secrets its jobs receive
 *   inflect-register  a registered agent, and the API keys that speak for it
 *   code              an agent definition, and the credential references it reads
 *
 * Exactly one kind is not: `mcp`. A scanner sends an MCP server `initialize`
 * and `tools/list` and nothing else (DPIA condition 1), and neither answer
 * names a caller or holds a credential: an `mcp` read reports servers and the
 * tools they serve, never who binds what.
 */
export const IDENTITY_BEARING_SOURCE: Readonly<Record<HarnessSourceKind, boolean>> = Object.freeze({
    'entra-sp': true,
    'okta-app': true,
    vault: true,
    mcp: false,
    runtime: true,
    cicd: true,
    'inflect-register': true,
    code: true,
});

/** Is this source kind identity-bearing? A kind the table does not name is — the side that opens nothing. */
export function isIdentityBearingSource(kind: string): boolean {
    return Object.hasOwn(IDENTITY_BEARING_SOURCE, kind) ? IDENTITY_BEARING_SOURCE[kind as HarnessSourceKind] : true;
}

export function shortfallRefOf(discoveredId: string): string {
    return `HARNESS_SHORTFALL:${discoveredId}`;
}

const SHADOW_REF_PREFIX = 'SHADOW_AGENT:';

/** The `sourceRef` of a discovered agent's SHADOW_AGENT finding. */
export function shadowRefOf(discoveredId: string): string {
    return `${SHADOW_REF_PREFIX}${discoveredId}`;
}

/**
 * The `discoveredId` a SHADOW_AGENT finding names, or null when the finding is
 * not one — the inverse of `shadowRefOf`, read by the registration intake
 * (#3669). A discovered id may itself contain colons (`entra:sp:<objectId>`),
 * so everything after the prefix is the id.
 */
export function discoveredIdOfShadowFinding(finding: {
    sourceKind: string | null;
    sourceRef: string | null;
}): string | null {
    if (finding.sourceKind !== HARNESS_FINDING_SOURCE_KIND) return null;
    if (!finding.sourceRef?.startsWith(SHADOW_REF_PREFIX)) return null;
    const id = finding.sourceRef.slice(SHADOW_REF_PREFIX.length);
    return id.length > 0 ? id : null;
}

/** Is this stored (level, reach) below the report-only bar? */
export function isHarnessShortfall(level: HarnessLevel, reach: StoredReach): boolean {
    return isShortfall(level, LADDER_REACH[reach]);
}

/** The report-only bar for a stored reach — `shortfallBarFor`, spelled the way the DB spells reach. */
export function harnessBarFor(reach: StoredReach): HarnessLevel {
    return shortfallBarFor(LADDER_REACH[reach]);
}

/**
 * The shortfall finding, in one place: the ingest raises it and the expiry
 * monitor reopens it, and the two must describe it alike.
 */
export function shortfallFinding(
    discoveredId: string,
    level: HarnessLevel,
    reach: StoredReach,
    because: string,
    blocking: readonly string[] = [],
): PlannedFinding {
    const bar = harnessBarFor(reach);
    return {
        code: 'HARNESS_SHORTFALL',
        sourceRef: shortfallRefOf(discoveredId),
        severity: reach === 'READ_ONLY' ? 'MEDIUM' : 'HIGH',
        type: 'NONCONFORMITY',
        title: `Agent ${discoveredId} is below the harness bar (${level}, bar ${bar})`,
        description:
            `${because} found agent ${discoveredId} at ${level}, whose reach is ${reach}; the bar for that `
            + `reach is ${bar}.`
            + (blocking.length > 0 ? ` Criteria blocking the next rung: ${blocking.join(', ')}.` : '')
            + ' This finding never blocks the agent: it closes when a later scan shows the agent at the '
            + 'bar, or with a time-limited acceptance by the agent’s owner.',
    };
}

const ORPHAN_REF_PREFIX = 'ORPHAN_CREDENTIAL:';

/** Every ORPHAN_CREDENTIAL `sourceRef` one scanner can raise starts with this. */
export function orphanCredentialRefPrefix(scannerAgentId: string): string {
    return `${ORPHAN_REF_PREFIX}${scannerAgentId}:`;
}

/** The `sourceRef` of the ORPHAN_CREDENTIAL one scanner's source raised for one reference. */
export function orphanCredentialRefOf(scannerAgentId: string, sourceKind: string, ref: string): string {
    return `${orphanCredentialRefPrefix(scannerAgentId)}${sourceKind}:${ref}`;
}

function orphanCredentialFinding(scanRef: string, scanner: string, u: HarnessUnboundCredential): PlannedFinding {
    return {
        code: 'ORPHAN_CREDENTIAL',
        sourceRef: orphanCredentialRefOf(scanner, u.sourceKind, u.ref),
        severity: 'MEDIUM',
        type: 'OBSERVATION',
        title: `Credential ${u.ref} is bound to no agent`,
        description:
            `Harness scan ${scanRef} (scanner ${scanner}) read source ${u.sourceKind} in full and saw credential `
            + `${u.ref} bound to no discovered agent, and read in full every source it listed that can report the `
            + 'agent a credential is bound to. A credential no agent uses is one nobody rotates or revokes: '
            + 'retire it, or bind it to the agent that needs it. This finding closes when a complete read of that '
            + 'source no longer sees it unbound.',
    };
}

/** Plan what one verified report means for the tenant. */
export function planHarnessScan(body: HarnessReportBody, prior: PriorHarnessState): HarnessPlan {
    const scanRef = body.scan.id;
    const scanner = body.scan.scanner.agentId;
    const readInFull = new Set<string>(body.population.sources.filter((s) => s.status === 'COMPLETE').map((s) => s.kind));
    const mcpReadInFull = readInFull.has('mcp');
    const scanComplete = isScanComplete(body);
    const assert: PlannedFinding[] = [];
    const resolve: string[] = [];
    const intakeConflicts: IntakeConflict[] = [];
    const where = `scan ${scanRef}, scanner ${scanner}`;

    const agents: PlannedAgent[] = body.agents.map((a) => {
        const score = scoreHarness(a.verdicts);
        const reach = reachOf(a, mcpReadInFull);
        const id = a.discoveredId;

        // THE LINK. A claim the register holds wins; a claim it does not hold
        // is no link at all; with no link, the intake's own record of this
        // agent links it if that row is live and linkable.
        const reported =
            a.registeredAgentId !== null && prior.registeredAgentIds.has(a.registeredAgentId)
                ? a.registeredAgentId
                : null;
        const claim = prior.intakeClaims.get(id);
        const intake = claim !== undefined && isIntakeClaimLinkable(claim) ? claim.registeredAgentId : null;
        if (reported !== null && intake !== null && reported !== intake) {
            intakeConflicts.push({ discoveredId: id, reportedRegisteredAgentId: reported, intakeRegisteredAgentId: intake });
        }
        const registeredAgentId = reported ?? intake;
        const linkBasis: PlannedAgent['linkBasis'] = reported !== null ? 'REPORT' : intake !== null ? 'INTAKE' : null;

        // SHADOW. A link the report claimed is resolved by the register, which
        // is evidence whatever the scan's completeness: the row exists or it
        // does not. A link from the intake's record closes the finding only on
        // a complete scan, and an incomplete one leaves the finding as it is.
        const shadowRef = shadowRefOf(id);
        const shadowHeld = linkBasis === 'INTAKE' && !scanComplete;
        if (registeredAgentId === null) {
            assert.push({
                code: 'SHADOW_AGENT',
                sourceRef: shadowRef,
                severity: 'HIGH',
                type: 'NONCONFORMITY',
                title: `Shadow agent ${id}`,
                description:
                    `A harness scan (${where}) found agent ${id} via ${a.discoveredVia.join(', ')}. `
                    + 'It has no row in the agent register, so it has no accountable owner, no '
                    + 'risk tier and no grants on record. Register it, or retire the principal.',
            });
        } else if (!shadowHeld) {
            resolve.push(shadowRef);
        }

        // UNPINNED WRITE TOOLS. Absence is evidence only when every source
        // the agent's tools are judged by was read: `code` for a tool defined
        // in code, `mcp` for one an MCP server serves.
        const unpinnedRef = `UNPINNED_WRITE_TOOL:${id}`;
        const unpinned = a.tools.filter((t) => isWriteCapable(t) && !t.pinned);
        if (unpinned.length > 0) {
            const named = unpinned.slice(0, MAX_TOOLS_NAMED).map((t) => `${t.name} on ${t.server}`);
            const more = unpinned.length > MAX_TOOLS_NAMED ? ` and ${unpinned.length - MAX_TOOLS_NAMED} more` : '';
            assert.push({
                code: 'UNPINNED_WRITE_TOOL',
                sourceRef: unpinnedRef,
                severity: 'HIGH',
                type: 'NONCONFORMITY',
                title: `Unpinned write-capable tool on agent ${id}`,
                description:
                    `A harness scan (${where}) found ${unpinned.length} write-capable tool(s) with no pinned `
                    + `definition on agent ${id}: ${named.join('; ')}${more}. A tool the agent may call with `
                    + 'a definition nobody reviewed can change under it without anyone noticing.',
            });
        } else if ([...toolEvidenceSourcesOf(a)].every((k) => readInFull.has(k))) {
            resolve.push(unpinnedRef);
        }

        // LEVEL DROP — an event, keyed by the scan that saw it.
        const previous = prior.previousLevels.get(id);
        if (previous !== undefined && rungOf(score.level) < rungOf(previous)) {
            assert.push({
                code: 'LEVEL_DROP',
                sourceRef: `LEVEL_DROP:${id}:${scanRef}`,
                severity: 'MEDIUM',
                type: 'OBSERVATION',
                title: `Harness level of agent ${id} fell from ${previous} to ${score.level}`,
                description:
                    `A harness scan (${where}) derived ${score.level} for agent ${id}, down from ${previous}. `
                    + `Criteria now blocking the next rung: ${score.blockingNextRung.join(', ') || 'none'}.`,
            });
        }

        // SHORTFALL against the report-only bar.
        if (isHarnessShortfall(score.level, reach)) {
            if (!prior.acceptedShortfalls.has(id)) {
                assert.push(shortfallFinding(id, score.level, reach, `A harness scan (${where})`, score.blockingNextRung));
            }
        } else {
            resolve.push(shortfallRefOf(id));
        }

        return {
            discoveredId: id,
            discoveredVia: a.discoveredVia,
            registeredAgentId,
            linkBasis,
            ownerKind: a.owner?.kind ?? null,
            ownerRef: a.owner?.id ?? null,
            level: score.level,
            reach,
            blockingNextRung: score.blockingNextRung,
            verdicts: a.verdicts,
            tools: a.tools,
        };
    });

    // ZERO IS NEVER CLEAN. A scan that found nothing evidences nothing.
    const emptyRef = `EMPTY_SCAN:${scanner}`;
    if (body.agents.length === 0) {
        assert.push({
            code: 'EMPTY_SCAN',
            sourceRef: emptyRef,
            severity: 'HIGH',
            type: 'OBSERVATION',
            title: `Harness scanner ${scanner} found no agents`,
            description:
                `Harness scan ${scanRef} reported no agent-shaped principal at all. An empty population is `
                + 'not a clean result: it is what a scanner reading the wrong tenant, or nothing, looks like.',
        });
    } else {
        resolve.push(emptyRef);
    }

    for (const s of body.population.sources) {
        const ref = `INCOMPLETE_SOURCE:${scanner}:${s.kind}`;
        if (s.status === 'INCOMPLETE') {
            assert.push({
                code: 'INCOMPLETE_SOURCE',
                sourceRef: ref,
                severity: 'MEDIUM',
                type: 'OBSERVATION',
                title: `Harness scanner ${scanner} could not read ${s.kind} in full`,
                description:
                    `Harness scan ${scanRef} read source ${s.kind} incompletely (${s.reason}). Agents and tools `
                    + 'in that source may be missing from the scan, so no finding is closed on its absence.',
            });
        } else {
            resolve.push(ref);
        }
    }

    // ORPHAN CREDENTIALS — `/2` only, and only on positive evidence.
    if (body.contract === HARNESS_CONTRACT_V2) {
        // Opening needs the credential's own source read in full AND every
        // identity-bearing source the scan lists: the agent that binds it may
        // be one an incomplete identity source never reported.
        const everyIdentitySourceRead = body.population.sources.every(
            (s) => s.status === 'COMPLETE' || !isIdentityBearingSource(s.kind),
        );
        // Everything a source still lists, opened or not: a credential a
        // source still sees unbound is never closed, even by a scan that may
        // not open it.
        const stillListed = new Set<string>();
        for (const u of body.unboundCredentials) {
            const finding = orphanCredentialFinding(scanRef, scanner, u);
            stillListed.add(finding.sourceRef);
            if (everyIdentitySourceRead && readInFull.has(u.sourceKind)) assert.push(finding);
        }
        const ownPrefix = orphanCredentialRefPrefix(scanner);
        for (const open of prior.openOrphanCredentials) {
            if (!open.startsWith(ownPrefix) || stillListed.has(open)) continue;
            // Source kinds hold no colon, so the kind is the text before the
            // first one. A ref whose kind this scan did not read in full —
            // absent, or incomplete — is left as it is.
            const rest = open.slice(ownPrefix.length);
            const kind = rest.slice(0, Math.max(rest.indexOf(':'), 0));
            if (readInFull.has(kind)) resolve.push(open);
        }
    }

    return { agents, assert, resolve, intakeConflicts };
}
