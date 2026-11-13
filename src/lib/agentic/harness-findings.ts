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
 * ── AN UNREGISTERED IDENTITY IS NOT A SHADOW AGENT (owner decisions, 2026-11-13) ─
 *
 * A principal no register row is linked to, and that shows no sign of running a
 * model, is an UNREGISTERED AUTOMATED IDENTITY: a service account, a build
 * workflow holding a credential, a directory application. The signs are the
 * five in `MODEL_SIGNS` and no others: it was found in agent code, in a
 * tracing system or on an MCP server, or its report lists a tool or a model
 * endpoint. THE NAME OF A CREDENTIAL IS NOT A SIGN: a secret called after a
 * model provider is a guess about what holds it.
 *
 * Such a principal has ONE finding, UNREGISTERED_IDENTITY (MEDIUM,
 * OBSERVATION), in place of SHADOW_AGENT, and NO HARNESS_SHORTFALL: it is
 * held to no bar. It keeps its row, its derived level and its verdicts. A
 * linked principal is an agent whatever it shows: the register said so.
 *
 * WHAT IS ON RECORD, AND WHAT AN INCOMPLETE SCAN MAY CONCLUDE. A sign is a
 * presence, and a presence is evidence on any scan. The ABSENCE of a sign is
 * evidence only as far as the scan read, so:
 *
 *   • A SIGN, ON ANY SCAN: a shadow agent. SHADOW_AGENT is asserted and the
 *     identity finding is resolved — the scan saw what that finding says
 *     nothing showed.
 *   • NO SIGN, ON A COMPLETE SCAN (`isScanComplete`): an identity.
 *     UNREGISTERED_IDENTITY is asserted, and the SHADOW_AGENT and
 *     HARNESS_SHORTFALL findings are resolved.
 *   • NO SIGN, ON AN INCOMPLETE SCAN: nothing on record is undone. A principal
 *     ON RECORD AS AN AGENT (`PriorHarnessState.onRecordAsAgent`: its
 *     SHADOW_AGENT or HARNESS_SHORTFALL finding is open) is still treated as
 *     one, exactly as before this rule existed — the sign may be in the part
 *     the scan did not read. Any other principal is an identity, and the scan
 *     resolves nothing for it.
 *
 * The record is the OPEN FINDING, not the stored scan rows: those are
 * overwritten by every scan, an incomplete one included, so a second incomplete
 * scan would read the first one's missing sign as the record and flip the
 * principal. The finding moves only on the evidence above, so the class does
 * not flap between scans, and one principal does not hold both findings open:
 * every move asserts one and resolves the other in the same plan. (Both can be
 * open only off that path: a person reopened one by hand, or an identity was
 * registered through the intake and its register row stopped linking before a
 * complete scan had closed its finding. The next complete scan settles it, and
 * until then a reader takes the shadow agent's class, the more severe —
 * `unregisteredIdentitiesOnRecord`.)
 *
 * It closes as a shadow agent's finding does, by being registered: a link the
 * report claimed on any scan, a link from the intake's record on a complete one.
 *
 * ── FINDINGS, AND WHEN THIS SCAN MAY CLOSE ONE ──────────────────────────────
 *
 * Every finding is keyed by a `sourceRef` so re-ingesting is idempotent:
 *
 *   SHADOW_AGENT:<discoveredId>              not in the register (whatever the
 *                                            report claims, the register decides),
 *                                            and showing a sign of a model
 *   UNREGISTERED_IDENTITY:<discoveredId>     not in the register, and showing no
 *                                            sign of a model (next section)
 *   UNPINNED_WRITE_TOOL:<discoveredId>       a write-capable tool with no pin
 *   LEVEL_DROP:<discoveredId>:<scanRef>      the level fell since the last scan —
 *                                            an event, never closed by a scan
 *   HARNESS_SHORTFALL:<discoveredId>         below the report-only bar
 *   EMPTY_SCAN:<scannerAgentId>              the scanner found no agents at all
 *   INCOMPLETE_SOURCE:<scannerAgentId>:<kind> a source it could not read in full
 *   ORPHAN_CREDENTIAL:<scannerAgentId>:<kind>:<ref>
 *                                            `/2` only: a credential that source
 *                                            saw bound to no discovered agent
 *   SPENDING_AGENT_UNDECLARED:<registeredAgentId>
 *                                            `/4` only: a registered agent whose
 *                                            code can pay, with no spending
 *                                            authority declared (Agent Pay
 *                                            Phase 2, below)
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
 *   • AN ABSENT OR INCOMPLETE SOURCE CLOSES NOTHING. An incomplete identity
 *     source therefore opens nothing and closes nothing. (A `/1` report, which
 *     had no member to say anything about unbound credentials, closed nothing
 *     either; `/1` is retired, #3686, and the verifier no longer accepts one.)
 *
 * The open findings it may close are the ingest's to read
 * (`PriorHarnessState.openOrphanCredentials`), because closing is about rows the
 * report does not mention.
 *
 * ── SPENDING_AGENT_UNDECLARED, FROM `/4`'s `paymentCapabilities[]` ─────────
 *
 * Agent Pay Phase 2.3 (`docs/ai-architecture/mastercard-agent-pay.md`). The
 * register decides, never the report: the finding is keyed by the REGISTER
 * ROW the planner linked, so an agent the register does not know raises
 * SHADOW_AGENT and nothing here (registering it is the first act), and a
 * report cannot raise it against a row the register does not hold.
 *
 *   • IT OPENS when a linked agent's code calls a payment client and the
 *     register row holds no spending authority that is not WITHDRAWN.
 *   • IT CLOSES on positive evidence only, and the scan holds none: an
 *     envelope a second person REVIEWED (`spendingAuthority` reads
 *     `REVIEWED`) is the one close the planner makes. A code read reporting
 *     `paymentCapabilities: []` closes NOTHING, complete or not: `[]` is "the
 *     reader saw no payment client called in the agent's own file", and the
 *     reader cannot see a client wrapped in a helper module, reached through a
 *     name it cannot resolve, or loaded by a dynamic import elsewhere. Absence
 *     a static, one-file reader cannot vouch for is not evidence. A team that
 *     removed the client closes the finding itself, on the finding; the next
 *     scan reopens it only if it sees the client again.
 *   • AN UNREVIEWED ENVELOPE HOLDS IT: neither opened nor closed. The
 *     declaration exists, and its review is the register's own rule —
 *     activation refuses `SPENDING_AUTHORITY_UNREVIEWED` until it lands.
 *
 * Two discovered agents linked to one register row share the key, so the
 * finding is raised once per row; one row's code read saying none does not
 * close it while another linked agent in the same scan still shows a payment.
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
import type {
    HarnessModelEndpoint,
    HarnessPaymentCapability,
    HarnessReportAgent,
    HarnessReportBody,
    HarnessUnboundCredential,
    SOURCE_KINDS,
} from './harness-contract';
import { containsCardNumber, isScanComplete, looksLikeSecret } from './harness-contract-rules';

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
    return firstSecretShapedPath(body);
}

