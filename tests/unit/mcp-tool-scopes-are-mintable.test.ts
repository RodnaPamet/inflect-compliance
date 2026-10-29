/**
 * Every scope a tool on `/api/mcp` checks is one the api-keys route can mint
 * (#4485). An external tool once checked `external_tools:read`, which no key
 * could carry, so only a `*` key reached it. This holds every tool, built-in and
 * external, to a scope in `VALID_SCOPES`.
 */
import { VALID_SCOPES } from '@/lib/auth/api-key-auth';
import { READ_TOOLS } from '@/lib/mcp/tools/registry';
import { PROPOSE_TOOLS } from '@/lib/mcp/tools/propose-tools';
import { EXTERNAL_TOOL_RESOURCE_SCOPE } from '@/lib/mcp/tools/external-tools';

const scopeOf = (s: { resource: string; action: string }) => `${s.resource}:${s.action}`;

describe('every MCP tool checks a scope a key can carry', () => {
    it.each([...READ_TOOLS, ...PROPOSE_TOOLS].map((t) => [t.name, scopeOf(t.resourceScope)]))(
        '%s checks %s',
        (_name, scope) => {
            expect(VALID_SCOPES).toContain(scope);
        },
    );

    it('an external tool checks admin:external_tools, the scope that also carries its permission', () => {
        expect(scopeOf(EXTERNAL_TOOL_RESOURCE_SCOPE)).toBe('admin:external_tools');
        expect(VALID_SCOPES).toContain(scopeOf(EXTERNAL_TOOL_RESOURCE_SCOPE));
    });
});
