/**
 * #3323 — the grant endpoint's credential check. This file is the security
 * boundary's only test, so it is written against the ways it could be wrong
 * rather than the way it is meant to work.
 *
 * THE FOUR THAT CARRY WEIGHT
 * ──────────────────────────
 *   1. A SECRET CONTAINING A DOT IS NOT TRUNCATED. The token is
 *      `<connectionId>.<secret>` and the secret is everything after the FIRST
 *      dot. A `split('.')` implementation silently shortens any secret with a
 *      dot in it, and then compares the shortened half — which succeeds for an
 *      attacker who knows the prefix. The id is the first field; the secret is
 *      the remainder.
 *   2. A DECRYPT FAILURE IS NOT A MISMATCH. Reporting it as one tells an
 *      operator their token is wrong when their KEY is wrong, which sends them
 *      to rotate the thing that works.
 *   3. ATTRIBUTABILITY IS PART OF THE REFUSAL. Whether an audit row is possible
 *      is decided here, not at the route, because only this function knows
 *      whether a tenant was identified. Each refusal's flag is asserted.
 *   4. A WRONG SECRET AND A WRONG LENGTH BOTH FAIL. `timingSafeEqual` throws on
 *      unequal-length buffers, so a naive implementation either crashes or
 *      returns early — and an early return is a length oracle.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { functionBodyOf } from '../helpers/source-blocks';

const findUniqueMock = jest.fn();
jest.mock('@/lib/prisma', () => ({
    prisma: { integrationConnection: { findUnique: (a: unknown) => findUniqueMock(a) } },
}));

const decryptMock = jest.fn((v: string) => v);
jest.mock('@/lib/security/encryption', () => ({
    decryptField: (v: string) => decryptMock(v),
}));

import {
    authenticateGrantCaller,
    describeGrantAuthRefusal,
    MCP_SERVER_PROVIDER,
    type GrantAuthRefusal,
} from '@/app-layer/usecases/entra-grant-auth';

const CONN = 'ckz1abc234def';
/** The value the comparison is made AGAINST, so the test can present a wrong one. */
const SECRET = 'a-long-random-secret-value'; // pragma: allowlist secret -- test fixture

const row = (over: Record<string, unknown> = {}) => ({
    id: CONN,
    tenantId: 'tenant-A',
    name: 'Grant endpoint',
    provider: MCP_SERVER_PROVIDER,
    isEnabled: true,
    secretEncrypted: JSON.stringify({ authorization: `${CONN}.${SECRET}` }),
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    decryptMock.mockImplementation((v: string) => v);
});

// ═════════════════════════════════════════════════════════════════════
// 1. THE HAPPY PATH AND THE TENANT IT YIELDS
// ═════════════════════════════════════════════════════════════════════

