/**
 * #2750 — the joiner's provisioner is RESOLVED, the way writers are.
 *
 * Before this seam the live Active Directory provisioner existed, was tested,
 * and was reachable from nothing. `createSnapshotProvisioner` was the only arm
 * any caller could obtain and it refuses all four create steps by name, so the
 * joiner could be complete in every file and still create nobody. A capability
 * with no resolution path is indistinguishable from an absent one.
 *
 * Two properties carry the weight here, and neither is "the factory returns
 * something":
 *
 *   1. **Below AUTOMATIC the live arm is not constructed.** Asserted against
 *      the CONSTRUCTOR SPY, not against the returned `kind` — a `kind:
 *      'snapshot'` result built by opening an LDAPS bind first would satisfy
 *      the label and violate the rung.
 *   2. **Entra at AUTOMATIC refuses by its own name.** The writer factory's
 *      last arm falls through to `createActiveDirectoryWriter`, so a provider
 *      with no branch silently gets AD's. The same mistake here would send an
 *      Entra create down an LDAPS bind and set a PASSWORD where the design
 *      says a Temporary Access Pass or nothing.
 */
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
jest.mock('@/lib/security/encryption', () => ({
    decryptField: jest.fn((v: string) => {
        if (v === 'BROKEN') throw new Error('auth tag mismatch');
        return v;
    }),
}));

// The live arm is spied rather than exercised: this file is about WHICH arm is
// chosen. `AD_COLLISION_NAMESPACES` is re-stated because the module is mocked
// whole, and the factory hands it to the snapshot provisioner.
const createAdProvisioner = jest.fn();
jest.mock('@/app-layer/integrations/providers/active-directory/provisioner', () => ({
    createActiveDirectoryProvisioner: (...a: unknown[]) => createAdProvisioner(...a),
    AD_COLLISION_NAMESPACES: ['sAMAccountName', 'userPrincipalName'],
}));

import {
    resolveDirectoryProvisioner,
    hasLiveProvisioner,
    LIVE_PROVISIONER_PROVIDERS,
    ENTRA_COLLISION_NAMESPACES,
} from '@/app-layer/integrations/identity-provisioner-factory';
import { WRITABLE_IDENTITY_PROVIDERS } from '@/app-layer/integrations/identity-writable-providers';
import { makeRequestContext } from '../../helpers/make-context';

const mockDb = {
    integrationConnection: { findMany: jest.fn() },
};

const ctx = makeRequestContext('ADMIN', { tenantId: 't1' });

function conn(over: Record<string, unknown> = {}) {
    return {
        id: 'conn-1',
        configJson: {
            url: 'ldaps://dc.corp.internal',
            baseDN: 'DC=corp,DC=internal',
            createOU: 'OU=Employees,DC=corp,DC=internal',
        },
        secretEncrypted: null,
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.integrationConnection.findMany.mockResolvedValue([conn()]);
    createAdProvisioner.mockReturnValue({
        provider: 'active-directory',
        collisionNamespaces: ['sAMAccountName', 'userPrincipalName'],
        close: jest.fn(async () => undefined),
    });
});

