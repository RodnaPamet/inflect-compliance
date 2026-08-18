/**
 * Active Directory: the TLS bypass is bound to the resolved address, and the
 * scheme is enforced where clients are actually built.
 *
 * ## Two defects, one of them the anchored-guard shape
 *
 * `validateConnection` already required `ldaps://`. But that is the path an
 * OPERATOR exercises by hand — `listAccounts` reaches the same client factory
 * unattended on every scheduled sync without going near it. So a connection
 * whose url was changed to `ldap://` after its one successful test would bind in
 * clear text, service-account password on the wire, and nothing would say so.
 * A check that exists on the tested path and not the running one reads as
 * coverage while protecting nothing.
 *
 * Separately, `allowSelfSignedTls` disables certificate verification — the
 * control that would make a redirected bind fail loudly. With `url` being
 * tenant-admin config and no vendor allowlist possible (an AD host is customer
 * infrastructure), an admin could redirect the bind AND remove the check that
 * would catch it in one form submission.
 *
 * The option is legitimate: its justification is an internal or enterprise CA,
 * which by definition applies only to an internal host. So the exemption is
 * bound to that condition instead of to the operator's assertion — and to the
 * RESOLVED address, because a name that resolves into RFC1918 is what an
 * attacker would arrange against a name-shaped check.
 */
import { ActiveDirectoryProvider } from '@/app-layer/integrations/providers/active-directory';

const lookupMock = jest.fn();
jest.mock('node:dns', () => ({
    promises: { lookup: (...a: unknown[]) => lookupMock(...a) },
}));

const CONFIG = {
    url: 'ldaps://dc.corp.example.com:636',
    baseDN: 'DC=corp,DC=example,DC=com',
};
const SECRETS = { bindDN: 'CN=svc,DC=corp', bindPassword: 'pw' };

/** A client factory that records whether it was reached, and with what. */
function spyFactory() {
    const calls: Array<{ url: string; rejectUnauthorized?: boolean }> = [];
    const createClient = (opts: { url: string; tlsOptions?: { rejectUnauthorized?: boolean } }) => {
        calls.push({ url: opts.url, rejectUnauthorized: opts.tlsOptions?.rejectUnauthorized });
        return {
            bind: async () => undefined,
            search: async () => ({ searchEntries: [] }),
            unbind: async () => undefined,
        };
    };
    return { calls, createClient };
}

beforeEach(() => lookupMock.mockReset());

describe('the scheme is enforced on the unattended path, not just the tested one', () => {
    it('refuses ldap:// from listAccounts, which never passes through validateConnection', async () => {
        const { calls, createClient } = spyFactory();
        const p = new ActiveDirectoryProvider({ createClient });

        await expect(
            p.listAccounts({ ...CONFIG, ...SECRETS, url: 'ldap://dc.corp.example.com:389' }),
        ).rejects.toThrow(/ldaps:\/\//);

        // The point is that no client was built at all — a bind that happens and
        // then fails has already put the password on the wire.
        expect(calls).toEqual([]);
    });
});

describe('allowSelfSignedTls is gated on where the name actually points', () => {
    it('permits it for a host resolving into private space', async () => {
        lookupMock.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
        const { calls, createClient } = spyFactory();
        const p = new ActiveDirectoryProvider({ createClient });

        await p.listAccounts({ ...CONFIG, ...SECRETS, allowSelfSignedTls: true });

        expect(calls).toHaveLength(1);
        expect(calls[0].rejectUnauthorized).toBe(false);
    });

    it('refuses it for a host resolving to a public address', async () => {
        // The attack: a name the admin controls, pointed anywhere.
        lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        const { calls, createClient } = spyFactory();
        const p = new ActiveDirectoryProvider({ createClient });

        await expect(
            p.listAccounts({ ...CONFIG, ...SECRETS, allowSelfSignedTls: true }),
        ).rejects.toThrow(/private address space/);
        expect(calls).toEqual([]);
    });

    it('refuses when ANY resolved address is public, not just the first', async () => {
        // A name can return several records; checking only one leaves the rest
        // as the attack surface.
        lookupMock.mockResolvedValue([
            { address: '10.0.0.5', family: 4 },
            { address: '93.184.216.34', family: 4 },
        ]);
        const { calls, createClient } = spyFactory();
        const p = new ActiveDirectoryProvider({ createClient });

        await expect(
            p.listAccounts({ ...CONFIG, ...SECRETS, allowSelfSignedTls: true }),
        ).rejects.toThrow(/private address space/);
        expect(calls).toEqual([]);
    });

    it('refuses when the host cannot be resolved, rather than assuming it is internal', async () => {
        lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
        const { createClient } = spyFactory();
        const p = new ActiveDirectoryProvider({ createClient });

        await expect(
            p.listAccounts({ ...CONFIG, ...SECRETS, allowSelfSignedTls: true }),
        ).rejects.toThrow(/could not be resolved/);
    });

    it('does not resolve at all when the bypass is not requested', async () => {
        // Verification stays on, so where the name points is not this check's
        // business — and a DNS call here would be pure latency on every sync.
        const { calls, createClient } = spyFactory();
        const p = new ActiveDirectoryProvider({ createClient });

        await p.listAccounts({ ...CONFIG, ...SECRETS });

        expect(lookupMock).not.toHaveBeenCalled();
        expect(calls[0].rejectUnauthorized).toBe(true);
    });
});