describe('a valid token resolves the tenant from the connection row', () => {
    it('accepts the right secret and returns the tenant — the control', async () => {
        findUniqueMock.mockResolvedValue(row());
        const r = await authenticateGrantCaller(`Bearer ${CONN}.${SECRET}`);
        expect(r.ok).toBe(true);
        expect(r.ok && r.tenantId).toBe('tenant-A');
        expect(r.ok && r.connectionId).toBe(CONN);
    });

    it('looks the connection up by PRIMARY KEY, with no caller-shaped filter', async () => {
        // The read must not be widenable. An id lookup cannot enumerate.
        findUniqueMock.mockResolvedValue(row());
        await authenticateGrantCaller(`Bearer ${CONN}.${SECRET}`);
        expect(findUniqueMock.mock.calls[0][0]).toMatchObject({ where: { id: CONN } });
    });

    it('tolerates a stored value that carries its own `Bearer ` prefix', async () => {
        // An operator pasting the whole header value is the obvious mistake and
        // costs nothing to absorb.
        findUniqueMock.mockResolvedValue(
            row({ secretEncrypted: JSON.stringify({ authorization: `Bearer ${CONN}.${SECRET}` }) }),
        );
        const r = await authenticateGrantCaller(`Bearer ${CONN}.${SECRET}`);
        expect(r.ok).toBe(true);
    });

    it('accepts a lowercase `bearer` scheme', async () => {
        findUniqueMock.mockResolvedValue(row());
        const r = await authenticateGrantCaller(`bearer ${CONN}.${SECRET}`);
        expect(r.ok).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. THE DOT — the one that silently weakens the secret
// ═════════════════════════════════════════════════════════════════════

describe('the secret is everything after the FIRST dot', () => {
    const DOTTED = 'secret.with.dots.in.it';

    it('a secret containing dots is matched in full, not truncated', async () => {
        // A `split('.')` implementation would compare only `secret` here and
        // accept a caller who knew nothing but the prefix.
        findUniqueMock.mockResolvedValue(
            row({ secretEncrypted: JSON.stringify({ authorization: `${CONN}.${DOTTED}` }) }),
        );
        const r = await authenticateGrantCaller(`Bearer ${CONN}.${DOTTED}`);
        expect(r.ok).toBe(true);
    });

    it('and a PREFIX of a dotted secret is refused', async () => {
        // The paired assertion. Without it, "matched in full" would also pass
        // for an implementation that matched nothing at all.
        findUniqueMock.mockResolvedValue(
            row({ secretEncrypted: JSON.stringify({ authorization: `${CONN}.${DOTTED}` }) }),
        );
        const r = await authenticateGrantCaller(`Bearer ${CONN}.secret`);
        expect(r.ok).toBe(false);
        expect(!r.ok && r.refusal.kind).toBe('secret_mismatch');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. THE REFUSALS, AND WHETHER EACH CAN BE AUDITED
// ═════════════════════════════════════════════════════════════════════

describe('every refusal names itself and declares whether it can be attributed', () => {
    it('no header at all', async () => {
        const r = await authenticateGrantCaller(null);
        expect(!r.ok && r.refusal).toEqual({ kind: 'no_credential', attributable: false });
        // Nothing was looked up — a missing credential costs no query.
        expect(findUniqueMock).not.toHaveBeenCalled();
    });

    it.each([
        ['not a Bearer scheme', 'Basic abc.def'],
        ['no dot', 'Bearer justonevalue'],
        ['a leading dot (empty id)', 'Bearer .secret'],
        ['a trailing dot (empty secret)', 'Bearer connid.'],
    ])('%s is malformed and unattributable', async (_label, header) => {
        const r = await authenticateGrantCaller(header);
        expect(!r.ok && r.refusal.kind).toBe('malformed');
        expect(!r.ok && r.refusal.attributable).toBe(false);
        expect(findUniqueMock).not.toHaveBeenCalled();
    });

    it('an unknown connection id is unattributable — no tenant was identified', async () => {
        findUniqueMock.mockResolvedValue(null);
        const r = await authenticateGrantCaller(`Bearer ${CONN}.${SECRET}`);
        expect(!r.ok && r.refusal).toEqual({ kind: 'unknown_connection', attributable: false });
    });

    it('a non-MCP connection is refused AND attributable', async () => {
        findUniqueMock.mockResolvedValue(row({ provider: 'entra-id' }));
        const r = await authenticateGrantCaller(`Bearer ${CONN}.${SECRET}`);
        expect(!r.ok && r.refusal.kind).toBe('wrong_provider');
        expect(!r.ok && r.refusal.attributable).toBe(true);
        expect(!r.ok && (r.refusal as { tenantId: string }).tenantId).toBe('tenant-A');
    });

    it('a disabled connection is refused even with the right secret', async () => {
        // An operator turning a connection off must stop writes through it; the
        // token still exists and must stop working.
        findUniqueMock.mockResolvedValue(row({ isEnabled: false }));
        const r = await authenticateGrantCaller(`Bearer ${CONN}.${SECRET}`);
        expect(!r.ok && r.refusal.kind).toBe('disabled');
        expect(!r.ok && r.refusal.attributable).toBe(true);
    });

    it('a connection with no stored secret is refused, not matched against empty', async () => {
        findUniqueMock.mockResolvedValue(row({ secretEncrypted: null }));
        const r = await authenticateGrantCaller(`Bearer ${CONN}.${SECRET}`);
        expect(!r.ok && r.refusal.kind).toBe('no_stored_token');
    });

    it('an empty authorization field is refused, and an empty PRESENTED secret does not match it', async () => {
        findUniqueMock.mockResolvedValue(
            row({ secretEncrypted: JSON.stringify({ authorization: '' }) }),
        );
        const r = await authenticateGrantCaller(`Bearer ${CONN}.anything`);
        expect(!r.ok && r.refusal.kind).toBe('no_stored_token');
    });

    it('a DECRYPT FAILURE is reported as a missing token, never as a mismatch', async () => {
        // The load-bearing distinction. "Your token is wrong" sends an operator
        // to rotate the credential; the broken thing is the key.
        findUniqueMock.mockResolvedValue(row());
        decryptMock.mockImplementation(() => {
            throw new Error('bad auth tag');
        });
        const r = await authenticateGrantCaller(`Bearer ${CONN}.${SECRET}`);
        expect(!r.ok && r.refusal.kind).toBe('no_stored_token');
        expect(!r.ok && r.refusal.kind).not.toBe('secret_mismatch');
    });

    it('a wrong secret is a mismatch, and is attributable', async () => {
        findUniqueMock.mockResolvedValue(row());
        const r = await authenticateGrantCaller(`Bearer ${CONN}.wrong-secret-entirely`);
        expect(!r.ok && r.refusal.kind).toBe('secret_mismatch');
        expect(!r.ok && r.refusal.attributable).toBe(true);
    });

    it.each([
        ['shorter than the stored secret', 'a'],
        ['longer than the stored secret', `${SECRET}-plus-more`],
        ['the empty string', ''],
    ])('a secret %s is refused without throwing', async (_label, presented) => {
        // `timingSafeEqual` throws on unequal lengths, so a naive compare either
        // crashes or returns early — and an early return is a length oracle.
        findUniqueMock.mockResolvedValue(row());
        const r = await authenticateGrantCaller(`Bearer ${CONN}.${presented}`);
        expect(r.ok).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3b. THE ONE PROPERTY THIS FILE CANNOT TEST BY BEHAVIOUR
// ═════════════════════════════════════════════════════════════════════

describe('the comparison is constant-time — asserted by MECHANISM, not by behaviour', () => {
    it('the implementation uses timingSafeEqual and does not return early on length', () => {
        // STATED AS PRESENCE, because that is all this is.
        //
        // Every behavioural test above passes for a plain `===`. Timing is not
        // measurable in a unit test — this repo already deleted a wall-clock
        // budget whose verdict straddled its ceiling across eight samples — so
        // there is no assertion that distinguishes a constant-time compare from
        // a short-circuiting one by observing results.
        //
        // So this checks the mechanism is there and makes no claim that it is
        // correct. It is exactly the presence-not-effect shape #3312 is an audit
        // for, kept deliberately because the alternative is no check at all, and
        // labelled so nobody later reads it as proof of the property.
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/app-layer/usecases/entra-grant-auth.ts'),
            'utf-8',
        );
        const body = functionBodyOf(src, 'constantTimeMatch');
        expect(body).toMatch(/timingSafeEqual\(/);

        // The LENGTH-MISMATCH branch must corrupt a byte rather than return,
        // because an early return there is a length oracle. Asserted on that
        // branch specifically — an earlier attempt forbade ANY early return and
        // failed on the legitimate `expected.length === 0` guard, which is about
        // the STORED secret being absent and tells a caller nothing.
        //
        // Bounded deliberately: the first version put an unbounded `[\s\S]*`
        // between two pieces of pattern, which is the Class C span this repo
        // ratchets against — it would have re-formed across any sibling
        // statement. `declarationOf`-style narrowing is the fix, so the needle
        // runs over the branch and not the function.
        const lengthBranch = /if \(provided\.length !== expected\.length\) \{([^}]*)\}/.exec(body);
        expect(lengthBranch).not.toBeNull();
        expect(lengthBranch![1]).toMatch(/\^ 0xff/);
        expect(lengthBranch![1]).not.toMatch(/return/);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. THE SENTENCES
// ═════════════════════════════════════════════════════════════════════

describe('describeGrantAuthRefusal — every kind, distinct, and leaking nothing', () => {
    const ALL: readonly GrantAuthRefusal[] = [
        { kind: 'no_credential', attributable: false },
        { kind: 'malformed', attributable: false },
        { kind: 'unknown_connection', attributable: false },
        { kind: 'wrong_provider', attributable: true, tenantId: 't' },
        { kind: 'disabled', attributable: true, tenantId: 't' },
        { kind: 'no_stored_token', attributable: true, tenantId: 't' },
        { kind: 'secret_mismatch', attributable: true, tenantId: 't' },
    ];

    it('covers all seven kinds with no empty string', () => {
        // The `never` arm makes an unhandled kind a compile error; this proves
        // no handled kind returns nothing.
        for (const r of ALL) {
            expect(describeGrantAuthRefusal(r).length).toBeGreaterThan(10);
        }
    });

    it('every sentence is DISTINCT — a collapse would make the union pointless', () => {
        const texts = ALL.map(describeGrantAuthRefusal);
        expect(new Set(texts).size).toBe(ALL.length);
    });

    it('no sentence mentions a secret, a token value, or a length', () => {
        // These reach a caller over the wire on a 401.
        for (const r of ALL) {
            const t = describeGrantAuthRefusal(r);
            expect(t).not.toMatch(/\d{2,}/); // no lengths or counts
            expect(t.toLowerCase()).not.toContain('secret value');
        }
    });

    it('distinguishes "no token" from "wrong token" from "disabled"', () => {
        // An operator must be able to tell these apart; they are three
        // different things to go and fix.
        const a = describeGrantAuthRefusal({ kind: 'no_credential', attributable: false });
        const b = describeGrantAuthRefusal({ kind: 'secret_mismatch', attributable: true, tenantId: 't' });
        const c = describeGrantAuthRefusal({ kind: 'disabled', attributable: true, tenantId: 't' });
        expect(new Set([a, b, c]).size).toBe(3);
    });
});

// ═════════════════════════════════════════════════════════════════════
// OAUTH SHADOWS THE STATIC SECRET (#3340)
// ═════════════════════════════════════════════════════════════════════

/**
 * The failure these cover is invisible from both ends, which is why it is
 * worth its own refusal kind rather than folding into `secret_mismatch`.
 *
 * `authorizationFor` takes its OAuth branch if ANY of four fields is set and
 * then never reads `secrets.authorization`. So the dispatch sends a minted
 * access token while this function compares the stored static value. Both
 * sides are behaving correctly, the audit trail records AUTHZ_DENIED, and
 * nothing names the cause — so every grant through that connection fails
 * permanently and the only way to diagnose it is to know the precedence rule
 * exists.
 *
 * Each of the four fields gets its own case ON PURPOSE. Two of them live on
 * `configJson` and two are secrets, and a check that read only the secrets
 * would pass three of these tests while missing the shape the one real
 * production connection actually had.
 */
describe('a connection configured for OAuth cannot be authenticated by its static secret', () => {
    const CORRECT = `Bearer ${CONN}.${SECRET}`;

    it.each([
        ['config.tenantId', { configJson: { tenantId: 'a-tenant-guid' } }],
        ['config.clientId', { configJson: { clientId: 'an-app-guid' } }],
        [
            'secrets.clientSecret',
            {
                secretEncrypted: JSON.stringify({
                    authorization: `${CONN}.${SECRET}`,
                    clientSecret: 'a-client-secret', // pragma: allowlist secret -- test fixture
                }),
            },
        ],
        [
            'secrets.refreshToken',
            {
                secretEncrypted: JSON.stringify({
                    authorization: `${CONN}.${SECRET}`,
                    refreshToken: 'a-refresh-token', // pragma: allowlist secret -- test fixture
                }),
            },
        ],
    ])('refuses oauth_shadows_static when %s is set', async (_label, over) => {
        findUniqueMock.mockResolvedValue(row(over));
        const result = await authenticateGrantCaller(CORRECT);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        // NOT `secret_mismatch`: the presented credential is the correct one
        // for the stored value, and reporting a mismatch would send an
        // operator to check a secret that is right.
        expect(result.refusal.kind).toBe('oauth_shadows_static');
    });

    it('still accepts when all four OAuth fields are absent — the control', async () => {
        findUniqueMock.mockResolvedValue(row({ configJson: { url: 'https://example.test/mcp' } }));
        const result = await authenticateGrantCaller(CORRECT);
        expect(result.ok).toBe(true);
    });

    it('treats an empty-string OAuth field as absent, not as configured', async () => {
        // An integrations form that submits every field posts '' for the ones
        // left blank. Treating those as "configured" would refuse every
        // static-secret connection saved through that form.
        findUniqueMock.mockResolvedValue(
            row({ configJson: { tenantId: '', clientId: '   ' } }),
        );
        const result = await authenticateGrantCaller(CORRECT);
        expect(result.ok).toBe(true);
    });

    it('is attributable, so the route can write the AUTHZ_DENIED row', async () => {
        findUniqueMock.mockResolvedValue(row({ configJson: { tenantId: 'a-tenant-guid' } }));
        const result = await authenticateGrantCaller(CORRECT);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.refusal.attributable).toBe(true);
        expect(result.refusal).toMatchObject({ tenantId: 'tenant-A' });
    });

    it('takes precedence over a wrong secret, because it is the more useful answer', async () => {
        // With both problems present, "your secret is wrong" is true and
        // useless — fixing the secret changes nothing while the OAuth fields
        // remain.
        findUniqueMock.mockResolvedValue(row({ configJson: { tenantId: 'a-tenant-guid' } }));
        const result = await authenticateGrantCaller(`Bearer ${CONN}.not-the-stored-secret`);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.refusal.kind).toBe('oauth_shadows_static');
    });

    it('explains the cause without naming either credential', () => {
        const sentence = describeGrantAuthRefusal({
            kind: 'oauth_shadows_static',
            attributable: true,
            tenantId: 'tenant-A',
        } satisfies GrantAuthRefusal);
        expect(sentence).toMatch(/OAuth/);
        expect(sentence).toMatch(/Remove/i);
        expect(sentence).not.toContain(SECRET);
    });
});