/**
 * The same walk over any JSON-shaped value: the path of its first secret-shaped
 * string, card numbers included (D-L1-8), or null. A writer that stores values
 * a person or a scanner typed — the spending-authority envelope of
 * `docs/ai-architecture/mastercard-agent-pay.md` Phase 1 — refuses through this
 * rather than a copy, so the shapes stay one list.
 *
 * A member's NAME is content too. A strict schema fixes the names of a report
 * body, but not of every value this walks, and a name with a secret's shape
 * would be stored like any value. So a secret-shaped name is a hit as well,
 * and the path says `<key>` in its place: the path is what a refusal prints,
 * and it must not carry the secret it refuses.
 */
export function firstSecretShapedPath(root: unknown): string | null {
    const walk = (node: unknown, path: string): string | null => {
        if (typeof node === 'string') return looksLikeSecret(node) ? path : null;
        // A card number fits in a JSON number (sixteen digits are below 2^53),
        // so a numeric member is read as its digits too.
        if (typeof node === 'number' || typeof node === 'bigint') {
            return containsCardNumber(String(node)) ? path : null;
        }
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) {
                const hit = walk(node[i], `${path}[${i}]`);
                if (hit) return hit;
            }
            return null;
        }
        if (node !== null && typeof node === 'object') {
            for (const [key, value] of Object.entries(node)) {
                if (looksLikeSecret(key)) return path ? `${path}.<key>` : '<key>';
                const hit = walk(value, path ? `${path}.${key}` : key);
                if (hit) return hit;
            }
        }
        return null;
    };
    return walk(root, '');
}

