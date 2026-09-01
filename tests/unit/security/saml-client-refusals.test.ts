/**
 * Refusal-path tests for `src/lib/security/saml-client.ts`.
 *
 * This is the LIVE SAML service-provider path: it is reached from
 * `/api/auth/sso/saml/start` (AuthnRequest generation) and
 * `/api/auth/sso/saml/callback` (assertion validation). The existing
 * `tests/unit/saml-flow.test.ts` covers only the RelayState codec, so
 * every branch inside `buildSamlInstance` / `validateSamlResponse` /
 * `generateAuthnRequest` / `generateSpMetadata` — i.e. everything an
 * attacker actually exercises — was untested.
 *
 * The file deliberately mixes two styles:
 *
 *   - `buildSamlInstance` + `generateAuthnRequest` + `generateSpMetadata`
 *     run against the REAL `@node-saml/node-saml` SAML class, so the
 *     assertions describe what the IdP is actually told (entryPoint,
 *     idpIssuer, signing expectations) rather than what a mock was
 *     handed.
 *   - `validateSamlResponse` takes the SAML instance as a parameter, so
 *     it is driven with a narrowly typed stub. That lets us assert the
 *     SPECIFIC rejection for each malformed-profile shape without
 *     needing a signed assertion fixture (which would require a private
 *     key in the repo).
 */
import { SAML } from '@node-saml/node-saml';

import {
    buildSamlInstance,
    generateAuthnRequest,
    validateSamlResponse,
    generateSpMetadata,
} from '@/lib/security/saml-client';
import type { SamlConfig } from '@/app-layer/schemas/sso-config.schemas';

const CALLBACK_URL = 'https://app.example.com/api/auth/sso/saml/callback';
const SP_ISSUER = 'https://app.example.com/sp';

/**
 * A syntactically well-formed but throwaway base64 blob. `@node-saml`
 * only needs `idpCert` to be non-empty at CONSTRUCTION time; it is not
 * parsed until an assertion is verified, which none of the
 * construction-shape tests below reach.
 */
const FAKE_IDP_CERT = 'MIICzjCCAbagAwIBAgIJAKFakeCertForUnitTestsOnly';

function samlConfig(overrides: Partial<SamlConfig> = {}): SamlConfig {
    return {
        entityId: 'https://idp.example.com/entity',
        ssoUrl: 'https://idp.example.com/sso',
        certificate: FAKE_IDP_CERT,
        signRequests: false,
        ...overrides,
    };
}

/**
 * `validateSamlResponse` only ever calls `validatePostResponseAsync` on
 * the instance it is handed, so a one-method stub is a faithful double.
 * The cast is deliberate and narrow: `SAML` is a class with ~30 members
 * and constructing a real one would drag in XML-DSig verification we are
 * not testing here.
 */
type PostResponseResult = Awaited<ReturnType<SAML['validatePostResponseAsync']>>;

function stubSamlReturning(result: PostResponseResult): SAML {
    const validatePostResponseAsync = jest.fn(
        async (_container: Record<string, string>): Promise<PostResponseResult> => result,
    );
    return { validatePostResponseAsync } as unknown as SAML;
}

function stubSamlRejecting(err: Error): SAML {
    const validatePostResponseAsync = jest.fn(
        async (_container: Record<string, string>): Promise<PostResponseResult> => {
            throw err;
        },
    );
    return { validatePostResponseAsync } as unknown as SAML;
}

// ─── buildSamlInstance ───────────────────────────────────────────────

