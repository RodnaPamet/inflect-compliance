import { randomBytes } from 'crypto';
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from '@node-saml/node-saml';
import type { SamlConfig } from '@/app-layer/schemas/sso-config.schemas';
import { SSO_FLOW_TTL_SECONDS } from '@/lib/auth/sso-flow';

/**
 * SAML 2.0 Client for tenant-scoped enterprise SSO.
 *
 * Architecture choice: @node-saml/node-saml
 *
 * Rationale:
 * - Most mature and actively maintained SAML library for Node.js
 * - Handles AuthnRequest generation, response parsing, XML-DSig validation
 * - Used under the hood by passport-saml, but usable standalone
 * - No dependency on Express/passport — fits Next.js App Router cleanly
 * - Dynamic per-request configuration (essential for multi-tenant)
 *
 * Alternative considered: saml-jackson (BoxyHQ)
 * - Overkill for this use case — it's a full SAML proxy/service
 * - Adds unnecessary infrastructure complexity
 * - We only need client-side SP functionality
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface SamlAuthRequest {
    /** URL to redirect the user to (IdP's SSO endpoint with SAMLRequest) */
    redirectUrl: string;
    /** RelayState value for round-trip context */
    relayState: string;
}

export interface SamlValidatedResponse {
    /** SAML NameID (unique subject identifier) */
    nameId: string;
    /** Email address from attributes or NameID */
    email: string | null;
    /** Display name from attributes */
    name: string | null;
    /** Raw SAML profile for debugging */
    sessionIndex: string | null;
}

export interface SamlRelayState {
    tenantSlug: string;
    providerId: string;
    returnTo?: string;
    /** The AuthnRequest this flow sent, which the response must answer. */
    request: SamlRequestBinding;
}

/**
 * The AuthnRequest a flow sent: its ID, and when it was issued.
 *
 * Kept in the sealed flow (src/lib/auth/sso-flow.ts), so a response is good
 * only in the browser whose request it answers. Without it, any validly signed
 * response for this provider was accepted from any browser that could start a
 * flow of its own, which a script can: a SAMLResponse captured in a support
 * ticket's HAR, a proxy log or an extension signed its subject in elsewhere.
 */
export interface SamlRequestBinding {
    id: string;
    /** ISO timestamp. */
    issuedAt: string;
}

/** A fresh request binding for `/start`. An xs:ID may not start with a digit. */
export function newSamlRequestBinding(now: Date = new Date()): SamlRequestBinding {
    return { id: `_${randomBytes(20).toString('hex')}`, issuedAt: now.toISOString() };
}

/** The oldest an assertion may be on arrival, counted from its IssueInstant. */
export const SAML_MAX_ASSERTION_AGE_MS = 5 * 60 * 1000;

// ─── RelayState Encoding ─────────────────────────────────────────────