describe('#2750 — below AUTOMATIC, no live provisioner is constructed', () => {
    it.each(['DRY_RUN', 'DISABLED'])('mode %s gets the snapshot arm', async (mode) => {
        const r = await resolveDirectoryProvisioner({ ctx, provider: 'active-directory', mode });

        expect(r.kind).toBe('snapshot');
        // THE ACTUAL PROOF. `kind: 'snapshot'` is a label the factory writes;
        // this is the constructor that would have opened an LDAPS bind and
        // been able to create an account.
        expect(createAdProvisioner).not.toHaveBeenCalled();
    });

    it('an UNRECOGNISED stored mode gets the snapshot arm, not the live one', async () => {
        // The retired `PROPOSE` rung is the worked example (#2241). The test
        // that matters is not that some string is handled — it is that the arm
        // is chosen by an ALLOWLIST, so a mode nobody anticipated lands on the
        // side that opens no socket.
        const r = await resolveDirectoryProvisioner({
            ctx,
            provider: 'active-directory',
            mode: 'PROPOSE',
        });

        expect(r.kind).toBe('snapshot');
        expect(createAdProvisioner).not.toHaveBeenCalled();
    });

    it('the snapshot arm answers UNKNOWN and names the namespaces it could not consult', async () => {
        const r = await resolveDirectoryProvisioner({ ctx, provider: 'entra-id', mode: 'DRY_RUN' });
        if (r.kind !== 'snapshot') throw new Error('narrowing');

        const probe = await r.provisioner.probeIdentifier('new.person@corp.test');
        expect(probe.kind).toBe('unknown');
        // Not merely "unknown" — WHICH namespaces went unchecked, so an old
        // artefact cannot be re-read as having promised more than it checked.
        if (probe.kind === 'unknown') {
            expect(probe.namespacesUnavailable).toEqual([...ENTRA_COLLISION_NAMESPACES]);
        }
    });

    it('the AD snapshot arm names AD namespaces, not Entra ones', async () => {
        const r = await resolveDirectoryProvisioner({
            ctx,
            provider: 'active-directory',
            mode: 'DRY_RUN',
        });
        if (r.kind !== 'snapshot') throw new Error('narrowing');

        expect(r.provisioner.collisionNamespaces).toEqual([
            'sAMAccountName',
            'userPrincipalName',
        ]);
    });
});

describe('#2750 — AUTOMATIC resolves the live arm, through the factory', () => {
    it('constructs the AD provisioner from the merged connection', async () => {
        const r = await resolveDirectoryProvisioner({
            ctx,
            provider: 'active-directory',
            mode: 'AUTOMATIC',
        });

        expect(r.kind).toBe('live');
        expect(createAdProvisioner).toHaveBeenCalledTimes(1);
        // The merged bag, not `configJson` — the write bind arrives as a
        // SECRET, so a factory that passed config alone would build a
        // provisioner that binds as the read-only enumeration account.
        expect(createAdProvisioner.mock.calls[0][0].connection).toMatchObject({
            baseDN: 'DC=corp,DC=internal',
        });
    });

    it('secrets override config, so a rotated write bind wins', async () => {
        mockDb.integrationConnection.findMany.mockResolvedValue([
            conn({
                configJson: { url: 'ldaps://dc.corp.internal', writeBindDN: 'CN=stale' },
                secretEncrypted: JSON.stringify({ writeBindDN: 'CN=current' }),
            }),
        ]);

        await resolveDirectoryProvisioner({ ctx, provider: 'active-directory', mode: 'AUTOMATIC' });

        expect(createAdProvisioner.mock.calls[0][0].connection.writeBindDN).toBe('CN=current');
    });

    it('carries a close() that disposes the live LDAP bind', async () => {
        const close = jest.fn(async () => undefined);
        createAdProvisioner.mockReturnValue({ provider: 'active-directory', close });

        const r = await resolveDirectoryProvisioner({
            ctx,
            provider: 'active-directory',
            mode: 'AUTOMATIC',
        });
        if (r.kind !== 'live') throw new Error('narrowing');
        await r.close();

        // A leaked bind outlives the process that made it, and `close` is on
        // every arm precisely so a caller's finally is unconditional.
        expect(close).toHaveBeenCalledTimes(1);
    });
});