// ─── Agent SDK options, as the scanner reads them from code (#4156) ─────────

/**
 * What the reference scanner's `code` source read of ONE Claude Agent SDK
 * agent's options. A member is `null` when the code sets that option to
 * something the reader could not resolve: the source is then UNPARSEABLE, and
 * nothing is concluded from the option. Every `at` is the `code://` locator of
 * where the option is set, or of the agent's call when the code leaves it at
 * the SDK's default.
 */
export interface AgentSdkOptionFacts {
    /** The permission mode the code names, or `mode: null` when it names none. */
    readonly permissionMode: { readonly mode: string | null; readonly at: string } | null;
    /** `settingSources` left at the SDK's default (which loads the host's files), set to `[]`, or naming sources. */
    readonly settingSources: { readonly state: 'DEFAULT' | 'EMPTY' | 'NAMED'; readonly at: string } | null;
    /** Whether an `allowedTools` entry approves more than one tool: a `*`, or a whole MCP server. */
    readonly allowedToolsWildcard: { readonly present: boolean; readonly at: string } | null;
    /** Which of `Bash` and `WebFetch` the agent can call, after `disallowedTools`. */
    readonly shellOrFetch: { readonly names: readonly string[]; readonly at: string } | null;
    /** Whether the code configures any hook. */
    readonly hooks: { readonly present: boolean; readonly at: string } | null;
}

/**
 * The ladder criterion each Agent SDK option fails, as the owner mapped them
 * (#4156, 2026-10-29). The ladder stays report-only: these feed the
 * HARNESS_SHORTFALL finding and the matrix, never a gate.
 *
 * NOT MET ONLY. Code can show that a harness lacks a control. It cannot show
 * that a control it configures works, because a hook's body, a sandbox and a
 * gateway are out of its sight. So nothing here is ever `met: true`, and a
 * hook that is present is no evidence for `H3.payloads_guarded`.
 */
export const AGENT_SDK_OPTION_CRITERIA = {
    /** `permissionMode: 'bypassPermissions'`: every call takes effect with nobody approving it. */
    BYPASS_PERMISSIONS: 'H3.propose_not_commit',
    /** Host settings loaded: skills and instructions from files the code does not declare. */
    HOST_SETTINGS_SKILLS: 'H3.skills_declared',
    /** Host settings loaded: `.mcp.json` and allow-rules can add to the tool list. */
    HOST_SETTINGS_TOOLS: 'H2.tools_allowlisted',
    /** An `allowedTools` wildcard approves tools nobody listed. */
    ALLOWED_TOOLS_WILDCARD: 'H2.tools_allowlisted',
    /** A shell or an open web fetch reaches any command or host, so no list bounds it. */
    SHELL_OR_FETCH: 'H2.tools_allowlisted',
    /** No hook inspects a call before it runs, with no settings file that could add one. */
    NO_HOOKS: 'H3.payloads_guarded',
} as const satisfies Readonly<Record<string, HarnessCriterionId>>;

/**
 * The verdicts one Agent SDK agent's options support: one NOT MET per option
 * the owner mapped, with the option's locator as evidence. An option the
 * scanner could not read concludes nothing.
 */
export function agentSdkOptionVerdicts(facts: AgentSdkOptionFacts): CriterionVerdict[] {
    const verdicts: CriterionVerdict[] = [];
    const notMet = (criterion: HarnessCriterionId, at: string) => verdicts.push({ criterion, met: false, evidence: at });

    if (facts.permissionMode !== null && facts.permissionMode.mode === 'bypassPermissions') {
        notMet(AGENT_SDK_OPTION_CRITERIA.BYPASS_PERMISSIONS, facts.permissionMode.at);
    }
    const settings = facts.settingSources;
    if (settings !== null && settings.state !== 'EMPTY') {
        notMet(AGENT_SDK_OPTION_CRITERIA.HOST_SETTINGS_SKILLS, settings.at);
        notMet(AGENT_SDK_OPTION_CRITERIA.HOST_SETTINGS_TOOLS, settings.at);
    }
    if (facts.allowedToolsWildcard !== null && facts.allowedToolsWildcard.present) {
        notMet(AGENT_SDK_OPTION_CRITERIA.ALLOWED_TOOLS_WILDCARD, facts.allowedToolsWildcard.at);
    }
    if (facts.shellOrFetch !== null && facts.shellOrFetch.names.length > 0) {
        notMet(AGENT_SDK_OPTION_CRITERIA.SHELL_OR_FETCH, facts.shellOrFetch.at);
    }
    // With host settings loaded, a hook can come from a settings file, and the
    // settings verdicts above already say so.
    if (facts.hooks !== null && !facts.hooks.present && settings !== null && settings.state === 'EMPTY') {
        notMet(AGENT_SDK_OPTION_CRITERIA.NO_HOOKS, facts.hooks.at);
    }
    return verdicts;
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
    'SPENDING_AGENT_UNDECLARED',
    'UNREGISTERED_IDENTITY',
] as const;
export type HarnessFindingCode = (typeof HARNESS_FINDING_CODES)[number];

