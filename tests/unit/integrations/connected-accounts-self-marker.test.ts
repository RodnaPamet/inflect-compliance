/**
 * #2881 finding 54 — which row is the one the integration authenticates AS.
 *
 * ═══ WHY THIS IS THE FIX AND "ADD A PROTECTION FEATURE" IS NOT ═══
 *
 * The protection mechanism was already complete: a usecase, a route, and a
 * page with protect/release. Production still read `isProtected` TRUE on **0
 * of 37** accounts, and the reason is visible in the same production: neither
 * connection stores `bindDN` in `configJson`, so the bind lives in the
 * encrypted secret bag and an operator looking at 26 Active Directory rows had
 * no way to tell which one was the service account. The page offered a protect
 * button and no indication of which row most needed it.
 *
 * ═══ THE MARKER AGREES WITH THE RAIL BY CONSTRUCTION ═══
 *
 * The flag is computed by calling the self-lockout rail's own `matchesSelf`
 * over the writer factory's own `selfAccountIdsFromConnection` — not by
 * reasoning about binds a second time. That is the property worth having: a
 * marked row is one rail 0a WILL refuse, and a roster with nothing marked means
 * the rail cannot recognise its own account, which is the finding itself made
 * visible rather than left latent. A second implementation would be a mirror,
 * and a mirror that drifts here reads as "you are covered" while the rail
 * refuses nothing.
 */
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));

const findManyAccounts = jest.fn();
const findManyConnections = jest.fn();
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({
            connectedIdentityAccount: { findMany: (...a: unknown[]) => findManyAccounts(...a) },
            integrationConnection: { findMany: (...a: unknown[]) => findManyConnections(...a) },
            integrationExecution: { findMany: jest.fn(async () => []) },
            identityWriteJournal: { findMany: jest.fn(async () => []) },
        }),
    ),
}));
// The bind arrives as a SECRET. Decryption is stubbed to identity so the
// fixture can state the bind in the clear; `selfAccountIdsFromConnection`
// merges config and secrets exactly as production does.
jest.mock('@/lib/security/encryption', () => ({
    decryptField: jest.fn((s: string) => s),
    encryptField: jest.fn((s: string) => s),
}));

import { listConnectedAccounts } from '@/app-layer/usecases/integrations';
import { selfAccountIdsFromConnection } from '@/app-layer/integrations/identity-writer-factory';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('OWNER', { tenantId: 't1' });

function account(id: string, over: Record<string, unknown> = {}) {
    return {
        id,
        provider: 'active-directory',
        email: `${id}@corp.example`,
        externalUserId: `guid-${id}`,
        displayName: id,
        status: 'ACTIVE',
        isAdmin: false,
        mfaEnrolled: true,
        lastActiveAt: null,
        syncedAt: new Date(),
        isProtected: false,
        protectionReason: null,
        connectionId: 'conn-1',
        connection: { name: 'Corp AD' },
        identityLink: null,
        ...over,
    };
}

/** A connection whose secret bag names these binds. */
function connection(binds: { bindDN?: string; writeBindDN?: string }) {
    return {
        id: 'conn-1',
        configJson: {},
        secretEncrypted: JSON.stringify(binds),
    };
}

function marked(rows: Array<{ id: string; isSelfAccount: boolean }>) {
    return rows.filter((r) => r.isSelfAccount).map((r) => r.id);
}

beforeEach(() => {
    jest.clearAllMocks();
    findManyConnections.mockResolvedValue([]);
});

describe('the account the integration authenticates as', () => {
    it('is marked when the bind names its EMAIL', async () => {
        findManyAccounts.mockResolvedValue([account('svc'), account('alice')]);
        findManyConnections.mockResolvedValue([connection({ bindDN: 'svc@corp.example' })]);

        const rows = await listConnectedAccounts(ctx);

        expect(marked(rows)).toStrictEqual(['svc']);
    });

    it('is marked when the bind names its DIRECTORY ID instead', async () => {
        // An account is known by an objectGUID, a DN or a userPrincipalName
        // depending on who names it, which is why the rail weighs both.
        findManyAccounts.mockResolvedValue([account('svc'), account('alice')]);
        findManyConnections.mockResolvedValue([connection({ bindDN: 'guid-svc' })]);

        const rows = await listConnectedAccounts(ctx);

        expect(marked(rows)).toStrictEqual(['svc']);
    });

    it('marks the READ bind as well as the write bind', async () => {
        // Disabling the read bind stops the nightly sync, stales every link,
        // and makes each later leaver pass refuse NO_FRESH_LINKS — offboarding
        // stops for everyone. A dedicated write bind does not make it
        // expendable.
        findManyAccounts.mockResolvedValue([account('reader'), account('writer'), account('alice')]);
        findManyConnections.mockResolvedValue([
            connection({ bindDN: 'reader@corp.example', writeBindDN: 'writer@corp.example' }),
        ]);

        const rows = await listConnectedAccounts(ctx);

        expect(marked(rows).sort()).toStrictEqual(['reader', 'writer']);
    });

    it('ignores case and surrounding whitespace, as the rail does', async () => {
        findManyAccounts.mockResolvedValue([account('svc')]);
        findManyConnections.mockResolvedValue([connection({ bindDN: '  SVC@Corp.Example  ' })]);

        const rows = await listConnectedAccounts(ctx);

        expect(marked(rows)).toStrictEqual(['svc']);
    });
});

