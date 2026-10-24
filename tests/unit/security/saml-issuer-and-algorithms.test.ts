/**
 * A SAML assertion is accepted only from the configured identity provider, and
 * only when signed with SHA-256 or stronger.
 *
 * Two gaps, both in what node-saml 5 leaves to its caller:
 *   - `idpIssuer` is read only for logout messages. An assertion naming any
 *     issuer passed, as long as the configured certificate signed it, which
 *     matters wherever one signing certificate serves several entities.
 *   - `signatureAlgorithm: 'sha256'` governs what the SP signs. Verification
 *     takes the algorithm the response names, and xml-crypto accepts RSA-SHA1
 *     and a SHA-1 digest.
 *
 * Nothing in node-saml or xml-crypto is mocked (tests/helpers/saml-test-idp.ts).
 */
import {
    buildSamlInstance,
    newSamlRequestBinding,
    validateSamlResponse,
    type SamlRequestBinding,
} from '@/lib/security/saml-client';
import { emailDomainForLog } from '@/lib/security/sso-logging';
import type { SamlConfig } from '@/app-layer/schemas/sso-config.schemas';
import {
    RSA_SHA1,
    SHA1,
    TEST_IDP_CERT,
    signedTestIdpResponse,
    type TestIdpResponse,
} from '../../helpers/saml-test-idp';

const CALLBACK = 'https://app.example.com/api/auth/sso/saml/callback';
const SP_ISSUER = 'https://app.example.com/saml/metadata/acme';
const IDP_ENTITY = 'https://idp.example.com/entity';

const config = { entityId: IDP_ENTITY, ssoUrl: 'https://idp.example.com/sso', certificate: TEST_IDP_CERT } as SamlConfig;

let request: SamlRequestBinding;
beforeEach(() => {
    request = newSamlRequestBinding();
});

function respond(o: Partial<TestIdpResponse> = {}): string {
    return signedTestIdpResponse({ callbackUrl: CALLBACK, spIssuer: SP_ISSUER, requestId: request.id, issuer: IDP_ENTITY, ...o });
}

function validate(body: string) {
    const saml = buildSamlInstance(config, CALLBACK, SP_ISSUER, request);
    return validateSamlResponse(saml, body, { callbackUrl: CALLBACK, requestId: request.id });
}

/** Re-encode a response after editing its XML text. Its signature no longer matters to the check under test. */
function edited(body: string, edit: (xml: string) => string): string {
    return Buffer.from(edit(Buffer.from(body, 'base64').toString('utf8'))).toString('base64');
}

describe('the assertion must come from the configured identity provider', () => {
    it('accepts an assertion from the configured entity', async () => {
        await expect(validate(respond())).resolves.toMatchObject({ email: 'alice@acme.com' });
    });

    it('refuses an assertion another entity issued, though the configured certificate signed it', async () => {
        await expect(validate(respond({ issuer: 'https://other-idp.example.com/entity' }))).rejects.toThrow(
            /unexpected identity provider/,
        );
    });

    it("judges the assertion's issuer, not only the Response's", async () => {
        await expect(validate(respond({ assertionIssuer: 'https://other-idp.example.com/entity' }))).rejects.toThrow(
            /unexpected identity provider/,
        );
    });
});

describe('the response must be signed with SHA-256 or stronger', () => {
    it('refuses an RSA-SHA1 signature', async () => {
        await expect(validate(respond({ signatureAlgorithm: RSA_SHA1 }))).rejects.toThrow(/refused SignatureMethod/);
    });

    it('refuses a SHA-1 digest under an RSA-SHA256 signature', async () => {
        await expect(validate(respond({ digestAlgorithm: SHA1 }))).rejects.toThrow(/refused DigestMethod/);
    });

    it('refuses a declaration it cannot read literally, rather than guessing', async () => {
        const body = edited(respond(), (xml) => xml.replace('xmldsig-more#rsa-sha256', 'xmldsig-more&#x23;rsa-sha256'));
        await expect(validate(body)).rejects.toThrow(/refused SignatureMethod/);
    });

    it('refuses a response that names no algorithm at all', async () => {
        const body = edited(respond(), (xml) => xml.replace(/<(?:ds:)?SignatureMethod[^>]*\/>/, ''));
        await expect(validate(body)).rejects.toThrow(/names no signature or digest algorithm/);
    });

    it('refuses a document type declaration, through which markup could hide from the check', async () => {
        const body = edited(respond(), (xml) => `<!DOCTYPE Response [<!ENTITY x "y">]>${xml}`);
        await expect(validate(body)).rejects.toThrow(/document type declaration/);
    });
});

describe('a rejected SSO link logs the email domain, never the address', () => {
    it('keeps the domain', () => {
        expect(emailDomainForLog('Alice.Smith@Acme.COM')).toBe('acme.com');
    });

    it('has nothing to keep without an address', () => {
        expect(emailDomainForLog(null)).toBeNull();
        expect(emailDomainForLog('no-at-sign')).toBeNull();
    });
});
