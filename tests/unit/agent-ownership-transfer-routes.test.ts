/**
 * The declarative route map resolves the agent ownership-transfer paths to
 * `admin.agent_ownership` (#3699; `admin.tenant_lifecycle` from #3698 until
 * then — step 0e "Rule order"), and both route files carry the LITERAL gate.
 *
 * `ROUTE_PERMISSIONS` is first-match-wins, and the `admin/agents(/.*)?`
 * catch-all resolves to `admin.agent_registry` — a key ADMIN holds. A transfer
 * rule ordered below it would record a gate different from the one the handler
 * enforces. The neighbours are asserted too, so a rule that swallowed every
 * `admin/agents` path cannot pass this by accident.
 */
import { readFileSync } from 'fs';
import path from 'path';

import { resolveRoutePermission } from '@/lib/security/route-permissions';
import { codeOf, declarationOf } from '../helpers/source-blocks';

const AGENT = '/api/t/acme/admin/agents/agent-1';

describe('ownership-transfer routes resolve to agent ownership', () => {
    it.each(['GET', 'POST', 'DELETE'] as const)('…/ownership-transfer %s', (method) => {
        expect(resolveRoutePermission(`${AGENT}/ownership-transfer`, method)?.permission).toBe(
            'admin.agent_ownership',
        );
    });

    it('…/ownership-transfer/complete POST', () => {
        expect(
            resolveRoutePermission(`${AGENT}/ownership-transfer/complete`, 'POST')?.permission,
        ).toBe('admin.agent_ownership');
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

describe('both route files carry a literal requirePermission(\'admin.agent_ownership\') on every verb', () => {
    const DIR = path.resolve(
        __dirname,
        '../../src/app/api/t/[tenantSlug]/admin/agents/[agentId]/ownership-transfer',
    );
    it.each([
        ['route.ts', ['GET', 'POST', 'DELETE']],
        ['complete/route.ts', ['POST']],
    ] as const)('%s', (file, verbs) => {
        const src = readFileSync(path.join(DIR, file), 'utf8');
        for (const verb of verbs) {
            // The export's own declaration, bounded by `declarationOf`.
            const gated =
                /^const \w+ = withApiErrorHandling\(\s*requirePermission<Params>\(\s*'admin\.agent_ownership',/.test(
                    declarationOf(src, verb),
                );
            expect({ verb, gated }).toEqual({ verb, gated: true });
        }
        expect({ file, namesTenantLifecycle: /'admin\.tenant_lifecycle'/.test(codeOf(src)) }).toEqual({
            file,
            namesTenantLifecycle: false,
        });
    });
});