/** The stored reach, as the `AgentHarnessReach` enum spells it. */
export type StoredReach = 'READ_ONLY' | 'WRITE_OR_EXTERNAL' | 'UNKNOWN';

const LADDER_REACH: Record<StoredReach, HarnessReach | 'unknown'> = {
    READ_ONLY: 'read-only',
    WRITE_OR_EXTERNAL: 'write-or-external',
    UNKNOWN: 'unknown',
};

/**
 * What a scan read that suggests a principal runs a model: it was found in
 * agent code, in a tracing system or on an MCP server, or its report lists a
 * tool or a model endpoint. A credential's NAME is not one: a secret called
 * after a model provider is a guess about what holds it (owner decision,
 * 2026-11-13). Five, in this order; adding one is the owner's decision.
 */
export const MODEL_SIGNS = ['FOUND_IN_CODE', 'FOUND_IN_RUNTIME', 'FOUND_ON_MCP_SERVER', 'LISTS_A_TOOL', 'LISTS_A_MODEL'] as const;
export type ModelSign = (typeof MODEL_SIGNS)[number];

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
    /**
     * The model endpoints `/2` reported, as reported (#3759). `null` is NOT
     * REPORTED — a `/1` report, or a `/2` agent without `models` — which the
     * ingest stores as NULL, apart from `[]`, reported empty.
     */
    readonly models: readonly HarnessModelEndpoint[] | null;
    /**
     * `/4`'s payment capabilities, as reported. `null` is NOT REPORTED (a `/2`
     * or `/3` report, or an agent no code read reported), apart from `[]`, a
     * code read that saw no payment client called.
     */
    readonly paymentCapabilities: readonly HarnessPaymentCapability[] | null;
    /** What this report says of the principal that suggests it runs a model, in the order of `MODEL_SIGNS`. */
    readonly modelSigns: readonly ModelSign[];
    /**
     * This scan classes the principal as an UNREGISTERED AUTOMATED IDENTITY:
     * linked to no register row, showing no sign of a model, and not held as
     * an agent by what is on record (an incomplete scan undoes nothing). It
     * then has the UNREGISTERED_IDENTITY finding and no shortfall.
     */
    readonly unregisteredIdentity: boolean;
}

/** What the report says of one principal that suggests it runs a model. In the order of `MODEL_SIGNS`. */
export function modelSignsOf(agent: Pick<PlannedAgent, 'discoveredVia' | 'tools' | 'models'>): ModelSign[] {
    const via = agent.discoveredVia as readonly string[];
    const signs: ModelSign[] = [];
    if (via.includes('code')) signs.push('FOUND_IN_CODE');
    if (via.includes('runtime')) signs.push('FOUND_IN_RUNTIME');
    if (via.includes('mcp')) signs.push('FOUND_ON_MCP_SERVER');
    if (agent.tools.length > 0) signs.push('LISTS_A_TOOL');
    if (agent.models !== null && agent.models.length > 0) signs.push('LISTS_A_MODEL');
    return signs;
}

/**
 * What the register holds for one row's spending authority (Agent Pay
 * Phase 1), as the harness planner needs it: `REVIEWED` when an envelope a
 * second person reviewed is in force (REVIEWED, or SUSPENDED_REQUESTED after
 * a review); `UNREVIEWED` when the only live envelopes await review. A row
 * absent from the map holds no envelope that is not WITHDRAWN.
 */
export type SpendingAuthorityStanding = 'REVIEWED' | 'UNREVIEWED';

/**
 * One register row's standing from its stored envelopes. WITHDRAWN rows are
 * ignored; any reviewed live envelope makes the row REVIEWED.
 */
