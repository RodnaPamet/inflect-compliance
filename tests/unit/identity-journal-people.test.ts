/**
 * `readJournalPeople` — whose account each journal entry is about, and who made
 * it (#4877). It names accounts through the leaver passes' own resolver and
 * actors through this workspace's memberships, and reads nothing else.
 */
jest.mock('@/lib/db-context', () => ({ runInTenantContext: jest.fn() }));
const resolvePassAccountsMock = jest.fn();
jest.mock('@/app-layer/usecases/identity-pass-accounts', () => ({
    resolvePassAccounts: (...a: unknown[]) => resolvePassAccountsMock(...a),
}));

import { makeRequestContext } from '../helpers/make-context';
import { runInTenantContext } from '@/lib/db-context';
import { MAX_RESOLVED_ACTORS, readJournalPeople } from '@/app-layer/usecases/identity-journal-people';

const mockRun = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;

function withMembers(rows: Array<{ userId: string; user: { name: string | null; email: string | null } | null }>) {
    const findMany = jest.fn(async () => rows);
    mockRun.mockImplementation(async (_ctx, fn) => fn({ tenantMembership: { findMany } } as never));
    return findMany;
}

beforeEach(() => {
    mockRun.mockReset();
    resolvePassAccountsMock.mockReset().mockResolvedValue({ 'link-1': { name: 'Ana Petrova', email: 'ana@acme.test' } });
});

it('names accounts by link and actors by membership, in one read of this workspace', async () => {
    const findMany = withMembers([{ userId: 'u-1', user: { name: 'Ivo Owner', email: 'ivo@acme.test' } }]);
    const ctx = makeRequestContext('OWNER', { tenantId: 'tenant-1' });
    const people = await readJournalPeople(ctx, [
        { linkId: 'link-1', actorUserId: 'u-1' },
        { linkId: null, actorUserId: 'u-1' },
        { linkId: 'link-1', actorUserId: null },
    ]);
    expect(people).toEqual({
        accounts: { 'link-1': { name: 'Ana Petrova', email: 'ana@acme.test' } },
        actors: { 'u-1': { name: 'Ivo Owner', email: 'ivo@acme.test' } },
    });
    expect(resolvePassAccountsMock).toHaveBeenCalledWith(ctx, ['link-1', 'link-1']);
    expect(findMany).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', userId: { in: ['u-1'] } },
        select: { userId: true, user: { select: { name: true, email: true } } },
        take: 1,
    });
});

it('leaves out an actor with no membership here, so the page names a former member', async () => {
    withMembers([]);
    const people = await readJournalPeople(makeRequestContext('OWNER'), [{ linkId: null, actorUserId: 'u-gone' }]);
    expect(people.actors).toEqual({});
});

it('reads no membership when every entry was a scheduled run', async () => {
    const findMany = withMembers([]);
    await readJournalPeople(makeRequestContext('OWNER'), [{ linkId: 'link-1', actorUserId: null }]);
    expect(findMany).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
});

it('resolves at most MAX_RESOLVED_ACTORS actors', async () => {
    const findMany = withMembers([]);
    const entries = Array.from({ length: MAX_RESOLVED_ACTORS + 5 }, (_, i) => ({ linkId: null, actorUserId: `u-${i}` }));
    await readJournalPeople(makeRequestContext('OWNER'), entries);
    const arg = (findMany.mock.calls[0] as unknown[])[0] as { where: { userId: { in: string[] } } };
    expect(arg.where.userId.in).toHaveLength(MAX_RESOLVED_ACTORS);
});
