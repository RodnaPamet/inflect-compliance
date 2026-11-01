/**
 * What the compose page offers (#4895).
 *
 *   - Only saved parameter sets that OPEN a field. An exact-value set, or one
 *     whose open fields cannot be read, has nothing to fill in: offered, it
 *     opened onto an empty form and a button that never enabled. It is counted
 *     instead, so the page can say why it is missing.
 *   - Each is named by its tool's own name and its connection's name, never
 *     the qualified `mcp__<connectionId>__<tool>` key.
 *   - A value field carries the bound the operator chooses within (an enum's
 *     values, an integer's range, a length), and never a pattern.
 */
const findManyConnMock = jest.fn();
const findFirstSetMock = jest.fn();
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_c: unknown, fn: (db: unknown) => unknown) =>
        fn({
            integrationConnection: { findMany: findManyConnMock },
            externalToolParameterSet: { findFirst: findFirstSetMock },
        }),
}));
jest.mock('@/lib/security/encryption', () => ({ decryptField: (v: string) => v }));
jest.mock('@/app-layer/integrations/mcp/client', () => ({ callTool: jest.fn() }));
jest.mock('@/app-layer/integrations/mcp/token', () => ({ authorizationFor: async () => 'Bearer x' }));
jest.mock('@/app-layer/usecases/external-prior-state-read', () => ({ getPriorStateRead: jest.fn() }));
jest.mock('@/app-layer/usecases/agent-proposals', () => ({ createAgentProposal: jest.fn() }));
jest.mock('@/app-layer/usecases/external-tool-target-populations', () => ({
    checkTargetInPopulation: jest.fn(),
    resolveTargetPopulation: jest.fn(),
    TARGET_POPULATIONS: {},
}));

const listParameterSetsMock = jest.fn();
jest.mock('@/app-layer/usecases/external-tool-parameters', () => ({
    listParameterSets: (...a: unknown[]) => listParameterSetsMock(...a),
}));

import { listComposableTemplates, listComposeOffer } from '@/app-layer/usecases/external-write-compose';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('EDITOR', { tenantId: 'tenant-A' });

const set = (id: string, over: Record<string, unknown>) => ({
    id,
    label: `set ${id}`,
    toolName: 'mcp__conn-1__grant_role',
    openFields: null,
    targetPopulation: null,
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    findManyConnMock.mockResolvedValue([{ id: 'conn-1', name: 'Entra (production)' }]);
});

describe('listComposableTemplates', () => {
    it('offers only sets that open a field, and counts the rest', async () => {
        listParameterSetsMock.mockResolvedValueOnce([
            set('open', { openFields: { role: { kind: 'enum', values: ['reader', 'editor'] } } }),
            set('exact', { openFields: null }),
            set('unreadable', { openFields: { role: { kind: 'nonsense' } } }),
        ]);
        const out = await listComposableTemplates(ctx);
        expect(out.templates.map((t) => t.id)).toEqual(['open']);
        expect(out.notComposable).toBe(2);
    });

    it('names the tool by its own name and its connection, never the qualified key', async () => {
        listParameterSetsMock.mockResolvedValueOnce([
            set('open', { openFields: { role: { kind: 'enum', values: ['reader'] } } }),
        ]);
        const out = await listComposableTemplates(ctx);
        expect(out.templates[0]).toEqual({
            id: 'open',
            label: 'set open',
            toolName: 'grant_role',
            connectionName: 'Entra (production)',
        });
        expect(findManyConnMock).toHaveBeenCalledWith(
            expect.objectContaining({ where: { tenantId: 'tenant-A', id: { in: ['conn-1'] } } }),
        );
    });

    it('a connection it cannot find leaves the name null, not a guess', async () => {
        findManyConnMock.mockResolvedValueOnce([]);
        listParameterSetsMock.mockResolvedValueOnce([
            set('open', { openFields: { role: { kind: 'enum', values: ['reader'] } } }),
        ]);
        const out = await listComposableTemplates(ctx);
        expect(out.templates[0].connectionName).toBeNull();
    });

    it('reads no connection when there is nothing to offer', async () => {
        listParameterSetsMock.mockResolvedValueOnce([set('exact', {})]);
        const out = await listComposableTemplates(ctx);
        expect(out).toEqual({ templates: [], notComposable: 1 });
        expect(findManyConnMock).not.toHaveBeenCalled();
    });
});

describe('listComposeOffer — a value field carries its bound', () => {
    it('an enum its values, an integer and a length their range, a pattern nothing', async () => {
        findFirstSetMock.mockResolvedValueOnce({
            label: 'set',
            toolName: 'mcp__conn-1__grant_role',
            openFields: {
                role: { kind: 'enum', values: ['reader', 'editor'] },
                days: { kind: 'integer', min: 1, max: 30 },
                reason: { kind: 'length', min: 10, max: 200 },
                ticket: { kind: 'regex', pattern: '^INC-[0-9]+$' },
            },
            targetPopulation: null,
        });
        const out = await listComposeOffer(ctx, 'set-1');
        if (!out.ok) throw new Error('expected an offer');
        const byName = Object.fromEntries(out.fields.map((f) => [f.name, f]));
        expect(byName.role).toEqual({ name: 'role', kind: 'enum', allowed: ['reader', 'editor'] });
        expect(byName.days).toEqual({ name: 'days', kind: 'integer', min: 1, max: 30 });
        expect(byName.reason).toEqual({ name: 'reason', kind: 'length', min: 10, max: 200 });
        expect(byName.ticket).toEqual({ name: 'ticket', kind: 'regex' });
    });
});
