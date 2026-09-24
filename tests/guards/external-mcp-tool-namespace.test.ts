/**
 * EXTERNAL TOOL NAMES CANNOT COLLIDE WITH OURS.
 *
 * A tool name is not a label here — it is the primary key of a GRANT
 * (`RegisteredAgentTool.toolName`) and of an APPROVED DEFINITION
 * (`McpToolManifestPin.toolName`, unique per tenant). If an external server's
 * catalogue could produce a name equal to one of ours, a grant made for the
 * external tool would authorise the built-in one, or a pin approved for the
 * built-in would silently accept the external server's description. Either way
 * the deny-by-default grant model stops meaning what it says.
 *
 * So the separation is asserted EXHAUSTIVELY over the real catalogue rather
 * than on a sample, and the denominator is printed: a guard that checked an
 * empty list would pass just as quietly.
 */
import {
    EXTERNAL_TOOL_PREFIX,
    externalToolName,
    isExternalToolName,
    parseExternalToolName,
} from '@/lib/mcp/external-tool-name';
import { MCP_TOOL_NAMES } from '@/lib/mcp/tool-catalogue';

describe('external tool names are a disjoint namespace', () => {
    it('no built-in tool is mistaken for an external one', () => {
        const misread = MCP_TOOL_NAMES.filter(isExternalToolName);
        expect({ checked: MCP_TOOL_NAMES.length, misread }).toEqual({
            checked: MCP_TOOL_NAMES.length,
            misread: [],
        });
        expect(MCP_TOOL_NAMES.length).toBeGreaterThan(10);
    });

    it('a qualified name can never equal a built-in name', () => {
        const builtins = new Set(MCP_TOOL_NAMES);
        const collisions = MCP_TOOL_NAMES.filter((t) =>
            builtins.has(externalToolName('cmufhwlq400034smx', t)),
        );
        expect({ checked: MCP_TOOL_NAMES.length, collisions }).toEqual({
            checked: MCP_TOOL_NAMES.length,
            collisions: [],
        });
    });
});

describe('qualified names round-trip', () => {
    it('recovers the connection and the tool', () => {
        const name = externalToolName('cmo94mi360000fvnl', 'list_alerts');
        expect(name).toBe(`${EXTERNAL_TOOL_PREFIX}cmo94mi360000fvnl__list_alerts`);
        expect(parseExternalToolName(name)).toEqual({
            connectionId: 'cmo94mi360000fvnl',
            toolName: 'list_alerts',
        });
    });

    /**
     * The decoding subtlety. A cuid cannot contain `__`, but an external
     * server's tool name can — so the split must take the FIRST separator and
     * treat everything after it as the tool, not split on every occurrence.
     */
    it('keeps a tool name that itself contains the separator', () => {
        const name = externalToolName('cmo94mi360000fvnl', 'grafana__list__alerts');
        expect(parseExternalToolName(name)).toEqual({
            connectionId: 'cmo94mi360000fvnl',
            toolName: 'grafana__list__alerts',
        });
    });

    it('distinguishes the same tool on two different servers', () => {
        const a = externalToolName('conn_aaa', 'list_alerts');
        const b = externalToolName('conn_bbb', 'list_alerts');
        expect(a).not.toBe(b);
    });
});

describe('malformed names are refused, not guessed at', () => {
    it.each([
        ['a built-in name', 'list_risks'],
        ['the bare prefix', 'mcp__'],
        ['a prefix with no tool', 'mcp__conn__'],
        ['a prefix with no connection', 'mcp____list_alerts'],
    ])('returns null for %s', (_label, name) => {
        expect(parseExternalToolName(name)).toBeNull();
    });

    it.each([
        ['an empty connection id', '', 'list_alerts'],
        ['a connection id containing the separator', 'con__n', 'list_alerts'],
        ['an empty tool name', 'conn_aaa', ''],
    ])('refuses to build a name from %s', (_label, conn, tool) => {
        expect(() => externalToolName(conn, tool)).toThrow();
    });
});