describe('buildSamlInstance', () => {
    it('REFUSES to build an instance for a config with no certificate', () => {
        // `config.certificate ?? ''` — the empty-string fallback is not a
        // permissive default. A SAML SP with no IdP certificate cannot
        // verify a single signature, so it must never reach the network.
        expect(() =>
            buildSamlInstance(
                samlConfig({ certificate: undefined }),
                CALLBACK_URL,
                SP_ISSUER,
            ),
        ).toThrow(/idpCert is required/i);
    });

    it('REFUSES to build an instance for a config whose certificate is empty', () => {
        expect(() =>
            buildSamlInstance(samlConfig({ certificate: '' }), CALLBACK_URL, SP_ISSUER),
        ).toThrow(/idpCert is required/i);
    });

    it('requires the authn RESPONSE to be signed', () => {
        const saml = buildSamlInstance(samlConfig(), CALLBACK_URL, SP_ISSUER);
        // If this ever flips to false, an attacker can POST an entirely
        // unsigned <Response> to the ACS and be logged in as anyone.
        expect(saml.options.wantAuthnResponseSigned).toBe(true);
    });

    it('points the SP at the tenant IdP and pins the expected issuer', () => {
        const saml = buildSamlInstance(
            samlConfig({
                ssoUrl: 'https://idp.example.com/sso',
                entityId: 'https://idp.example.com/entity',
            }),
            CALLBACK_URL,
            SP_ISSUER,
        );
        expect(saml.options.entryPoint).toBe('https://idp.example.com/sso');
        // idpIssuer is what makes an assertion minted by a DIFFERENT IdP
        // fail validation — an unexpected-issuer refusal.
        expect(saml.options.idpIssuer).toBe('https://idp.example.com/entity');
        expect(saml.options.callbackUrl).toBe(CALLBACK_URL);
        expect(saml.options.issuer).toBe(SP_ISSUER);
        expect(saml.options.idpCert).toBe(FAKE_IDP_CERT);
    });

    it('defaults nameIdFormat to emailAddress when the tenant did not set one', () => {
        const saml = buildSamlInstance(
            samlConfig({ nameIdFormat: undefined }),
            CALLBACK_URL,
            SP_ISSUER,
        );
        expect(saml.options.identifierFormat).toBe(
            'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        );
    });

    it('honours an explicit nameIdFormat instead of the default', () => {
        const persistent = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
        const saml = buildSamlInstance(
            samlConfig({ nameIdFormat: persistent }),
            CALLBACK_URL,
            SP_ISSUER,
        );
        expect(saml.options.identifierFormat).toBe(persistent);
    });

    it('pins SHA-256 for both signature and digest algorithms', () => {
        const saml = buildSamlInstance(samlConfig(), CALLBACK_URL, SP_ISSUER);
        expect(saml.options.signatureAlgorithm).toBe('sha256');
        expect(saml.options.digestAlgorithm).toBe('sha256');
    });

    it('builds a fresh instance per call — no shared state across tenants', () => {
        const a = buildSamlInstance(
            samlConfig({ ssoUrl: 'https://a.example.com/sso' }),
            CALLBACK_URL,
            SP_ISSUER,
        );
        const b = buildSamlInstance(
            samlConfig({ ssoUrl: 'https://b.example.com/sso' }),
            CALLBACK_URL,
            SP_ISSUER,
        );
        expect(a).not.toBe(b);
        expect(a.options.entryPoint).toBe('https://a.example.com/sso');
        expect(b.options.entryPoint).toBe('https://b.example.com/sso');
    });
});

// ─── generateAuthnRequest ────────────────────────────────────────────

describe('generateAuthnRequest', () => {
    it('redirects to the tenant IdP carrying the RelayState verbatim', async () => {
        const saml = buildSamlInstance(samlConfig(), CALLBACK_URL, SP_ISSUER);
        const url = await generateAuthnRequest(saml, 'relay-state-token-abc');

        const parsed = new URL(url);
        expect(parsed.origin + parsed.pathname).toBe('https://idp.example.com/sso');
        expect(parsed.searchParams.get('RelayState')).toBe('relay-state-token-abc');
        expect(parsed.searchParams.get('SAMLRequest')).toBeTruthy();
    });
});

// ─── validateSamlResponse — refusals ─────────────────────────────────

describe('validateSamlResponse — refusals', () => {
    it('REFUSES a validated response that carries no profile', async () => {
        const saml = stubSamlReturning({ profile: null, loggedOut: false });
        await expect(validateSamlResponse(saml, 'anything')).rejects.toThrow(
            'SAML response validation failed: no profile returned',
        );
    });

    it('REFUSES a profile with no NameID — there is no subject to sign in', async () => {
        const saml = stubSamlReturning({
            // NameID absent: the SP has no stable subject identifier, so
            // provisioning would have to invent one.
            profile: {
                issuer: 'https://idp.example.com/entity',
                nameID: '',
                nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
            },
            loggedOut: false,
        });
        await expect(validateSamlResponse(saml, 'anything')).rejects.toThrow(
            'SAML response missing NameID',
        );
    });

    it('propagates the library rejection unchanged (signature / XML failures)', async () => {
        const saml = stubSamlRejecting(new Error('Invalid signature'));
        await expect(validateSamlResponse(saml, 'anything')).rejects.toThrow(
            'Invalid signature',
        );
    });

    it('rejects a genuinely malformed POST body through the real validator', async () => {
        const saml = buildSamlInstance(samlConfig(), CALLBACK_URL, SP_ISSUER);
        // Not base64-decodable to XML at all — the very first thing an
        // attacker probing the ACS endpoint will send.
        await expect(
            validateSamlResponse(saml, 'this-is-not-a-saml-response'),
        ).rejects.toThrow(/Not a valid XML document/i);
    });
});

// ─── validateSamlResponse — profile extraction ───────────────────────

function profileWith(extra: Record<string, unknown>): PostResponseResult {
    return {
        profile: {
            issuer: 'https://idp.example.com/entity',
            nameID: 'subject-id-1',
            nameIDFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
            ...extra,
        },
        loggedOut: false,
    };
}

describe('validateSamlResponse — email extraction', () => {
    it('prefers the explicit email attribute and lowercases it', async () => {
        const saml = stubSamlReturning(profileWith({ email: 'Alice@ACME.com' }));
        const result = await validateSamlResponse(saml, 'x');
        expect(result.email).toBe('alice@acme.com');
    });

    it('falls back to the mail attribute when email is absent', async () => {
        const saml = stubSamlReturning(profileWith({ mail: 'BOB@Acme.COM' }));
        const result = await validateSamlResponse(saml, 'x');
        expect(result.email).toBe('bob@acme.com');
    });

    it('ignores a non-string email attribute (multi-valued SAML attribute)', async () => {
        // A SAML attribute with several values arrives as an array. Taking
        // it verbatim would put an array where a string is expected and
        // break downstream user lookup; the code must skip to `mail`.
        const saml = stubSamlReturning(
            profileWith({ email: ['a@acme.com', 'b@acme.com'], mail: 'Fallback@Acme.com' }),
        );
        const result = await validateSamlResponse(saml, 'x');
        expect(result.email).toBe('fallback@acme.com');
    });

    it('falls back to the NameID only when it looks like an email address', async () => {
        const saml = stubSamlReturning({
            profile: {
                issuer: 'https://idp.example.com/entity',
                nameID: 'Carol@ACME.com',
                nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
            },
            loggedOut: false,
        });
        const result = await validateSamlResponse(saml, 'x');
        expect(result.email).toBe('carol@acme.com');
    });

    it('returns email=null when nothing resolvable is present', async () => {
        // An opaque persistent NameID with no email attribute. Returning
        // the opaque id AS an email would create a user record keyed on a
        // non-address; null is the correct refusal to guess.
        const saml = stubSamlReturning(profileWith({}));
        const result = await validateSamlResponse(saml, 'x');
        expect(result.email).toBeNull();
        expect(result.nameId).toBe('subject-id-1');
    });
});

describe('validateSamlResponse — display name extraction', () => {
    it('prefers displayName verbatim (no case folding — it is a name)', async () => {
        const saml = stubSamlReturning(profileWith({ displayName: 'Alice Smith' }));
        expect((await validateSamlResponse(saml, 'x')).name).toBe('Alice Smith');
    });

    it('joins givenName + familyName when displayName is absent', async () => {
        const saml = stubSamlReturning(
            profileWith({ givenName: 'Alice', familyName: 'Smith' }),
        );
        expect((await validateSamlResponse(saml, 'x')).name).toBe('Alice Smith');
    });

    it('uses givenName alone when familyName is absent (no trailing space)', async () => {
        const saml = stubSamlReturning(profileWith({ givenName: 'Alice' }));
        expect((await validateSamlResponse(saml, 'x')).name).toBe('Alice');
    });

    it('uses familyName alone when givenName is absent (no leading space)', async () => {
        const saml = stubSamlReturning(profileWith({ familyName: 'Smith' }));
        expect((await validateSamlResponse(saml, 'x')).name).toBe('Smith');
    });

    it('ignores a non-string displayName and falls through to the name parts', async () => {
        const saml = stubSamlReturning(
            profileWith({ displayName: ['A', 'B'], givenName: 'Alice', familyName: 'Smith' }),
        );
        expect((await validateSamlResponse(saml, 'x')).name).toBe('Alice Smith');
    });

    it('returns name=null when no name attribute is present at all', async () => {
        const saml = stubSamlReturning(profileWith({}));
        expect((await validateSamlResponse(saml, 'x')).name).toBeNull();
    });
});

describe('validateSamlResponse — sessionIndex', () => {
    it('carries the sessionIndex through when the IdP sent one', async () => {
        const saml = stubSamlReturning({
            profile: {
                issuer: 'https://idp.example.com/entity',
                nameID: 'a@acme.com',
                nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
                sessionIndex: 'idx-42',
            },
            loggedOut: false,
        });
        expect((await validateSamlResponse(saml, 'x')).sessionIndex).toBe('idx-42');
    });

    it('normalises an absent sessionIndex to null, not undefined', async () => {
        const saml = stubSamlReturning({
            profile: {
                issuer: 'https://idp.example.com/entity',
                nameID: 'a@acme.com',
                nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
            },
            loggedOut: false,
        });
        const result = await validateSamlResponse(saml, 'x');
        // toStrictEqual, not toEqual — toEqual treats an `undefined`
        // property as absent and would pass either way.
        expect(result).toStrictEqual({
            nameId: 'a@acme.com',
            email: 'a@acme.com',
            name: null,
            sessionIndex: null,
        });
    });
});

// ─── generateSpMetadata ──────────────────────────────────────────────

describe('generateSpMetadata', () => {
    it('publishes the SP entity id and the ACS location the IdP must POST to', () => {
        const saml = buildSamlInstance(samlConfig(), CALLBACK_URL, SP_ISSUER);
        const xml = generateSpMetadata(saml);

        expect(xml).toContain(`entityID="${SP_ISSUER}"`);
        expect(xml).toContain(`Location="${CALLBACK_URL}"`);
        expect(xml).toContain(
            'Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"',
        );
    });

    it('does not advertise AuthnRequestsSigned when no signing key is configured', () => {
        // `buildSamlInstance` configures no privateKey, so the SP cannot
        // sign anything — the metadata must not claim otherwise or IdPs
        // will start rejecting our unsigned AuthnRequests.
        const saml = buildSamlInstance(samlConfig(), CALLBACK_URL, SP_ISSUER);
        expect(generateSpMetadata(saml)).toContain('AuthnRequestsSigned="false"');
    });
});

describe('validateSamlResponse — degenerate name attributes', () => {
    it('returns name=null when a name attribute is PRESENT but carries no values', async () => {
        // A multi-valued SAML attribute with zero values arrives as an
        // empty array, which is TRUTHY in JS — so the `profile.givenName ||
        // profile.familyName` guard admits it. Without the `|| null` at the
        // end of the join, the user record would get a blank display name
        // instead of an absent one.
        const saml = stubSamlReturning(profileWith({ givenName: [] }));
        expect((await validateSamlResponse(saml, 'x')).name).toBeNull();
    });
});

// ─── generateSpMetadata — decryption-cert argument ───────────────────
//
// `generateSpMetadata` is a two-line passthrough onto node-saml, and the
// only decision it makes is the `signingCert ?? ''` fallback. Asserting
// on the produced XML would test node-saml (which publishes a
// KeyDescriptor only when a private key is configured, and
// `buildSamlInstance` configures none); asserting on the forwarded
// arguments tests OUR branch.

describe('generateSpMetadata — certificate forwarding', () => {
    function stubMetadataSaml(): { saml: SAML; calls: unknown[][] } {
        const calls: unknown[][] = [];
        const generateServiceProviderMetadata = (
            decryptionCert: string | null,
            signingCert?: string | null,
        ): string => {
            calls.push([decryptionCert, signingCert]);
            return '<EntityDescriptor/>';
        };
        return { saml: { generateServiceProviderMetadata } as unknown as SAML, calls };
    }

    it('passes an EMPTY decryption cert when the tenant configured no signing key', () => {
        const { saml, calls } = stubMetadataSaml();
        expect(generateSpMetadata(saml)).toBe('<EntityDescriptor/>');
        // Empty string, never `undefined` — node-saml distinguishes them.
        expect(calls).toStrictEqual([['', undefined]]);
    });

    it('forwards a configured signing cert as BOTH decryption and signing cert', () => {
        const { saml, calls } = stubMetadataSaml();
        generateSpMetadata(saml, FAKE_IDP_CERT);
        expect(calls).toStrictEqual([[FAKE_IDP_CERT, FAKE_IDP_CERT]]);
    });
});