describe('#2750 — Entra refuses to create rather than degrading', () => {
    it('refuses NO_LIVE_PROVISIONER at AUTOMATIC, and builds nothing', async () => {
        const r = await resolveDirectoryProvisioner({ ctx, provider: 'entra-id', mode: 'AUTOMATIC' });

        if (r.kind !== 'none') throw new Error('narrowing');
        expect(r.refusal).toBe('NO_LIVE_PROVISIONER');
        // The failure this prevents: an Entra create handed to the AD arm,
        // which would bind LDAPS to a host the connection does not have and
        // set a PASSWORD where the design says a TAP or nothing.
        expect(createAdProvisioner).not.toHaveBeenCalled();
    });

    it('NO_LIVE_PROVISIONER is not UNSUPPORTED_PROVIDER — Entra IS writable', async () => {
        const r = await resolveDirectoryProvisioner({ ctx, provider: 'entra-id', mode: 'AUTOMATIC' });
        if (r.kind !== 'none') throw new Error('narrowing');

        // Reporting "entra-id has no directory writer" would be false and
        // would send an operator to the wrong setting entirely.
        expect(r.refusal).not.toBe('UNSUPPORTED_PROVIDER');
        expect(WRITABLE_IDENTITY_PROVIDERS).toContain('entra-id');
        expect(hasLiveProvisioner('entra-id')).toBe(false);
    });

    it('but Entra still gets a DRY_RUN arm — observation must not be blocked', async () => {
        // If the refusal sat beside UNSUPPORTED_PROVIDER it would fire before
        // the snapshot arm, and the seven-day observation window would be
        // unavailable for the directory most tenants actually have.
        const r = await resolveDirectoryProvisioner({ ctx, provider: 'entra-id', mode: 'DRY_RUN' });

        expect(r.kind).toBe('snapshot');
    });

    it('the live set is a strict subset of the writable set', () => {
        for (const p of LIVE_PROVISIONER_PROVIDERS) {
            expect(WRITABLE_IDENTITY_PROVIDERS).toContain(p);
        }
        expect(LIVE_PROVISIONER_PROVIDERS.length).toBeLessThan(
            WRITABLE_IDENTITY_PROVIDERS.length,
        );
    });
});

describe('#2750 — connection refusals, cheapest first', () => {
    it('UNSUPPORTED_PROVIDER costs no connection read', async () => {
        const r = await resolveDirectoryProvisioner({ ctx, provider: 'okta', mode: 'AUTOMATIC' });

        if (r.kind !== 'none') throw new Error('narrowing');
        expect(r.refusal).toBe('UNSUPPORTED_PROVIDER');
        expect(mockDb.integrationConnection.findMany).not.toHaveBeenCalled();
    });

    it('NO_CONNECTION rather than a per-candidate failure', async () => {
        mockDb.integrationConnection.findMany.mockResolvedValue([]);

        const r = await resolveDirectoryProvisioner({
            ctx,
            provider: 'active-directory',
            mode: 'DRY_RUN',
        });

        if (r.kind !== 'none') throw new Error('narrowing');
        expect(r.refusal).toBe('NO_CONNECTION');
    });

    it('AMBIGUOUS_CONNECTION rather than guessing a forest', async () => {
        mockDb.integrationConnection.findMany.mockResolvedValue([conn(), conn({ id: 'conn-2' })]);

        const r = await resolveDirectoryProvisioner({
            ctx,
            provider: 'active-directory',
            mode: 'AUTOMATIC',
        });

        if (r.kind !== 'none') throw new Error('narrowing');
        expect(r.refusal).toBe('AMBIGUOUS_CONNECTION');
        expect(createAdProvisioner).not.toHaveBeenCalled();
    });

    it('SECRETS_UNREADABLE refuses by name instead of building on an empty bag', async () => {
        mockDb.integrationConnection.findMany.mockResolvedValue([
            conn({ secretEncrypted: 'BROKEN' }),
        ]);

        const r = await resolveDirectoryProvisioner({
            ctx,
            provider: 'active-directory',
            mode: 'AUTOMATIC',
        });

        if (r.kind !== 'none') throw new Error('narrowing');
        expect(r.refusal).toBe('SECRETS_UNREADABLE');
        // Continuing with `{}` would produce a provisioner that fails once per
        // person with nothing said about why.
        expect(createAdProvisioner).not.toHaveBeenCalled();
    });

    it('a constructor refusal is WRITER_REFUSED, and the detail is not logged', async () => {
        createAdProvisioner.mockImplementation(() => {
            throw new Error('Active Directory provisioner needs an LDAPS URL.');
        });

        const r = await resolveDirectoryProvisioner({
            ctx,
            provider: 'active-directory',
            mode: 'AUTOMATIC',
        });

        if (r.kind !== 'none') throw new Error('narrowing');
        expect(r.refusal).toBe('WRITER_REFUSED');
        expect(r.detail).toContain('LDAPS URL');

        // The detail can quote connection fields, so it is returned to the
        // caller and kept out of the ordinary log stream.
        const { logger } = jest.requireMock('@/lib/observability/logger') as {
            logger: { warn: jest.Mock };
        };
        const logged = JSON.stringify(logger.warn.mock.calls);
        expect(logged).not.toContain('LDAPS URL');
    });
});
