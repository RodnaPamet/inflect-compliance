/**
 * A throwaway SAML identity provider for tests: signs a whole Response with
 * the key in tests/fixtures/secrets/saml-test-idp/, the way the SAML client
 * requires, so nothing in node-saml or xml-crypto needs mocking.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SignedXml } from 'xml-crypto';

const FIXTURES = path.resolve(__dirname, '../fixtures/secrets/saml-test-idp');
export const TEST_IDP_KEY = fs.readFileSync(path.join(FIXTURES, 'key.pem'), 'utf8');
export const TEST_IDP_CERT = fs.readFileSync(path.join(FIXTURES, 'cert.pem'), 'utf8');

export const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
export const RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
export const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';
export const SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1';

export interface TestIdpResponse {
    callbackUrl: string;
    spIssuer: string;
    /** The flow's request ID, answered by the Response and its confirmation. */
    requestId: string;
    /** The Response's and the assertion's `<Issuer>`. */
    issuer: string;
    /** The assertion's `<Issuer>`, when it should differ from the Response's. */
    assertionIssuer?: string;
    signatureAlgorithm?: string;
    digestAlgorithm?: string;
    email?: string;
}

const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

/** A fresh, otherwise valid Response, signed as a whole, base64-encoded. */
export function signedTestIdpResponse(o: TestIdpResponse): string {
    const email = o.email ?? 'alice@acme.com';
    const now = at(0);
    const xml =
        `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"` +
        ` ID="_resp1" Version="2.0" IssueInstant="${now}" Destination="${o.callbackUrl}" InResponseTo="${o.requestId}">` +
        `<saml:Issuer>${o.issuer}</saml:Issuer>` +
        `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
        `<saml:Assertion ID="_assert1" Version="2.0" IssueInstant="${now}">` +
        `<saml:Issuer>${o.assertionIssuer ?? o.issuer}</saml:Issuer>` +
        `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID>` +
        `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
        `<saml:SubjectConfirmationData NotOnOrAfter="${at(5 * 60_000)}" Recipient="${o.callbackUrl}" InResponseTo="${o.requestId}"/>` +
        `</saml:SubjectConfirmation></saml:Subject>` +
        `<saml:Conditions NotBefore="${at(-60_000)}" NotOnOrAfter="${at(5 * 60_000)}">` +
        `<saml:AudienceRestriction><saml:Audience>${o.spIssuer}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
        `<saml:AuthnStatement AuthnInstant="${now}" SessionIndex="_s1"><saml:AuthnContext>` +
        `<saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef>` +
        `</saml:AuthnContext></saml:AuthnStatement>` +
        `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` +
        `</saml:Assertion></samlp:Response>`;

    const signer = new SignedXml({ privateKey: TEST_IDP_KEY, publicCert: TEST_IDP_CERT });
    signer.signatureAlgorithm = o.signatureAlgorithm ?? RSA_SHA256;
    signer.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#';
    const root = "/*[local-name(.)='Response']";
    signer.addReference({
        xpath: root,
        transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
        digestAlgorithm: o.digestAlgorithm ?? SHA256,
    });
    signer.computeSignature(xml, { location: { reference: `${root}/*[local-name(.)='Issuer']`, action: 'after' } });
    return Buffer.from(signer.getSignedXml()).toString('base64');
}
