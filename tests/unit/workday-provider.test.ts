/**
 * WorkdayProvider — fail-closed conduct, and the two seams it exists to hold.
 *
 * Workday is the first SYNC-ONLY provider (`supportedChecks` is empty), so its
 * fail-closed surface is not a check engine. Everything a monitoring product
 * must never do — report a green signal it has not earned — has to be proven
 * on the sync path instead, plus on the unreachable runCheck, which is worth
 * pinning precisely BECAUSE nothing routes to it: the only way it ever runs is
 * a future caller that bypassed the routing, and an obliging default there
 * would hand that caller a PASSED for a control nobody evaluated.
 */
import { WorkdayProvider } from '@/app-layer/integrations/providers/workday';
import type { readWorkdayRoster } from '@/app-layer/integrations/providers/workday/roster';
import type { resolveWorkdayAccessToken, WorkdaySecret } from '@/app-layer/integrations/providers/workday/token';

/**
 * Typed doubles.
 *
 * `jest.fn(async () => …)` infers a ZERO-length parameter tuple, so
 * `mock.calls[0][0]` is a compile error and the assertions that matter — which
 * secret the token resolver was handed, which cursor the roster read got —
 * cannot be written at all. Typing the double as the real function is what
 * makes those arguments inspectable.
 */
const tokenFn = (impl: typeof resolveWorkdayAccessToken) =>
    jest.fn<ReturnType<typeof resolveWorkdayAccessToken>, Parameters<typeof resolveWorkdayAccessToken>>(impl);
const rosterFn = (impl: typeof readWorkdayRoster) =>
    jest.fn<ReturnType<typeof readWorkdayRoster>, Parameters<typeof readWorkdayRoster>>(impl);

const GOOD = {
    host: 'wd2-impl-services1.workday.com',
    tenant: 'acme_preview',
    reportPath: '/ccx/service/customreport2/acme/ISU/Roster',
    clientId: 'cid',
    clientSecret: 'csecret',
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: 9_999_999_999,
};

const okToken = tokenFn(async (s: WorkdaySecret) => ({ accessToken: s.accessToken || 'fresh', rotated: null }));

describe('runCheck never manufactures a signal', () => {
    it('ERRORs — it does not answer PASSED for a check it never ran', async () => {
        const r = await new WorkdayProvider().runCheck();
        expect(r.status).toBe('ERROR');
        expect(r.status).not.toBe('PASSED');
    });

    it('and NOT_APPLICABLE is also wrong here — that reads as "assessed, does not apply"', async () => {
        expect((await new WorkdayProvider().runCheck()).status).not.toBe('NOT_APPLICABLE');
    });

    it('produces no evidence, so nothing downstream can cite the non-check', async () => {
        expect(new WorkdayProvider().mapResultToEvidence()).toBeNull();
    });
});

describe('the sync path fails closed', () => {
    it('a dead credential propagates as a throw — the sync turns it into ERROR', async () => {
        // The provider must NOT swallow this into an empty roster. An empty
        // roster that reported complete would be the mass-terminate path.
        const p = new WorkdayProvider({
            resolveToken: tokenFn(async () => { throw new Error('Workday token refresh failed: 400'); }),
        });
        await expect(p.listEmployees(GOOD)).rejects.toThrow('400');
    });

    it('refuses BEFORE any request when the connection is incomplete', async () => {
        const readRoster = rosterFn(async () => ({ employees: [], complete: true, resumeToken: null }));
        const resolveToken = tokenFn(async () => ({ accessToken: 'x', rotated: null }));
        const p = new WorkdayProvider({ readRoster, resolveToken });
        await expect(p.listEmployees({ ...GOOD, reportPath: '' })).rejects.toThrow(/incomplete/i);
        expect(resolveToken).not.toHaveBeenCalled();
        expect(readRoster).not.toHaveBeenCalled();
    });

    it('refuses before any request when consent has not happened', async () => {
        const resolveToken = tokenFn(async () => ({ accessToken: 'x', rotated: null }));
        const p = new WorkdayProvider({ resolveToken });
        await expect(p.listEmployees({ ...GOOD, refreshToken: '' })).rejects.toThrow(/not authorised/i);
        expect(resolveToken).not.toHaveBeenCalled();
    });

    it('carries the roster read’s incompleteness through unchanged', async () => {
        // The provider must not "helpfully" round a partial roster up to
        // complete — that is the flag the departure reconcile keys on.
        const p = new WorkdayProvider({
            resolveToken: okToken,
            readRoster: rosterFn(async () => ({ employees: [], complete: false, resumeToken: '500' })),
        });
        const r = await p.listEmployees(GOOD);
        expect(r.complete).toBe(false);
        expect(r.resumeToken).toBe('500');
    });

    it('passes the resume cursor down rather than restarting the pass', async () => {
        const readRoster = rosterFn(async () => ({ employees: [], complete: true, resumeToken: null }));
        await new WorkdayProvider({ resolveToken: okToken, readRoster }).listEmployees(GOOD, '1500');
        expect(readRoster.mock.calls[0][2]).toBe('1500');
    });
});

