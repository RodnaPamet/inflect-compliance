/**
 * `anthropicWorkspaceHeaders` — the one definition of the header an
 * organisation-level Anthropic key needs. Every Anthropic caller spreads its
 * answer into a request, so the two properties that matter are what it adds
 * when an id is configured and that it adds NOTHING when one is not: the
 * second is what keeps a workspace-scoped key's requests unchanged.
 */
import {
    ANTHROPIC_WORKSPACE_HEADER,
    anthropicWorkspaceHeaders,
} from '@/lib/ai/anthropic-workspace';

describe('anthropicWorkspaceHeaders', () => {
    it('names the workspace under the header Anthropic reads', () => {
        expect(ANTHROPIC_WORKSPACE_HEADER).toBe('anthropic-workspace-id');
        expect(anthropicWorkspaceHeaders('wrkspc_01ABC')).toEqual({
            'anthropic-workspace-id': 'wrkspc_01ABC',
        });
    });

    it('trims, so a newline pasted into an env file is not sent as part of the id', () => {
        expect(anthropicWorkspaceHeaders('  wrkspc_01ABC\n')).toEqual({
            'anthropic-workspace-id': 'wrkspc_01ABC',
        });
    });

    it.each([
        ['undefined', undefined],
        ['null', null],
        ['empty', ''],
        ['whitespace only', ' \t\n'],
    ])('adds nothing when the id is %s', (_label, value) => {
        expect(anthropicWorkspaceHeaders(value)).toEqual({});
        // Spread into a request's headers, it leaves them exactly as they were.
        const base = { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' };
        expect({ ...base, ...anthropicWorkspaceHeaders(value) }).toEqual(base);
    });
});