export function spendingAuthorityStandingOf(
    envelopes: readonly { readonly status: string; readonly reviewedAt: Date | null }[],
): SpendingAuthorityStanding | null {
    const live = envelopes.filter((e) => e.status !== 'WITHDRAWN');
    if (live.length === 0) return null;
    const reviewed = live.some(
        (e) => e.reviewedAt !== null && (e.status === 'REVIEWED' || e.status === 'SUSPENDED_REQUESTED'),
    );
    return reviewed ? 'REVIEWED' : 'UNREVIEWED';
}

/** The `sourceRef` of a register row's SPENDING_AGENT_UNDECLARED finding. */
export function spendingUndeclaredRefOf(registeredAgentId: string): string {
    return `SPENDING_AGENT_UNDECLARED:${registeredAgentId}`;
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
    /**
     * Each register row's spending-authority standing (Agent Pay Phase 2.3),
     * keyed by register id. A row absent from the map holds no live envelope.
     */
    readonly spendingAuthority: ReadonlyMap<string, SpendingAuthorityStanding>;
    /**
     * Discovered agents ON RECORD AS AGENTS, by `discoveredId`: an open
     * SHADOW_AGENT or HARNESS_SHORTFALL finding names them
     * (`onRecordAsAgentOf`). Read only for a principal an INCOMPLETE scan
     * reports with no sign of a model: the missing sign undoes nothing, so it
     * is still treated as an agent. A complete scan decides by itself.
     */
    readonly onRecordAsAgent: ReadonlySet<string>;
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
 *   gcp-sa            a service account, and the user-managed keys it holds (#3785)
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
    'gcp-sa': true,
});

/** Is this source kind identity-bearing? A kind the table does not name is — the side that opens nothing. */
export function isIdentityBearingSource(kind: string): boolean {
    return Object.hasOwn(IDENTITY_BEARING_SOURCE, kind) ? IDENTITY_BEARING_SOURCE[kind as HarnessSourceKind] : true;
}

const SHORTFALL_REF_PREFIX = 'HARNESS_SHORTFALL:';
/** Every SHADOW_AGENT `sourceRef` starts with this; the `discoveredId` is everything after it. */
export const SHADOW_REF_PREFIX = 'SHADOW_AGENT:';
/** Every UNREGISTERED_IDENTITY `sourceRef` starts with this; the `discoveredId` is everything after it. */
export const UNREGISTERED_IDENTITY_REF_PREFIX = 'UNREGISTERED_IDENTITY:';

export function shortfallRefOf(discoveredId: string): string {
    return `${SHORTFALL_REF_PREFIX}${discoveredId}`;
}

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
    return idAfter(finding.sourceRef, SHADOW_REF_PREFIX);
}

/** The id a `sourceRef` carries after `prefix`, or null: another kind's ref, or an empty id. */
function idAfter(sourceRef: string | null, prefix: string): string | null {
    if (!sourceRef?.startsWith(prefix)) return null;
    const id = sourceRef.slice(prefix.length);
    return id.length > 0 ? id : null;
}

/** The `sourceRef` of a discovered principal's UNREGISTERED_IDENTITY finding. */
export function unregisteredIdentityRefOf(discoveredId: string): string {
    return `${UNREGISTERED_IDENTITY_REF_PREFIX}${discoveredId}`;
}

/**
 * The finding the registration intake registers from, read off a stored
 * finding: a harness SHADOW_AGENT or UNREGISTERED_IDENTITY finding, and the
 * `discoveredId` it names. `null` for a finding of any other kind. Both say
 * "this principal has no register row", and both close by its being
 * registered, so the intake takes either (owner decision, 2026-11-13: "if it is
 * an agent, register it").
 */
export function registrableFindingOf(finding: {
    sourceKind: string | null;
    sourceRef: string | null;
}): { readonly code: 'SHADOW_AGENT' | 'UNREGISTERED_IDENTITY'; readonly discoveredId: string } | null {
    if (finding.sourceKind !== HARNESS_FINDING_SOURCE_KIND) return null;
    const shadow = idAfter(finding.sourceRef, SHADOW_REF_PREFIX);
    if (shadow !== null) return { code: 'SHADOW_AGENT', discoveredId: shadow };
    const identity = idAfter(finding.sourceRef, UNREGISTERED_IDENTITY_REF_PREFIX);
    return identity === null ? null : { code: 'UNREGISTERED_IDENTITY', discoveredId: identity };
}

