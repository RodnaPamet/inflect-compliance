/**
 * A SAML response is accepted only as the answer to this flow's request, at
 * this callback, while it is fresh.
 *
 * The client never set `validateInResponseTo`, and node-saml defaults it to
 * `never`. So a validly signed response was accepted whatever request it
 * answered, or none at all. Anyone holding a captured SAMLResponse (from a HAR
 * attached to a support ticket, a TLS-inspecting proxy, an extension) could
 * start a flow of their own with a script and post it, and be signed in as its
 * subject. The confirmation's `Recipient` was never checked. Its
 * `NotOnOrAfter` went unchecked too, because node-saml checks the
 * confirmation's time window only under `validateInResponseTo`.
 *
 * Now `/start` chooses the AuthnRequest's ID and seals it into the flow, and
 * the callback requires:
 *   - `InResponseTo` on the Response, matching that ID;
 *   - a bearer confirmation that names this callback, answers the request and
 *     is still unexpired;
 *   - an assertion issued within `SAML_MAX_ASSERTION_AGE_MS`.
 *
 * Nothing in node-saml or xml-crypto is mocked. The responses are signed with
 * a throwaway key in tests/fixtures/secrets/saml-test-idp/.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { SignedXml } from 'xml-crypto';
import {
    SAML_MAX_ASSERTION_AGE_MS,
    buildSamlInstance,
    decodeSamlRelayState,
    encodeSamlRelayState,
    generateAuthnRequest,
    newSamlRequestBinding,
    validateSamlResponse,
    type SamlRequestBinding,
} from '@/lib/security/saml-client';
import type { SamlConfig } from '@/app-layer/schemas/sso-config.schemas';

const FIXTURES = path.resolve(__dirname, '../../fixtures/secrets/saml-test-idp');
const KEY = fs.readFileSync(path.join(FIXTURES, 'key.pem'), 'utf8');
const CERT = fs.readFileSync(path.join(FIXTURES, 'cert.pem'), 'utf8');

const BASE = 'https://app.example.com';
const CALLBACK = `${BASE}/api/auth/sso/saml/callback`;
const SP_ISSUER = `${BASE}/saml/metadata/acme`;
const IDP_ENTITY = 'https://idp.example.com/entity';

const config: SamlConfig = {
    entityId: IDP_ENTITY,
    ssoUrl: 'https://idp.example.com/sso',
    certificate: CERT,
} as SamlConfig;

const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

interface ResponseOptions {
    /** Response@InResponseTo; `null` leaves it out. */
    inResponseTo?: string | null;
    /** SubjectConfirmationData@InResponseTo; defaults to `inResponseTo`. */
    confirmationInResponseTo?: string | null;
    recipient?: string;
    /** SubjectConfirmationData@NotOnOrAfter; `null` leaves it out. */
    confirmationNotOnOrAfter?: string | null;
    method?: string;
    /** Leaves out the SubjectConfirmation altogether. */
    noConfirmation?: boolean;
    issueInstant?: string;
}

