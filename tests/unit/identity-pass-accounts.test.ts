/* eslint-disable @typescript-eslint/no-explicit-any -- test-mock pattern. */
/** #4875 — who each leaver-pass decision is about. */
const mockDb = { identityAccountLink: { findMany: jest.fn() } };
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_ctx: any, fn: (db: any) => any) => fn(mockDb),
}));

import {
    decisionLinkIds,
    resolvePassAccounts,
    MAX_RESOLVED_LINKS,
} from '@/app-layer/usecases/identity-pass-accounts';

const ctx = { tenantId: 't1', userId: 'u1' } as any;

beforeEach(() => jest.clearAllMocks());

describe('decisionLinkIds', () => {
    it('collects each distinct link id across passes, and ignores rows that carry none', () => {
        const ids = decisionLinkIds([
            { resultJson: { decisions: [{ linkId: 'l1' }, { linkId: 'l2' }] } },
            { resultJson: { decisions: [{ linkId: 'l1' }, { outcome: 'DRY_RUN' }] } },
            { resultJson: { refusal: 'NO_FRESH_LINKS' } },
            { resultJson: null },
        ]);
        expect(ids.sort()).toEqual(['l1', 'l2']);
    });

    it(`stops at ${MAX_RESOLVED_LINKS}`, () => {
        const decisions = Array.from({ length: MAX_RESOLVED_LINKS + 10 }, (_, i) => ({ linkId: `l${i}` }));
        expect(decisionLinkIds([{ resultJson: { decisions } }])).toHaveLength(MAX_RESOLVED_LINKS);
    });
});

describe('resolvePassAccounts', () => {
    it('reads nothing for no ids', async () => {
        expect(await resolvePassAccounts(ctx, [])).toEqual({});
        expect(mockDb.identityAccountLink.findMany).not.toHaveBeenCalled();
    });

    it("names the person and prefers the directory's address", async () => {
        mockDb.identityAccountLink.findMany.mockResolvedValue([
            { id: 'l1', employee: { fullName: 'Ada Lovelace', workEmail: 'ada@hr.test' }, connectedAccount: { email: 'ada@dir.test' } },
            { id: 'l2', employee: { fullName: 'Alan Turing', workEmail: 'alan@hr.test' }, connectedAccount: { email: null } },
        ]);

        const out = await resolvePassAccounts(ctx, ['l1', 'l2', 'l1', 'gone']);
        expect(out).toEqual({
            l1: { name: 'Ada Lovelace', email: 'ada@dir.test' },
            l2: { name: 'Alan Turing', email: 'alan@hr.test' },
        });
        // A link that no longer exists is simply absent: never guessed.
        expect(out.gone).toBeUndefined();
        expect(mockDb.identityAccountLink.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenantId: 't1', id: { in: ['l1', 'l2', 'gone'] } },
                take: 3,
            }),
        );
    });
});
