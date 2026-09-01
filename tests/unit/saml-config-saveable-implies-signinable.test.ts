/**
 * A SAML provider that SAVES must be one that can START a sign-in.
 *
 * BEHAVIOURAL. `SamlConfigSchema` used to accept a metadataUrl-only
 * provider (`metadataUrl || (entityId && ssoUrl && certificate)`). Nothing
 * in this codebase fetches or parses IdP metadata XML, so that config
 * saved with a success message and then threw `configurationError` at
 * sign-in — `/api/auth/sso/saml/start` refuses any config missing
 * `ssoUrl` or `entityId`. The admin got a green tick and a provider that
 * could never work.
 *
 * The invariant tested here is the one that was broken, stated as a
 * property rather than a shape: for EVERY candidate config, "the save
 * boundary accepts it" must imply "the sign-in boundary can use it".
 *
 * `UpsertSsoConfigInput.parse(body)` is the literal call the save route
 * makes (`src/app/api/t/[tenantSlug]/sso/route.ts`), so parsing it here
 * exercises the real save-time gate. The flat `/api/sso` twin that used to
 * make the same call was deleted in #2196.
 */
import {
    SamlConfigSchema,
    UpsertSsoConfigInput,
} from '@/app-layer/schemas/sso-config.schemas';

/** The metadata-only config that used to save and then fail at sign-in. */
const METADATA_ONLY = {
    metadataUrl: 'https://idp.example.com/saml/metadata',
};

/** A config the SAML client can actually build an AuthnRequest from. */
const COMPLETE = {
    entityId: 'https://idp.example.com',
    ssoUrl: 'https://idp.example.com/sso',
    certificate: 'MIICzjCCAb...',
};

/**
 * The precondition `/api/auth/sso/saml/start` enforces on a stored config
 * before it will build a SAML instance. Mirrors the route's own check:
 *
 *   if (!samlConfig.ssoUrl || !samlConfig.entityId) throw configurationError(...)
 *
 * `buildSamlInstance` additionally needs the signing certificate to
 * validate the IdP's response, so it is part of "usable" too.
 */
function canStartSignIn(config: Record<string, unknown>): boolean {
    return Boolean(config.ssoUrl) && Boolean(config.entityId) && Boolean(config.certificate);
}

describe('a metadata-only SAML provider is rejected AT SAVE', () => {
    it('the save boundary refuses it', () => {
        const result = UpsertSsoConfigInput.safeParse({
            name: 'Okta',
            type: 'SAML',
            config: METADATA_ONLY,
        });
        expect(result.success).toBe(false);
    });

    it('the refusal names the missing fields and says why metadata is not enough', () => {
        const result = UpsertSsoConfigInput.safeParse({
            name: 'Okta',
            type: 'SAML',
            config: METADATA_ONLY,
        });
        expect(result.success).toBe(false);
        if (result.success) return;

        const messages = result.error.issues.map((i) => i.message).join(' | ');
        expect(messages).toMatch(/metadata URL alone is not enough/i);
        for (const field of ['entityId', 'ssoUrl', 'certificate']) {
            expect(messages).toContain(field);
        }
    });

    it('the issues are attached under `config.<field>` so a form can highlight them', () => {
        const result = UpsertSsoConfigInput.safeParse({
            name: 'Okta',
            type: 'SAML',
            config: METADATA_ONLY,
        });
        expect(result.success).toBe(false);
        if (result.success) return;

        const paths = result.error.issues.map((i) => i.path.join('.'));
        expect(paths).toEqual(expect.arrayContaining([
            'config.entityId',
            'config.ssoUrl',
            'config.certificate',
        ]));
    });

    it('a complete config still saves — the tightening is not a blanket refusal', () => {
        const result = UpsertSsoConfigInput.safeParse({
            name: 'Okta',
            type: 'SAML',
            config: COMPLETE,
        });
        expect(result.success).toBe(true);
    });

    it('metadataUrl is still accepted ALONGSIDE the manual fields (reference value)', () => {
        const result = SamlConfigSchema.safeParse({ ...COMPLETE, ...METADATA_ONLY });
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.metadataUrl).toBe(METADATA_ONLY.metadataUrl);
    });
});

describe('property: anything the save boundary accepts, the sign-in boundary can use', () => {
    const CANDIDATES: Array<[string, Record<string, unknown>]> = [
        ['empty', {}],
        ['metadataUrl only', METADATA_ONLY],
        ['metadataUrl + sloUrl + nameIdFormat', {
            ...METADATA_ONLY,
            sloUrl: 'https://idp.example.com/slo',
            nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
        }],
        ['entityId only', { entityId: COMPLETE.entityId }],
        ['entityId + ssoUrl, no certificate', {
            entityId: COMPLETE.entityId,
            ssoUrl: COMPLETE.ssoUrl,
        }],
        ['entityId + certificate, no ssoUrl', {
            entityId: COMPLETE.entityId,
            certificate: COMPLETE.certificate,
        }],
        ['metadataUrl + entityId + ssoUrl, no certificate', {
            ...METADATA_ONLY,
            entityId: COMPLETE.entityId,
            ssoUrl: COMPLETE.ssoUrl,
        }],
        ['complete', COMPLETE],
        ['complete + metadataUrl', { ...COMPLETE, ...METADATA_ONLY }],
        ['complete + every optional', {
            ...COMPLETE,
            ...METADATA_ONLY,
            sloUrl: 'https://idp.example.com/slo',
            nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
            signRequests: true,
        }],
    ];

    it.each(CANDIDATES)('%s', (_label, config) => {
        const saved = UpsertSsoConfigInput.safeParse({ name: 'IdP', type: 'SAML', config });
        if (!saved.success) return; // refused at save — nothing to promise
        // Accepted at save ⇒ the sign-in route must not refuse it as
        // "SAML configuration incomplete".
        expect(canStartSignIn(config)).toBe(true);
    });

    it('the property is not vacuous — at least one candidate does save', () => {
        const accepted = CANDIDATES.filter(([, config]) =>
            UpsertSsoConfigInput.safeParse({ name: 'IdP', type: 'SAML', config }).success,
        );
        expect(accepted.length).toBeGreaterThan(0);
    });
});
