/**
 * The declarative route map resolves the agent ownership-transfer paths to
 * `admin.tenant_lifecycle` (#3698, step 0e "Rule order").
 *
 * `ROUTE_PERMISSIONS` is first-match-wins, and the `admin/agents(/.*)?`
 * catch-all resolves to `admin.agent_registry` — a key ADMIN holds. A transfer
 * rule ordered below it would record a gate different from the one the handler
 * enforces. The neighbours are asserted too, so a rule that swallowed every
 * `admin/agents` path cannot pass this by accident.
 */
import { resolveRoutePermission } from '@/lib/security/route-permissions';

const AGENT = '/api/t/acme/admin/agents/agent-1';

describe('ownership-transfer routes resolve to tenant lifecycle', () => {
    it.each(['GET', 'POST', 'DELETE'] as const)('…/ownership-transfer %s', (method) => {
        expect(resolveRoutePermission(`${AGENT}/ownership-transfer`, method)?.permission).toBe(
            'admin.tenant_lifecycle',
        );
    });

    it('…/ownership-transfer/complete POST', () => {
        expect(
            resolveRoutePermission(`${AGENT}/ownership-transfer/complete`, 'POST')?.permission,
        ).toBe('admin.tenant_lifecycle');
    });

    it('the neighbours keep their own keys — the rule matches the transfer paths and nothing else', () => {
        expect(resolveRoutePermission(AGENT, 'DELETE')?.permission).toBe('admin.agent_registry');
        expect(resolveRoutePermission(AGENT, 'PATCH')?.permission).toBe('admin.agent_registry');
        expect(resolveRoutePermission(`${AGENT}/status`, 'POST')?.permission).toBe('admin.agent_registry');
        expect(resolveRoutePermission(`${AGENT}/tools`, 'POST')?.permission).toBe(
            'admin.agent_tool_exposure',
        );
        // A path that only STARTS like the transfer's is not one.
        expect(
            resolveRoutePermission(`${AGENT}/ownership-transfer/complete/extra`, 'POST')?.permission,
        ).toBe('admin.agent_registry');
    });
});
