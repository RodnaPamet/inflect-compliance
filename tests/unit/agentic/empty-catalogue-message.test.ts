/**
 * #5045 — an EMPTY_CATALOGUE run names the term that withheld its tools.
 *
 * The production case: an agent granted `list_risks`, `list_controls` and
 * `list_tasks` whose policy card permitted none of them was told "this agent
 * holds no MCP tool grants". The message now says that only when it is true.
 */
import { emptyCatalogueMessage, emptyCatalogueReasons } from '@/lib/agentic/empty-catalogue-message';
import { EMPTY_TOOLSET_MESSAGE } from '@/lib/agentic/flue/empty-toolset-message';
import { MCP_TOOL_NAMES } from '@/lib/mcp/tool-catalogue';

const READS = ['list_risks', 'list_controls', 'list_tasks'];
const granted = (...names: string[]) => new Set(names);

describe('emptyCatalogueMessage (#5045)', () => {
    it('says "holds no grants" when, and only when, the agent holds none', () => {
        expect(emptyCatalogueMessage('flue', { grantedTools: granted(), omitted: [] })).toBe(EMPTY_TOOLSET_MESSAGE);
        expect(emptyCatalogueMessage('tool_runner', { grantedTools: granted(), omitted: [] })).toBe(EMPTY_TOOLSET_MESSAGE);
    });

    it('falls back to the old sentence when there is no grant list and nothing to name', () => {
        expect(emptyCatalogueMessage('flue', { grantedTools: null, omitted: [] })).toBe(EMPTY_TOOLSET_MESSAGE);
        expect(emptyCatalogueMessage('flue', { omitted: [] })).toBe(EMPTY_TOOLSET_MESSAGE);
    });

    it('names the policy card when it permits none of the granted tools (the production case)', () => {
        const msg = emptyCatalogueMessage('tool_runner', {
            grantedTools: granted(...READS),
            permittedTools: [],
            offeredTools: MCP_TOOL_NAMES,
            omitted: [],
        });
        expect(msg).not.toBe(EMPTY_TOOLSET_MESSAGE);
        expect(msg).not.toContain('holds no MCP tool grants');
        expect(msg.startsWith('tool_runner_no_tools_offered: this agent holds 3 MCP tool grants')).toBe(true);
        expect(msg).toContain('none of its granted tools is permitted by its policy card (list_controls, list_risks, list_tasks)');
    });

    it('prefixes the code with the engine that settled', () => {
        const facts = { grantedTools: granted('list_risks'), permittedTools: [], offeredTools: MCP_TOOL_NAMES, omitted: [] };
        expect(emptyCatalogueMessage('flue', facts).startsWith('flue_no_tools_offered:')).toBe(true);
        expect(emptyCatalogueMessage('tool_runner', facts).startsWith('tool_runner_no_tools_offered:')).toBe(true);
    });

    it.each([
        ['SCOPE', "outside the credential's scopes (list_risks)"],
        ['AUTONOMY', "above the agent's autonomy ceiling (list_risks)"],
        ['CONNECTION_READ_ONLY', 'write tools whose connection is set to read-only (list_risks)'],
        ['UNCONVERTIBLE_SCHEMA', 'an input schema this engine cannot express (list_risks)'],
        ['READ_ONLY_WORKFLOW', 'propose tools, which this read-only workflow is not offered (list_risks)'],
    ] as const)('names an offer omission %s', (reason, text) => {
        const msg = emptyCatalogueMessage('flue', {
            grantedTools: granted('list_risks'),
            permittedTools: null,
            offeredTools: MCP_TOOL_NAMES,
            omitted: [{ name: 'list_risks', reason }],
        });
        expect(msg).toContain(text);
        expect(msg).not.toContain('holds no MCP tool grants');
    });

    it('a propose-only profile on a read-only run says the profile names only propose tools', () => {
        const msg = emptyCatalogueMessage('tool_runner', {
            grantedTools: granted('list_risks', 'propose_risks'),
            permittedTools: null,
            offeredTools: MCP_TOOL_NAMES,
            omitted: [{ name: 'propose_risks', reason: 'READ_ONLY_WORKFLOW' }],
            profileTools: ['propose_risks'],
        });
        expect(msg).toContain('the profile names only propose tools, and this run is read-only');
        expect(msg).toContain('(propose_risks)');
        // A grant the profile did not name is the author's choice, not a withholding.
        expect(msg).not.toContain('list_risks)');
    });

    it('re-reads the offer\'s PROFILE_TOOL_NOT_GRANTED: a granted tool the card forbids is named as the card', () => {
        const reasons = emptyCatalogueReasons({
            grantedTools: granted('list_risks'),
            permittedTools: ['list_tasks'],
            offeredTools: MCP_TOOL_NAMES,
            omitted: [
                { name: 'list_risks', reason: 'PROFILE_TOOL_NOT_GRANTED' },
                { name: 'list_controls', reason: 'PROFILE_TOOL_NOT_GRANTED' },
            ],
            profileTools: ['list_risks', 'list_controls'],
        });
        expect(Object.fromEntries(reasons)).toEqual({
            PROFILE_TOOL_NOT_GRANTED: ['list_controls'],
            POLICY_CARD: ['list_risks'],
        });
    });

    it('names a granted tool missing from the catalogue, and one the acting context may not see', () => {
        const reasons = emptyCatalogueReasons({
            grantedTools: granted('ext_tool', 'list_risks'),
            permittedTools: null,
            offeredTools: MCP_TOOL_NAMES,
            omitted: [],
        });
        expect(Object.fromEntries(reasons)).toEqual({ NOT_IN_CATALOGUE: ['ext_tool'], PERMISSION: ['list_risks'] });
    });

    it('several terms are each named, and a card clause no longer says "none of"', () => {
        const msg = emptyCatalogueMessage('flue', {
            grantedTools: granted('list_risks', 'list_tasks'),
            permittedTools: ['list_tasks'],
            offeredTools: MCP_TOOL_NAMES,
            omitted: [{ name: 'list_tasks', reason: 'AUTONOMY' }],
        });
        expect(msg).toContain('Withheld: not permitted by its policy card (list_risks)');
        expect(msg).toContain("; above the agent's autonomy ceiling (list_tasks).");
    });

    it('bounds the names it lists', () => {
        const many = Array.from({ length: 20 }, (_, i) => `ext_${String(i).padStart(2, '0')}`);
        const msg = emptyCatalogueMessage('tool_runner', {
            grantedTools: granted(...many),
            permittedTools: [],
            offeredTools: many,
            omitted: [],
        });
        expect(msg).toContain('ext_07 and 12 more');
        expect(msg).not.toContain('ext_08');
    });
});
