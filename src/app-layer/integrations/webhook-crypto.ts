/**
 * Integration Webhook — Signature Verification
 *
 * Generic HMAC-SHA256 verification for webhook payloads.
 * Each provider stores a webhook secret in their IntegrationConnection.
 * The secret is used to compute and verify signatures.
 *
 * Supports:
 *   - HMAC-SHA256 with hex or base64 encoding
 *   - Timing-safe comparison to prevent timing attacks
 *   - Provider-specific header resolution
 *
 * @module integrations/webhook-crypto
 */
import crypto from 'crypto';

/**
 * Compute HMAC-SHA256 signature of a payload.
 */
export function computeHmacSha256(
    payload: string,
    secret: string,
    encoding: 'hex' | 'base64' = 'hex'
): string {
    return crypto
        .createHmac('sha256', secret)
        .update(payload, 'utf8')
        .digest(encoding);
}

/**
 * Verify an HMAC-SHA256 signature with timing-safe comparison.
 *
 * @param payload   - The raw request body string
 * @param signature - The signature from the webhook header
 * @param secret    - The shared webhook secret
 * @param encoding  - How the signature is encoded ('hex' or 'base64')
 * @returns true if signature is valid
 */
export function verifyHmacSha256(
    payload: string,
    signature: string,
    secret: string,
    encoding: 'hex' | 'base64' = 'hex'
): boolean {
    if (!payload || !signature || !secret) return false;

    const expected = computeHmacSha256(payload, secret, encoding);

    // Signatures must be same length for timingSafeEqual
    const sigBuf = Buffer.from(signature, encoding === 'hex' ? 'hex' : 'base64');
    const expBuf = Buffer.from(expected, encoding === 'hex' ? 'hex' : 'base64');

    if (sigBuf.length !== expBuf.length) return false;

    try {
        return crypto.timingSafeEqual(sigBuf, expBuf);
    } catch {
        return false;
    }
}

/**
 * GitHub-style signature verification.
 * GitHub sends: `sha256=<hex>` in X-Hub-Signature-256 header.
 */
export function verifyGitHubSignature(
    payload: string,
    signatureHeader: string,
    secret: string
): boolean {
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
    const signature = signatureHeader.slice('sha256='.length);
    return verifyHmacSha256(payload, signature, secret, 'hex');
}

/**
 * Known provider signature header mappings.
 * Maps provider ID → header name used for the webhook signature.
 */
export const PROVIDER_SIGNATURE_HEADERS: Record<string, string> = {
    github: 'x-hub-signature-256',
    gitlab: 'x-gitlab-token',
    azure: 'x-azure-signature',
    aws: 'x-amz-sns-signature',
    // ServiceNow has no native webhook signing: a business rule composes the
    // outbound REST call by hand, so the header name is OURS to choose and the
    // customer's rule is configured to send it. Named for us rather than for
    // ServiceNow because it is a header this platform defined.
    servicenow: 'x-inflect-signature',
};

/**
 * Extract the signature value from request headers for a given provider.
 */
export function extractSignature(
    provider: string,
    headers: Record<string, string>
): string | null {
    // Check provider-specific header
    const headerName = PROVIDER_SIGNATURE_HEADERS[provider];
    if (headerName && headers[headerName]) {
        return headers[headerName];
    }
    // Fallback: generic header
    return headers['x-webhook-signature'] || headers['x-signature'] || null;
}
