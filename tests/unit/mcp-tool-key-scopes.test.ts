/**
 * The client-safe copy of each MCP tool's key scope equals the registry's
 * definition (#4155). The connect wizard mints a key from the copy; a copy that
 * drifted would mint a key the tool refuses, or one that carries a scope no
 * grant needs.
 */
import { READ_TOOLS } from '@/lib/mcp/tools/registry';
import { PROPOSE_TOOLS } from '@/lib/mcp/tools/propose-tools';
import { EXTERNAL_TOOL_RESOURCE_SCOPE } from '@/lib/mcp/tools/external-tools';
import { EXTERNAL_TOOL_KEY_SCOPE, MCP_TOOL_KEY_SCOPE } from '@/lib/mcp/tool-catalogue';

describe('MCP_TOOL_KEY_SCOPE', () => {
    const fromRegistry = Object.fromEntries(
        [...READ_TOOLS, ...PROPOSE_TOOLS].map((t) => [t.name, `${t.resourceScope.resource}:${t.resourceScope.action}`]),
    );

    it('names every tool the registries define, and no other', () => {
        expect(Object.keys(MCP_TOOL_KEY_SCOPE).sort()).toEqual(Object.keys(fromRegistry).sort());
    });

    it('gives each tool the scope its definition checks', () => {
        expect(MCP_TOOL_KEY_SCOPE).toEqual(fromRegistry);
    });

    it('gives an external tool the scope the external adapter checks (#4485)', () => {
        expect(EXTERNAL_TOOL_KEY_SCOPE).toBe(`${EXTERNAL_TOOL_RESOURCE_SCOPE.resource}:${EXTERNAL_TOOL_RESOURCE_SCOPE.action}`);
    });
});
