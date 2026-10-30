/**
 * The agent switches' rule (#4557): the organization decides, the deployment
 * can veto, and the operator's slug list still opens the workspaces it names.
 *
 * Every combination of the three inputs is decided here, so a reordering of
 * the arms (a veto that stops beating an organization, an allowlist that stops
 * beating the veto, a missing organization that reads as on) fails a named row.
 */
import {
    needsOrganization,
    readDeploymentSwitch,
    resolveAgentSwitch,
    switchActor,
    type AgentSwitchBasis,
    type DeploymentSwitch,
} from '@/lib/agentic/agent-switches';

describe('the deployment variable reads as three states', () => {
    it.each([
        ['1', 'ON'],
        ['true', 'ON'],
        [' TRUE ', 'ON'],
        [undefined, 'UNSET'],
        [null, 'UNSET'],
        ['', 'UNSET'],
        ['   ', 'UNSET'],
        ['0', 'OFF'],
        ['false', 'OFF'],
        ['yes', 'OFF'],
        ['on', 'OFF'],
        ['1 ', 'ON'],
    ] as const)('%p reads %s', (raw, state) => {
        expect(readDeploymentSwitch(raw)).toBe(state);
    });
});

describe('the rule, over every combination', () => {
    const DEPLOYMENT: DeploymentSwitch[] = ['ON', 'OFF', 'UNSET'];
    const ORGANIZATION: Array<boolean | null> = [true, false, null];

    const expected = (
        deployment: DeploymentSwitch,
        allowlisted: boolean,
        organization: boolean | null,
    ): { on: boolean; basis: AgentSwitchBasis } => {
        if (deployment === 'ON') return { on: true, basis: 'DEPLOYMENT_ON' };
        if (allowlisted) return { on: true, basis: 'TENANT_ALLOWLIST' };
        if (deployment === 'OFF') return { on: false, basis: 'DEPLOYMENT_OFF' };
        if (organization === null) return { on: false, basis: 'NO_ORGANIZATION' };
        return organization ? { on: true, basis: 'ORGANIZATION_ON' } : { on: false, basis: 'ORGANIZATION_OFF' };
    };

    const rows = DEPLOYMENT.flatMap((d) =>
        [false, true].flatMap((a) => ORGANIZATION.map((o) => [d, a, o] as const)),
    );

    it.each(rows)('deployment %s, allowlisted %p, organization %p', (deployment, allowlisted, organization) => {
        expect(resolveAgentSwitch({ deployment, allowlisted, organization })).toEqual(
            expected(deployment, allowlisted, organization),
        );
    });

    it('the three properties the owner decided, stated directly', () => {
        // The veto beats an organization that turned the switch on.
        expect(resolveAgentSwitch({ deployment: 'OFF', organization: true }).on).toBe(false);
        // Unset leaves it to the organization, in both directions.
        expect(resolveAgentSwitch({ deployment: 'UNSET', organization: true }).on).toBe(true);
        expect(resolveAgentSwitch({ deployment: 'UNSET', organization: false }).on).toBe(false);
        // A workspace with no organization keeps today's answer: off.
        expect(resolveAgentSwitch({ deployment: 'UNSET', organization: null }).on).toBe(false);
    });
});

describe('the organization row is read only when it can decide', () => {
    it('only with the deployment unset and no allowlist answer', () => {
        expect(needsOrganization('UNSET')).toBe(true);
        expect(needsOrganization('UNSET', true)).toBe(false);
        expect(needsOrganization('ON')).toBe(false);
        expect(needsOrganization('OFF')).toBe(false);
    });
});

describe('who holds a switch, for the checklist', () => {
    it.each([
        ['ORGANIZATION_ON', 'organization'],
        ['ORGANIZATION_OFF', 'organization'],
        ['DEPLOYMENT_ON', 'operator'],
        ['DEPLOYMENT_OFF', 'operator'],
        ['TENANT_ALLOWLIST', 'operator'],
        ['NO_ORGANIZATION', 'operator'],
    ] as const)('%s is held by the %s', (basis, actor) => {
        expect(switchActor(basis)).toBe(actor);
    });
});