export function encodeSamlRelayState(payload: SamlRelayState): string {
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeSamlRelayState(relayState: string): SamlRelayState | null {
    try {
        const json = Buffer.from(relayState, 'base64url').toString('utf8');
        const parsed = JSON.parse(json);
        if (!parsed.tenantSlug || !parsed.providerId) return null;
        // A flow sealed before request binding existed has none, and is refused:
        // the person starts again, at most ten minutes after a deploy.
        if (typeof parsed.request?.id !== 'string' || typeof parsed.request?.issuedAt !== 'string') return null;
        return parsed as SamlRelayState;
    } catch {
        return null;
    }
}

// ─── SAML Instance Builder ──────────────────────────────────────────

/**
 * A request cache that knows one request: the one this flow sent.
 *
 * node-saml checks `InResponseTo` against its cache. Its default is an
 * in-process map, which a second container, or a restart between `/start` and
 * the callback, does not share; the sealed flow already carries the request,
 * so the cache reads from that instead.
 */
function boundRequestCache(request: SamlRequestBinding): CacheProvider {
    return {
        saveAsync: async (key, value) =>
            key === request.id ? { value, createdAt: Date.parse(request.issuedAt) } : null,
        getAsync: async (key) => (key === request.id ? request.issuedAt : null),
        removeAsync: async () => null,
    };
}

/**
 * Build a SAML instance configured for a specific tenant's IdP and for one
 * flow's request (`request`): `/start` sends that request's ID, and the
 * callback accepts only a response that answers it.
 * Creates a new instance per request (no shared state — critical for multi-tenant).
 */
export function buildSamlInstance(
    config: SamlConfig,
    callbackUrl: string,
    issuer: string,
    request: SamlRequestBinding,
): SAML {
    const samlOptions: ConstructorParameters<typeof SAML>[0] = {
        callbackUrl,
        issuer,
        // IdP configuration
        entryPoint: config.ssoUrl,
        idpIssuer: config.entityId,
        idpCert: config.certificate ?? '',
        // Request signing
        wantAuthnResponseSigned: true,
        wantAssertionsSigned: false,
        // NameID format
        identifierFormat: config.nameIdFormat
            ?? 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        // Signature
        signatureAlgorithm: 'sha256',
        digestAlgorithm: 'sha256',
        // Disable request signing by default (most enterprise IdPs don't require it)
        authnRequestBinding: 'HTTP-Redirect',
        // The response must answer this flow's request, on the Response and on
        // its subject confirmation, within the flow's lifetime. 'always' is also
        // what makes node-saml check the confirmation's time window at all.
        generateUniqueId: () => request.id,
        validateInResponseTo: ValidateInResponseTo.always,
        cacheProvider: boundRequestCache(request),
        requestIdExpirationPeriodMs: SSO_FLOW_TTL_SECONDS * 1000,
        maxAssertionAgeMs: SAML_MAX_ASSERTION_AGE_MS,
    };

    return new SAML(samlOptions);
}

/**
 * Generate a SAML AuthnRequest and return the redirect URL.
 */
export async function generateAuthnRequest(
    saml: SAML,
    relayState: string
): Promise<string> {
    const url = await saml.getAuthorizeUrlAsync(relayState, undefined, {});
    return url;
}

const BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';

type XmlNode = { $?: Record<string, string | undefined> };

/**
 * An xml2js node's children of one name. node-saml strips namespace prefixes;
 * the document root is a single object, every element below it an array.
 */
function childrenOf(node: unknown, name: string): XmlNode[] {
    const value = node && typeof node === 'object' ? (node as Record<string, unknown>)[name] : undefined;
    if (Array.isArray(value)) return value as XmlNode[];
    return value && typeof value === 'object' ? [value as XmlNode] : [];
}

/**
 * Whether the assertion carries a bearer confirmation for THIS request at THIS
 * callback (SAML Profiles §4.1.4.2): `Recipient` names the callback, a
 * `NotOnOrAfter` is present and still ahead, and `InResponseTo` is the flow's
 * request.
 *
 * node-saml does not check `Recipient` at all, and checks a confirmation's time
 * window only for the one it picks, so a confirmation with no expiry, or an
 * assertion with no confirmation, passed it. The assertion is the one node-saml
 * read from the verified bytes.
 */
function hasBearerConfirmationFor(
    profile: Profile,
    expected: { callbackUrl: string; requestId: string },
    nowMs: number,
): boolean {
    const [assertion] = childrenOf(profile.getAssertion?.(), 'Assertion');
    const [subject] = childrenOf(assertion, 'Subject');
    return childrenOf(subject, 'SubjectConfirmation').some((confirmation) => {
        if (confirmation.$?.Method !== BEARER) return false;
        const data = childrenOf(confirmation, 'SubjectConfirmationData')[0]?.$;
        const notOnOrAfter = Date.parse(data?.NotOnOrAfter ?? '');
        return (
            data?.Recipient === expected.callbackUrl &&
            data.InResponseTo === expected.requestId &&
            Number.isFinite(notOnOrAfter) &&
            nowMs < notOnOrAfter
        );
    });
}

/**
 * Validate a SAML response (POST to ACS) and extract the authenticated profile.
 * `expected` is this callback's URL and the request the flow sent.
 */
export async function validateSamlResponse(
    saml: SAML,
    samlResponseBody: string,
    expected: { callbackUrl: string; requestId: string },
): Promise<SamlValidatedResponse> {
    const { profile } = await saml.validatePostResponseAsync({
        SAMLResponse: samlResponseBody,
    } as Record<string, string>);

    if (!profile) {
        throw new Error('SAML response validation failed: no profile returned');
    }

    if (!hasBearerConfirmationFor(profile, expected, Date.now())) {
        throw new Error('SAML assertion has no bearer confirmation for this request at this callback');
    }

    // Extract NameID — this is the primary subject identifier
    const nameId = profile.nameID;
    if (!nameId) {
        throw new Error('SAML response missing NameID');
    }

    // Extract email: prefer explicit attribute, fall back to NameID if it looks like an email
    let email: string | null = null;
    if (profile.email && typeof profile.email === 'string') {
        email = profile.email.toLowerCase();
    } else if (
        typeof profile.mail === 'string'
    ) {
        email = (profile.mail as string).toLowerCase();
    } else if (nameId.includes('@')) {
        email = nameId.toLowerCase();
    }

    // Extract display name
    let name: string | null = null;
    if (profile.displayName && typeof profile.displayName === 'string') {
        name = profile.displayName;
    } else if (profile.givenName || profile.familyName) {
        const parts = [profile.givenName, profile.familyName].filter(Boolean);
        name = parts.join(' ') || null;
    }

    return {
        nameId,
        email,
        name,
        sessionIndex: profile.sessionIndex ?? null,
    };
}

/**
 * Generate SP metadata XML for the tenant's SAML configuration.
 * Useful for automated IdP configuration via metadata exchange.
 */
export function generateSpMetadata(
    saml: SAML,
    signingCert?: string
): string {
    const decryptionCert = signingCert ?? '';
    return saml.generateServiceProviderMetadata(decryptionCert, signingCert);
}
