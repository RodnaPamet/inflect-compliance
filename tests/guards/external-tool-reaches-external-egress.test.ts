/**
 * A TOOL ON SOMEBODY ELSE'S SERVER REACHES THE TOP RUNG, AT BOTH SEAMS.
 *
 * `AgentDataAccessScope`'s highest rung is documented as "sends tenant data to a
 * destination outside the platform boundary… the only one whose blast radius is
 * not bounded by the tenant's own database". Calling a tool on an external MCP
 * server is exactly that, so it must answer `EXTERNAL_EGRESS` — at grant time
 * (`baseDataScopeForTool`, what the admin surface and the grant seam compare
 * against) and at call time (`dataScopeForToolCall`, what the policy card is
 * evaluated against). Two seams, one answer.
 *
 * What goes wrong without it is not abstract. An unknown name falls to the
 * `propose` class, whose default is `WRITE_TENANT_DATA`. An agent registered at
 * that scope would then pass `assertGrantWithinDeclaredDataScope` for a tool
 * that leaves the platform, and the risk score would keep standing on a
 * declaration the grant contradicts.
 *
 * The arguments cannot lower it, and that is asserted rather than assumed: the
 * model chooses those arguments, so there is no argument shape under which the
 * egress fails to happen.
 */
import { externalToolName } from '@/lib/mcp/external-tool-name';
import { baseDataScopeForTool, dataScopeForToolCall } from '@/lib/mcp/tool-data-scope';
import { MCP_TOOL_NAMES } from '@/lib/mcp/tool-catalogue';

const EXT = externalToolName('cmconnaaa', 'list_alerts');

describe('external tools reach EXTERNAL_EGRESS', () => {
    it('at grant time', () => {
        expect(baseDataScopeForTool(EXT)).toBe('EXTERNAL_EGRESS');
    });

    it.each([
        ['no arguments', undefined],
        ['an empty object', {}],
        ['a narrow-looking argument', { severity: 'info' }],
        ['a non-object', 'whatever'],
        ['null', null],
    ])('at call time, with %s', (_label, args) => {
        expect(dataScopeForToolCall(EXT, args)).toBe('EXTERNAL_EGRESS');
    });

    it('for a tool on any connection, not just the one in this file', () => {
        expect(baseDataScopeForTool(externalToolName('cmotherconn', 'query'))).toBe(
            'EXTERNAL_EGRESS',
        );
    });
});

describe('built-in tools are untouched by that rule', () => {
    /**
     * The paired negative, over the WHOLE catalogue with its denominator: a
     * rule that answered EXTERNAL_EGRESS for everything would satisfy every
     * assertion above while making every agent's declared scope meaningless.
     */
    it('no built-in tool is pushed to the egress rung', () => {
        const pushed = MCP_TOOL_NAMES.filter(
            (n) => baseDataScopeForTool(n) === 'EXTERNAL_EGRESS',
        );
        expect({ checked: MCP_TOOL_NAMES.length, pushed }).toEqual({
            checked: MCP_TOOL_NAMES.length,
            pushed: [],
        });
        expect(MCP_TOOL_NAMES.length).toBeGreaterThan(10);
    });
});
