/**
 * #5074 — an Okta check over partially enriched accounts cannot PASS.
 *
 * The users list carries no MFA or role signal; each account is enriched from
 * `/factors` and `/roles`, capped at 2,000 accounts and tolerant of per-user
 * failures. Accounts past the cap, or whose calls failed, keep null signals,
 * and the checks used to PASS over the accounts that were enriched.
 */
import { OktaProvider } from '@/app-layer/integrations/providers/okta';
import type { CheckInput } from '@/app-layer/integrations/types';

const orgUrl = 'https://acme.okta.com';
const cfg = { orgUrl, apiToken: 'tok' };

function resp(body: unknown, status = 200) {
    return {
        ok: status < 400,
        status,
        json: async () => body,
        headers: { get: () => null },
    } as unknown as Response;
}

/** One page of `n` active users, each with an active factor and no role; `failing` ids answer 500. */
function oktaFetch(n: number, failing: ReadonlySet<string> = new Set()): typeof fetch {
    const users = Array.from({ length: n }, (_, i) => ({ id: `u${i}`, status: 'ACTIVE', profile: { email: `u${i}@acme.com` } }));
    return (async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/api/v1/users?')) return resp(users);
        const id = /\/users\/([^/]+)\/(factors|roles)$/.exec(u);
        if (!id) return resp([], 404);
        if (failing.has(id[1])) return resp({}, 500);
        return resp(id[2] === 'factors' ? [{ status: 'ACTIVE' }] : []);
    }) as unknown as typeof fetch;
}

const input: CheckInput = {
    automationKey: 'okta.mfa_enforced',
    parsed: { provider: 'okta', checkType: 'mfa_enforced', raw: 'okta.mfa_enforced' },
    tenantId: 't-1',
    connectionConfig: cfg,
    triggeredBy: 'manual',
};

it('every account enriched: the check may pass', async () => {
    const r = await new OktaProvider({ fetchImpl: oktaFetch(3) }).runCheck(input);
    expect(r.status).toBe('PASSED');
});

it('more accounts than the enrichment cap: a PASS becomes ERROR', async () => {
    const p = new OktaProvider({ fetchImpl: oktaFetch(2001) });
    expect((await p.listAccounts(cfg)).signalsComplete).toBe(false);
    const r = await p.runCheck(input);
    expect(r.status).toBe('ERROR');
    expect(r.details).toMatchObject({ signalsTruncated: true });
});

it('an account whose enrichment failed: a PASS becomes ERROR', async () => {
    const r = await new OktaProvider({ fetchImpl: oktaFetch(3, new Set(['u1'])) }).runCheck(input);
    expect(r.status).toBe('ERROR');
});

it('opting out of enrichment states nothing about it', async () => {
    const { signalsComplete } = await new OktaProvider({ fetchImpl: oktaFetch(3) }).listAccounts({ ...cfg, enrichPerUser: false });
    expect(signalsComplete).toBe(true);
});