describe('when the rail cannot recognise its own account', () => {
    it('marks NOTHING — which is the operator’s signal, not a silent pass', async () => {
        // A connection with no bind stored at all. Every row comes back
        // unmarked, and that is the honest answer: rail 0a has nothing to
        // compare and will refuse nobody.
        findManyAccounts.mockResolvedValue([account('svc'), account('alice')]);
        findManyConnections.mockResolvedValue([connection({})]);

        const rows = await listConnectedAccounts(ctx);

        expect(marked(rows)).toStrictEqual([]);
    });

    it('does not match an account with no email on a blank bind', async () => {
        // Blank strings are dropped rather than compared. Otherwise an account
        // with no email and a connection with no bind match each other on `''`
        // and every row in the tenant is marked as the service account.
        findManyAccounts.mockResolvedValue([account('ghost', { email: '', externalUserId: '' })]);
        findManyConnections.mockResolvedValue([connection({ bindDN: '' })]);

        const rows = await listConnectedAccounts(ctx);

        expect(marked(rows)).toStrictEqual([]);
    });
});

describe('the shape on the wire', () => {
    it('keeps externalUserId OFF the response, though the match needs it', async () => {
        // Searched but never rendered: it is the id an operator copies out of
        // the provider's console, and this page does not hand it back.
        findManyAccounts.mockResolvedValue([account('svc')]);
        findManyConnections.mockResolvedValue([connection({ bindDN: 'guid-svc' })]);

        const rows = await listConnectedAccounts(ctx);

        expect(rows[0]).not.toHaveProperty('externalUserId');
        expect(rows[0].isSelfAccount).toBe(true);
    });

    it('reads the connections ONCE, not once per row', async () => {
        findManyAccounts.mockResolvedValue([account('a'), account('b'), account('c')]);
        findManyConnections.mockResolvedValue([connection({ bindDN: 'a@corp.example' })]);

        await listConnectedAccounts(ctx);

        expect(findManyConnections).toHaveBeenCalledTimes(1);
    });
});

/**
 * The bind derivation, pinned on its own.
 *
 * WHY SEPARATELY, when the roster tests above already cover the outcome: a
 * mutation that deleted the blank filter here left every roster assertion
 * GREEN, because `matchesSelf` ALSO drops blank ids — on both the self side
 * (`self.trim() !== ''`) and the candidate side. That is defence in depth and
 * the redundancy is welcome, but it means the outcome tests cannot see this
 * layer break. Asserting the derivation directly is what gives the filter
 * teeth of its own, so a later edit that removes it does not sit green behind
 * a neighbour that happens to compensate.
 */
describe('selfAccountIdsFromConnection — the derivation itself', () => {
    it('names both binds and drops the ones that are blank', () => {
        expect(
            selfAccountIdsFromConnection({
                configJson: {},
                secretEncrypted: JSON.stringify({ writeBindDN: 'writer@corp.example', bindDN: '   ' }),
            }),
        ).toStrictEqual(['writer@corp.example']);
    });

    it('returns an empty list when the connection names no bind at all', () => {
        expect(
            selfAccountIdsFromConnection({ configJson: {}, secretEncrypted: JSON.stringify({}) }),
        ).toStrictEqual([]);
    });

    it('falls back to configJson rather than throwing when the secrets will not decrypt', () => {
        // A dry run that protects one bind beats one that protects neither.
        expect(
            selfAccountIdsFromConnection({
                configJson: { bindDN: 'reader@corp.example' },
                secretEncrypted: 'not-json-at-all{',
            }),
        ).toStrictEqual(['reader@corp.example']);
    });
});
