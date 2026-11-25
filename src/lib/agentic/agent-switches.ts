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
 * ═══ A THIRD SWITCH THE WORKSPACE DECIDES (#5964) ═══
 *
 * `AGENT_MANAGED_AGENTS`, the Managed Agents engine, reads the same three
 * states (owner decisions, 2026-11-25), but UNSET leaves it to the WORKSPACE's
 * owner, not to an organization: the toggle on Admin → AI features
 * (`TenantSecuritySettings.managedAgentsEnabled`). `resolveWorkspaceAgentSwitch`
 * is its rule, beside the organization's below, so the states are named in
 * this one file.
 *
 * `AGENT_PROFILES_TENANTS`, the operator's list of slugs, still turns the
 * profile surface on for the workspaces it names, ahead of the veto: it is the
 * operator's own, narrower instruction, and it read that way before this rule
 * existed. The Tool Runner has no such list.
 *
 * Pure, and free of server imports, so the org page can hold the same rule
 * the server enforces. The reading of the organization's row, and of the
 * workspace's, lives in `agent-switches-policy.ts`.
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
    | 'NO_ORGANIZATION'
    /** The deployment leaves it to the workspace, whose owner turned it on (Managed Agents only). */
    | 'WORKSPACE_ON'
    /** The deployment leaves it to the workspace, whose owner has not turned it on (Managed Agents only). */
    | 'WORKSPACE_OFF';

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

/** The bases a switch the WORKSPACE decides can have (#5964). */
export type WorkspaceAgentSwitchBasis = Extract<
    AgentSwitchBasis,
    'DEPLOYMENT_ON' | 'DEPLOYMENT_OFF' | 'WORKSPACE_ON' | 'WORKSPACE_OFF'
>;

export interface WorkspaceAgentSwitchDecision {
    readonly on: boolean;
    readonly basis: WorkspaceAgentSwitchBasis;
}

/**
 * Decide a switch the WORKSPACE holds (#5964: the Managed Agents engine).
 *
 * `workspace` is the owner's stored toggle. It is consulted only when the
 * deployment leaves the decision open, so a caller may pass `false` without
 * reading the row whenever `deployment` is not `UNSET`. A workspace with no
 * settings row has not turned it on: the safe end of a switch that GRANTS is off.
 */
export function resolveWorkspaceAgentSwitch(input: {
    readonly deployment: DeploymentSwitch;
    readonly workspace: boolean;
}): WorkspaceAgentSwitchDecision {
    if (input.deployment === 'ON') return { on: true, basis: 'DEPLOYMENT_ON' };
    if (input.deployment === 'OFF') return { on: false, basis: 'DEPLOYMENT_OFF' };
    return input.workspace === true
        ? { on: true, basis: 'WORKSPACE_ON' }
        : { on: false, basis: 'WORKSPACE_OFF' };
}

/** Who holds a switch for a workspace, as the Agent engines checklist names it. */
export type AgentSwitchActor = 'operator' | 'organization' | 'tenant';

/**
 * The organization holds the switch only when the deployment left it open and
 * the workspace has an organization; the workspace's own owner holds the one a
 * workspace decides. Every other basis is the operator's.
 */
export function switchActor(basis: AgentSwitchBasis): AgentSwitchActor {
    if (basis === 'ORGANIZATION_ON' || basis === 'ORGANIZATION_OFF') return 'organization';
    if (basis === 'WORKSPACE_ON' || basis === 'WORKSPACE_OFF') return 'tenant';
    return 'operator';
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