/** A stored harness finding, as the two on-record readers below take it. */
export interface HarnessFindingOnRecord {
    readonly sourceRef: string | null;
    /** `Finding.status`. Every status but CLOSED is open. */
    readonly status: string;
}

/**
 * The discovered ids ON RECORD AS AGENTS among these findings: an open
 * SHADOW_AGENT or HARNESS_SHORTFALL finding names them. What the ingest hands
 * the planner as `PriorHarnessState.onRecordAsAgent`.
 */
export function onRecordAsAgentOf(findings: readonly HarnessFindingOnRecord[]): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const f of findings) {
        if (f.status === 'CLOSED') continue;
        const id = idAfter(f.sourceRef, SHADOW_REF_PREFIX) ?? idAfter(f.sourceRef, SHORTFALL_REF_PREFIX);
        if (id !== null) ids.add(id);
    }
    return ids;
}

/**
 * The discovered ids ON RECORD AS UNREGISTERED IDENTITIES among these
 * findings: the UNREGISTERED_IDENTITY finding is open and the SHADOW_AGENT
 * finding is not. THE ONE RULE every reader of a stored principal's class
 * uses — the harness matrix, the shortfall acceptance, the acceptance expiry
 * sweep and the evidence emitter — so none of them re-derives the class from
 * stored scan rows, which an incomplete scan overwrites.
 *
 * It says nothing about whether the principal is LINKED: a caller asks it only
 * of a principal with no live register row. With both findings open the
 * principal reads as a shadow agent, the more severe reading.
 */
export function unregisteredIdentitiesOnRecord(findings: readonly HarnessFindingOnRecord[]): ReadonlySet<string> {
    const identity = new Set<string>();
    const shadow = new Set<string>();
    for (const f of findings) {
        if (f.status === 'CLOSED') continue;
        const s = idAfter(f.sourceRef, SHADOW_REF_PREFIX);
        if (s !== null) shadow.add(s);
        const i = idAfter(f.sourceRef, UNREGISTERED_IDENTITY_REF_PREFIX);
        if (i !== null) identity.add(i);
    }
    for (const id of shadow) identity.delete(id);
    return identity;
}

/**
 * The finding for a principal no register row names and nothing shows to run a
 * model, in place of SHADOW_AGENT. It is still a finding: an identity nobody
 * has classified does not leave the record.
 */