/** A Response signed as a whole, the way the client requires. */
function signedResponse(o: ResponseOptions): string {
    const inResponseTo = o.inResponseTo === undefined ? 'unset' : o.inResponseTo;
    const confirmationInResponseTo =
        o.confirmationInResponseTo === undefined ? inResponseTo : o.confirmationInResponseTo;
    const issueInstant = o.issueInstant ?? at(0);
    const attr = (name: string, value: string | null) => (value === null ? '' : ` ${name}="${value}"`);
    const confirmation = o.noConfirmation
        ? ''
        : `<saml:SubjectConfirmation Method="${o.method ?? 'urn:oasis:names:tc:SAML:2.0:cm:bearer'}">` +
          `<saml:SubjectConfirmationData${attr('NotOnOrAfter', o.confirmationNotOnOrAfter === undefined ? at(5 * 60_000) : o.confirmationNotOnOrAfter)}` +
          `${attr('Recipient', o.recipient ?? CALLBACK)}${attr('InResponseTo', confirmationInResponseTo)}/>` +
          `</saml:SubjectConfirmation>`;
    const xml =
        `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"` +
        ` ID="_resp1" Version="2.0" IssueInstant="${issueInstant}" Destination="${CALLBACK}"${attr('InResponseTo', inResponseTo)}>` +
        `<saml:Issuer>${IDP_ENTITY}</saml:Issuer>` +
        `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
        `<saml:Assertion ID="_assert1" Version="2.0" IssueInstant="${issueInstant}">` +
        `<saml:Issuer>${IDP_ENTITY}</saml:Issuer>` +
        `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">alice@acme.com</saml:NameID>${confirmation}</saml:Subject>` +
        `<saml:Conditions NotBefore="${at(-60_000)}" NotOnOrAfter="${at(5 * 60_000)}">` +
        `<saml:AudienceRestriction><saml:Audience>${SP_ISSUER}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
        `<saml:AuthnStatement AuthnInstant="${issueInstant}" SessionIndex="_s1"><saml:AuthnContext>` +
        `<saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef>` +
        `</saml:AuthnContext></saml:AuthnStatement>` +
        `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>alice@acme.com</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` +
        `</saml:Assertion></samlp:Response>`;

    const signer = new SignedXml({ privateKey: KEY, publicCert: CERT });
    signer.signatureAlgorithm = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
    signer.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#';
    const root = "/*[local-name(.)='Response']";
    signer.addReference({
        xpath: root,
        transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
        digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    });
    signer.computeSignature(xml, { location: { reference: `${root}/*[local-name(.)='Issuer']`, action: 'after' } });
    return Buffer.from(signer.getSignedXml()).toString('base64');
}

function validate(request: SamlRequestBinding, body: string) {
    const saml = buildSamlInstance(config, CALLBACK, SP_ISSUER, request);
    return validateSamlResponse(saml, body, { callbackUrl: CALLBACK, requestId: request.id });
}

describe('SAML responses are bound to the request this flow sent', () => {
    let request: SamlRequestBinding;
    beforeEach(() => {
        request = newSamlRequestBinding();
    });

    it("accepts a fresh response that answers this flow's request at this callback", async () => {
        await expect(validate(request, signedResponse({ inResponseTo: request.id }))).resolves.toMatchObject({
            nameId: 'alice@acme.com',
            email: 'alice@acme.com',
        });
    });

    it('refuses a response that answers a different request: a captured response posted into a new flow', async () => {
        const other = newSamlRequestBinding();
        await expect(validate(request, signedResponse({ inResponseTo: other.id }))).rejects.toThrow(/InResponseTo/);
    });

    it('refuses an unsolicited response, with no InResponseTo at all', async () => {
        await expect(
            validate(request, signedResponse({ inResponseTo: null, confirmationInResponseTo: null })),
        ).rejects.toThrow(/InResponseTo/);
    });

    it('refuses a response whose confirmation answers another request', async () => {
        await expect(
            validate(request, signedResponse({ inResponseTo: request.id, confirmationInResponseTo: '_other' })),
        ).rejects.toThrow();
    });

    it('refuses a response for this request once the flow has outlived its lifetime', async () => {
        const stale = { ...request, issuedAt: new Date(Date.now() - 11 * 60_000).toISOString() };
        await expect(validate(stale, signedResponse({ inResponseTo: stale.id }))).rejects.toThrow();
    });
});

describe('the bearer confirmation must name this callback and still be live', () => {
    let request: SamlRequestBinding;
    beforeEach(() => {
        request = newSamlRequestBinding();
    });

    it('refuses a confirmation addressed to another service provider', async () => {
        await expect(
            validate(request, signedResponse({ inResponseTo: request.id, recipient: 'https://other-sp.example/acs' })),
        ).rejects.toThrow(/bearer confirmation/);
    });

    it('refuses a confirmation that expired', async () => {
        await expect(
            validate(request, signedResponse({ inResponseTo: request.id, confirmationNotOnOrAfter: at(-60 * 60_000) })),
        ).rejects.toThrow();
    });

    it('refuses a confirmation with no expiry, which would never expire', async () => {
        // node-saml refuses this one first, now that an assertion has a maximum
        // age; the client's own bearer check would refuse it too.
        await expect(
            validate(request, signedResponse({ inResponseTo: request.id, confirmationNotOnOrAfter: null })),
        ).rejects.toThrow();
    });

    it('refuses an assertion with no subject confirmation', async () => {
        await expect(
            validate(request, signedResponse({ inResponseTo: request.id, noConfirmation: true })),
        ).rejects.toThrow(/bearer confirmation/);
    });

    it('refuses a confirmation that is not bearer', async () => {
        await expect(
            validate(
                request,
                signedResponse({ inResponseTo: request.id, method: 'urn:oasis:names:tc:SAML:2.0:cm:holder-of-key' }),
            ),
        ).rejects.toThrow(/bearer confirmation/);
    });

    it('refuses an assertion issued longer ago than the maximum age', async () => {
        const issueInstant = new Date(Date.now() - SAML_MAX_ASSERTION_AGE_MS - 60_000).toISOString();
        await expect(validate(request, signedResponse({ inResponseTo: request.id, issueInstant }))).rejects.toThrow();
    });
});

describe('/start sends the request the flow will expect', () => {
    it("puts the flow's request ID on the AuthnRequest", async () => {
        const request = newSamlRequestBinding();
        const url = new URL(await generateAuthnRequest(buildSamlInstance(config, CALLBACK, SP_ISSUER, request), 'flow-1'));
        const xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest') ?? '', 'base64')).toString('utf8');
        expect(xml).toContain(`ID="${request.id}"`);
        expect(url.searchParams.get('RelayState')).toBe('flow-1');
    });

    it('seals the request into the relay state, and refuses relay state that carries none', () => {
        const request = newSamlRequestBinding();
        const sealed = encodeSamlRelayState({ tenantSlug: 'acme', providerId: 'p1', request });
        expect(decodeSamlRelayState(sealed)?.request).toEqual(request);

        const legacy = Buffer.from(JSON.stringify({ tenantSlug: 'acme', providerId: 'p1' })).toString('base64url');
        expect(decodeSamlRelayState(legacy)).toBeNull();
    });
});
