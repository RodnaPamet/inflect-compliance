/**
 * `definitivelyNotApplied` is a claim of PROOF, and this file is what keeps it
 * honest.
 *
 * The flag tells the orchestrator it may settle a journal row FAILED — a
 * positive assertion that the customer's directory is unchanged. When that
 * assertion is wrong, the row lands under the one outcome BOTH readers exclude:
 * `findRestorableState` reads APPLIED/INDETERMINATE, `listUnsettledWrites` reads
 * PENDING/INDETERMINATE. The captured prior state becomes unreachable and no
 * operator is told to look.
 *
 * Two ways the writer got this wrong, both found by adversarial review and both
 * asserted here against the REAL classifier rather than a description of it:
 *
 *   1. The classifier ended in an unconditional `true`, so every status nobody
 *      had reasoned about inherited a claim of proof — 408 among them, which
 *      the contract names explicitly as a lost response.
 *   2. The retrying transport re-dispatched 5xx in-process and only the FINAL
 *      attempt was classified, so `502-then-401` reported proof while the 502
 *      attempt may well have landed.
 */
import { createEntraIdWriter } from '@/app-layer/integrations/providers/entra-id/writer';
import { DirectoryWriteError } from '@/app-layer/usecases/identity-disable-account';

const CONFIG = {
    tenantId: '11111111-1111-1111-1111-111111111111',
    clientId: '22222222-2222-2222-2222-222222222222',
    clientSecret: 'secret',
    writesEnabled: true,
};
const USER = '33333333-3333-3333-3333-333333333333';

/** A fetch that answers the token exchange, the read, then a scripted PATCH. */
function scripted(patchStatuses: number[]): typeof fetch {
    let patchN = 0;
    return (async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/oauth2/v2.0/token')) {
            // roles claim carrying the write role, so consent passes.
            const payload = Buffer.from(
                JSON.stringify({ roles: ['User.EnableDisableAccount.All'] }),
            ).toString('base64url');
            return new Response(
                JSON.stringify({ access_token: `h.${payload}.s`, expires_in: 3600 }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            );
        }
        if (init?.method === 'PATCH') {
            const s = patchStatuses[Math.min(patchN++, patchStatuses.length - 1)];
            return new Response(JSON.stringify({ error: { code: 'x', message: 'scripted' } }), {
                status: s,
                headers: { 'content-type': 'application/json' },
            });
        }
        return new Response(
            JSON.stringify({ id: USER, accountEnabled: true, onPremisesSyncEnabled: false }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
    }) as unknown as typeof fetch;
}

async function dnaFor(statuses: number[]): Promise<boolean | 'no-throw'> {
    const w = createEntraIdWriter(CONFIG, { fetchImpl: scripted(statuses) });
    const state = await w.readState(USER);
    try {
        await w.disable(USER, state);
        return 'no-throw';
    } catch (e) {
        return e instanceof DirectoryWriteError ? e.definitivelyNotApplied : false;
    }
}

describe('DEFECT 1 — proof is an allowlist, not a default', () => {
    it.each([408, 409, 423, 425, 449, 500, 502, 599])(
        'HTTP %i is NOT claimed as proven-unapplied',
        async (status) => {
            expect(await dnaFor([status])).toBe(false);
        },
    );

    it.each([400, 403, 404, 429])('HTTP %i IS proven-unapplied', async (status) => {
        expect(await dnaFor([status])).toBe(true);
    });
});

describe('DEFECT 2 — an ambiguous attempt cannot be hidden by a later one', () => {
    it('502-then-401 is not reported as proven', async () => {
        // The reported scenario: a gateway hiccup mid-batch, then an expired
        // token on the retry. Previously classified from the FINAL attempt
        // only, so it settled proven-unapplied while the 502 attempt may have
        // landed. The write transport now dispatches once, so a 502 IS the
        // outcome and nothing follows it.
        expect(await dnaFor([502, 401])).toBe(false);
    });

    it('504-then-403 is not reported as proven', async () => {
        expect(await dnaFor([504, 403])).toBe(false);
    });
});