describe('a rotated refresh token is persisted at rotation', () => {
    it('hands the new pair to persistSecret, not to the caller on return', async () => {
        // Without this the connection dies two runs later: rotation invalidates
        // the predecessor, so a discarded new token leaves the stored one dead
        // while THAT run still reports PASSED.
        const rotated = { accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: 123 };
        const p = new WorkdayProvider({
            resolveToken: tokenFn(async (_s, _o, deps) => {
                await deps?.persist?.(rotated);
                return { accessToken: rotated.accessToken, rotated };
            }),
            readRoster: rosterFn(async () => ({ employees: [], complete: true, resumeToken: null })),
        });
        const persistSecret = jest.fn(async () => {});
        await p.listEmployees(GOOD, null, { persistSecret });
        expect(persistSecret).toHaveBeenCalledWith(rotated);
    });

    it('persists even when the roster read throws AFTERWARDS', async () => {
        // The ordering is the whole point of a callback over a return value.
        const rotated = { accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: 123 };
        const persistSecret = jest.fn(async () => {});
        const p = new WorkdayProvider({
            resolveToken: tokenFn(async (_s, _o, deps) => {
                await deps?.persist?.(rotated);
                return { accessToken: rotated.accessToken, rotated };
            }),
            readRoster: rosterFn(async () => { throw new Error('roster 503'); }),
        });
        await expect(p.listEmployees(GOOD, null, { persistSecret })).rejects.toThrow('503');
        expect(persistSecret).toHaveBeenCalledWith(rotated);
    });

    it('an absent expiresAt forces a refresh rather than sending an unknown-age token', async () => {
        const resolveToken = tokenFn(async () => ({ accessToken: 'x', rotated: null }));
        const p = new WorkdayProvider({
            resolveToken,
            readRoster: rosterFn(async () => ({ employees: [], complete: true, resumeToken: null })),
        });
        const { expiresAt: _drop, ...noExpiry } = GOOD;
        await p.listEmployees(noExpiry);
        expect(resolveToken.mock.calls[0][0].expiresAt).toBe(0);
    });
});

describe('validateConnection makes a real call', () => {
    it('liveValidation is true — a shape-only Test button proves nothing here', () => {
        expect(new WorkdayProvider().liveValidation).toBe(true);
    });

    it('rejects a bad credential instead of reporting connected', async () => {
        const p = new WorkdayProvider({
            resolveToken: tokenFn(async () => { throw new Error('401 invalid_client'); }),
        });
        const r = await p.validateConnection(GOOD, {});
        expect(r.valid).toBe(false);
        expect(r.error).toMatch(/invalid_client/);
    });

    it('probes with expiresAt 0 so a revoked grant cannot pass on a cached token', async () => {
        const resolveToken = tokenFn(async () => ({ accessToken: 'x', rotated: null }));
        await new WorkdayProvider({ resolveToken }).validateConnection(GOOD, {});
        expect(resolveToken.mock.calls[0][0].expiresAt).toBe(0);
    });

    it('refuses an off-domain host WITHOUT making the call that would leak the secret', async () => {
        const resolveToken = tokenFn(async () => ({ accessToken: 'x', rotated: null }));
        const r = await new WorkdayProvider({ resolveToken })
            .validateConnection({ ...GOOD, host: 'workday.com.attacker.net' }, {});
        expect(r.valid).toBe(false);
        expect(resolveToken).not.toHaveBeenCalled();
    });

    it('names every missing field at once rather than one save at a time', async () => {
        const r = await new WorkdayProvider().validateConnection({ host: GOOD.host }, {});
        expect(r.valid).toBe(false);
        for (const f of ['tenant', 'reportPath', 'clientId', 'clientSecret']) {
            expect(r.error).toContain(f);
        }
    });

    it('says "not yet authorised" pre-consent instead of reporting a failure', async () => {
        const r = await new WorkdayProvider().validateConnection(GOOD, { refreshToken: '' });
        expect(r.valid).toBe(false);
        expect(r.error).toMatch(/not yet authorised/i);
    });

    it('accepts a working connection', async () => {
        const p = new WorkdayProvider({ resolveToken: okToken });
        expect((await p.validateConnection(GOOD, {})).valid).toBe(true);
    });
});

describe('the client secret is a secret field', () => {
    it('clientSecret is in secretFields, never configFields', () => {
        // configJson is stored as plaintext JSON and rendered back into a
        // visible input. One word in the wrong half persists a live OAuth2
        // client secret in the clear.
        const schema = new WorkdayProvider().configSchema;
        expect(schema.secretFields?.map((f) => f.key)).toContain('clientSecret');
        expect(schema.configFields?.map((f) => f.key)).not.toContain('clientSecret');
    });
});