function unregisteredIdentityFinding(discoveredId: string, discoveredVia: readonly string[], where: string): PlannedFinding {
    return {
        code: 'UNREGISTERED_IDENTITY',
        sourceRef: unregisteredIdentityRefOf(discoveredId),
        severity: 'MEDIUM',
        type: 'OBSERVATION',
        title: `Unregistered automated identity ${discoveredId}`,
        description:
            `A harness scan (${where}) found ${discoveredId} via ${discoveredVia.join(', ')}. It has no row in the `
            + 'agent register. Nothing the scan read shows that it runs a model: it was not found in agent code, in '
            + 'a tracing system or on an MCP server, and its report lists no tool and no model endpoint. So it is '
            + 'reported as an automated identity and not as an agent, and it is not held to the harness bar. '
            + 'The scan cannot show that it runs no model. If it is an agent, register it, and it is then scored as '
            + 'one. If it is not, it still needs an owner on record; or retire the principal.',
    };
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

/** How many payment call sites a finding names before it stops listing. */
const MAX_PAYMENT_SITES_NAMED = 10;

function spendingUndeclaredFinding(where: string, registeredAgentId: string, paying: readonly PlannedAgent[]): PlannedFinding {
    const sites = paying.flatMap((p) => (p.paymentCapabilities ?? []).map((c) => `${c.library} at ${c.at}`));
    const named = sites.slice(0, MAX_PAYMENT_SITES_NAMED);
    const more = sites.length > MAX_PAYMENT_SITES_NAMED ? ` and ${sites.length - MAX_PAYMENT_SITES_NAMED} more` : '';
    return {
        code: 'SPENDING_AGENT_UNDECLARED',
        sourceRef: spendingUndeclaredRefOf(registeredAgentId),
        severity: 'HIGH',
        type: 'NONCONFORMITY',
        title: `Registered agent ${registeredAgentId} can pay, with no spending authority declared`,
        description:
            `A harness scan (${where}) read the code of ${paying.map((p) => p.discoveredId).join(', ')}, linked to `
            + `registered agent ${registeredAgentId}, and found it calling a payment client: ${named.join('; ')}${more}. `
            + 'The register holds no spending authority for the agent, so nobody has declared, or a second person '
            + 'reviewed, how much it may spend, where, or until when. Declare the envelope on the register for '
            + 'review, or remove the payment client from the agent. This finding closes when a reviewed envelope '
            + 'is in force. A scan that no longer sees the payment client does not close it, because a static read '
            + 'cannot show an agent has no other way to pay: if the client was removed, close the finding yourself; '
            + 'a later scan reopens it only if it sees the client again.',
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

        // THE CLASS OF AN UNLINKED PRINCIPAL (owner decisions, 2026-11-13). A
        // sign of a model makes it a shadow agent on any scan. No sign makes
        // it an unregistered identity — unless the scan is incomplete and the
        // principal is on record as an agent: the sign may be in the part the
        // scan did not read, so what is on record stands.
        const models = 'models' in a ? (a.models ?? null) : null;
        const modelSigns = modelSignsOf({ discoveredVia: a.discoveredVia, tools: a.tools, models });
        const heldAsAgent = !scanComplete && prior.onRecordAsAgent.has(id);
        const unregisteredIdentity = registeredAgentId === null && modelSigns.length === 0 && !heldAsAgent;

        // SHADOW, OR UNREGISTERED IDENTITY. A link the report claimed is
        // resolved by the register, which is evidence whatever the scan's
        // completeness: the row exists or it does not. A link from the
        // intake's record closes the finding only on a complete scan, and an
        // incomplete one leaves the finding as it is. Either finding closes
        // under that one rule: both say "no register row".
        const shadowRef = shadowRefOf(id);
        const identityRef = unregisteredIdentityRefOf(id);
        const shadowHeld = linkBasis === 'INTAKE' && !scanComplete;
        if (unregisteredIdentity) {
            assert.push(unregisteredIdentityFinding(id, a.discoveredVia, where));
            // Absence of a sign is evidence only on a complete scan. (On an
            // incomplete one nothing is open to close: an open SHADOW_AGENT
            // would have held it as an agent above.)
            if (scanComplete) resolve.push(shadowRef);
        } else if (registeredAgentId === null) {
            // A sign the scan SAW is positive evidence against the identity
            // finding, complete scan or not. A principal held as an agent with
            // no sign resolves nothing.
            if (modelSigns.length > 0) resolve.push(identityRef);
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
            resolve.push(shadowRef, identityRef);
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

        // SHORTFALL against the report-only bar. An unregistered identity is
        // held to no bar: it raises none, and a complete scan closes one on
        // record (an incomplete one has none to close, as above).
        if (unregisteredIdentity) {
            if (scanComplete) resolve.push(shortfallRefOf(id));
        } else if (isHarnessShortfall(score.level, reach)) {
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
            models,
            paymentCapabilities: 'paymentCapabilities' in a ? (a.paymentCapabilities ?? null) : null,
            modelSigns,
            unregisteredIdentity,
        };
    });

    // SPENDING AUTHORITY THE REGISTER DOES NOT KNOW (`/4`). Per register row:
    // any linked agent paying opens. Only a reviewed envelope closes; a read
    // reporting `[]` is not evidence the agent cannot pay, so it closes nothing.
    const payingByRow = new Map<string, PlannedAgent[]>();
    for (const p of agents) {
        if (p.registeredAgentId === null) continue;
        const caps = p.paymentCapabilities;
        const row = payingByRow.get(p.registeredAgentId) ?? [];
        if (caps !== null && caps.length > 0) row.push(p);
        payingByRow.set(p.registeredAgentId, row);
    }
    for (const [rowId, paying] of payingByRow) {
        const ref = spendingUndeclaredRefOf(rowId);
        const standing = prior.spendingAuthority.get(rowId);
        if (standing === 'REVIEWED') {
            resolve.push(ref);
            continue;
        }
        if (paying.length > 0 && standing === undefined) assert.push(spendingUndeclaredFinding(where, rowId, paying));
    }

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

    // ORPHAN CREDENTIALS — only on positive evidence.
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

    return { agents, assert, resolve, intakeConflicts };
}
