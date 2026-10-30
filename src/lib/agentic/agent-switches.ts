/**
 * The two agent switches an organization can flip (#4557), and the rule that
 * decides each one for a workspace.
 *
 *   - `AGENT_PROFILES`: the agent profile surface (Step 1a, #4143).
 *   - `AGENT_DRIVER_TOOL_RUNNER`: whether the Tool Runner engine is available
 *     to a workspace's owner to choose (Step 2c, #4150).
 *
 * ═══ THE ORGANIZATION DECIDES, THE DEPLOYMENT CAN VETO ═══
 *
 * Each environment variable is read as one of three states (owner decision,
 * 2026-10-30):
 *
 *   ON     `1` or `true` turns the switch on for every workspace.
 *   OFF    any other value set, `0` and `false` included, turns it off for
 *          every workspace, whatever an organization chose. A typo is a veto:
 *          the safe end of a switch that GRANTS is off.
 *   UNSET  absent or blank lets each organization decide for the workspaces
 *          under it. A workspace with no organization stays off, as it was
 *          before organizations could decide.
 *
 * `AGENT_PROFILES_TENANTS`, the operator's list of slugs, still turns the
 * profile surface on for the workspaces it names, ahead of the veto: it is the
 * operator's own, narrower instruction, and it read that way before this rule
 * existed. The Tool Runner has no such list.
 *
 * Pure, and free of server imports, so the org page can hold the same rule
 * the server enforces. The reading of the organization's row lives in
 * `agent-switches-policy.ts`.
 */

export const AGENT_SWITCHES = ['agentProfiles', 'toolRunner'] as const;
export type AgentSwitch = (typeof AGENT_SWITCHES)[number];

export type DeploymentSwitch = 'ON' | 'OFF' | 'UNSET';

/** The environment variable that can override each switch. */
export const DEPLOYMENT_SWITCH_VAR: Readonly<Record<AgentSwitch, string>> = {
    agentProfiles: 'AGENT_PROFILES',
    toolRunner: 'AGENT_DRIVER_TOOL_RUNNER',
};

/** Read one environment variable as a three-state switch. */
export function readDeploymentSwitch(raw: string | null | undefined): DeploymentSwitch {
    if (raw === undefined || raw === null || raw.trim() === '') return 'UNSET';
    const normalised = raw.trim().toLowerCase();
    return normalised === '1' || normalised === 'true' ? 'ON' : 'OFF';
}

/** Why a switch reads the way it does for one workspace. */
export type AgentSwitchBasis =
    /** The deployment turned it on for every workspace. */
    | 'DEPLOYMENT_ON'
    /** The operator's slug list names this workspace (profiles only). */
    | 'TENANT_ALLOWLIST'
    /** The deployment turned it off for every workspace. */
    | 'DEPLOYMENT_OFF'
    /** The deployment leaves it to the organization, which turned it on. */
    | 'ORGANIZATION_ON'
    /** The deployment leaves it to the organization, which has not turned it on. */
    | 'ORGANIZATION_OFF'
    /** The deployment leaves it to an organization, and this workspace has none. */
    | 'NO_ORGANIZATION';

export interface AgentSwitchDecision {
    readonly on: boolean;
    readonly basis: AgentSwitchBasis;
}

/**
 * Decide one switch for one workspace.
 *
 * `organization` is the organization's stored choice, or `null` when the
 * workspace belongs to no organization. It is consulted only when the
 * deployment leaves the decision open, so a caller may pass `null` without
 * reading the row whenever `deployment` is not `UNSET` (see `needsOrganization`).
 */
export function resolveAgentSwitch(input: {
    readonly deployment: DeploymentSwitch;
    readonly allowlisted?: boolean;
    readonly organization: boolean | null;
}): AgentSwitchDecision {
    if (input.deployment === 'ON') return { on: true, basis: 'DEPLOYMENT_ON' };
    if (input.allowlisted === true) return { on: true, basis: 'TENANT_ALLOWLIST' };
    if (input.deployment === 'OFF') return { on: false, basis: 'DEPLOYMENT_OFF' };
    if (input.organization === null) return { on: false, basis: 'NO_ORGANIZATION' };
    return input.organization
        ? { on: true, basis: 'ORGANIZATION_ON' }
        : { on: false, basis: 'ORGANIZATION_OFF' };
}

/** Who holds a switch for a workspace, as the Agent engines checklist names it. */
export type AgentSwitchActor = 'operator' | 'organization';

/**
 * The organization holds the switch only when the deployment left it open and
 * the workspace has an organization. Every other basis is the operator's.
 */
export function switchActor(basis: AgentSwitchBasis): AgentSwitchActor {
    return basis === 'ORGANIZATION_ON' || basis === 'ORGANIZATION_OFF' ? 'organization' : 'operator';
}

/**
 * Does the answer depend on the organization's row? Only when the deployment
 * leaves the switch open and no allowlist already answered, so a caller can
 * skip the read on every other path.
 */
export function needsOrganization(deployment: DeploymentSwitch, allowlisted = false): boolean {
    return deployment === 'UNSET' && !allowlisted;
}

/**
 * The slugs `AGENT_PROFILES_TENANTS` names: comma-separated, trimmed and
 * lower-cased, empty entries dropped (Step 1H, #4145).
 */
export function profileTenantAllowlist(raw: string | null | undefined): ReadonlySet<string> {
    return new Set(
        (raw ?? '')
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter((s) => s.length > 0),
    );
}

/** Does the operator's list name this slug? No slug is never named. */
export function slugIsAllowlisted(raw: string | null | undefined, tenantSlug: string | null | undefined): boolean {
    if (typeof tenantSlug !== 'string' || tenantSlug.trim() === '') return false;
    return profileTenantAllowlist(raw).has(tenantSlug.trim().toLowerCase());
}
