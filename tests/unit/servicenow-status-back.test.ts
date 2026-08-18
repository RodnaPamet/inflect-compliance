/**
 * ServiceNow status-back callbacks: reachable, verified, and replay-proof.
 *
 * The three DONE conditions, each asserted against the REAL shared plumbing
 * rather than a ServiceNow-shaped copy of it — because most of what this
 * needed already existed and the risk was building a second path beside it.
 *
 *   reachable   the edge gate 401s every API request without a NextAuth
 *               cookie, and ServiceNow has none. The route must be on
 *               MACHINE_CALLER_PREFIXES or the callback never arrives.
 *   verified    …and every allowlist entry must authenticate itself, or the
 *               same entry that makes it reachable makes it anonymous.
 *   replay-proof a redelivered body must be a no-op.
 *
 * WHAT SERVICENOW ACTUALLY NEEDED was one line: a signature header name.
 * ServiceNow has no native webhook signing — a business rule composes the
 * outbound REST call by hand — so the header is OURS to define and the
 * customer's rule is configured to send it. Everything else (fail-closed on a
 * missing secret, tenant-scoped replay suppression, pre-auth forensic
 * persistence) is the shared processor, already hardened.
 */
import { MACHINE_CALLER_PREFIXES, isPublicPath } from '@/lib/auth/guard';
import { declarationOf } from '../helpers/source-blocks';
import { extractSignature, PROVIDER_SIGNATURE_HEADERS, verifyHmacSha256 } from '@/app-layer/integrations/webhook-crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the callback can arrive at all', () => {
    it('the webhook prefix is on the machine-caller allowlist', () => {
        // Without this the edge gate 401s ServiceNow's business rule before any
        // handler runs, and the failure looks like a ServiceNow configuration problem
        // rather than ours.
        expect(MACHINE_CALLER_PREFIXES).toContain('/api/integrations/webhooks');
        expect(isPublicPath('/api/integrations/webhooks/servicenow')).toBe(true);
    });

    it('being reachable does not make the tenant API reachable', () => {
        // The allowlist is the one place where a typo opens the product.
        expect(isPublicPath('/api/t/acme/risks')).toBe(false);
        expect(isPublicPath('/api/integrations/webhooks-admin')).toBe(false);
    });

    it('the route authenticates itself rather than relying on the edge', () => {
        // An allowlist entry whose handler does not authenticate is not a fix,
        // it is a hole — and the failure is silent in the direction that
        // matters, because the endpoint starts working.
        const src = codeOnly(
            fs.readFileSync(path.join(ROOT, 'src/app/api/integrations/webhooks/[provider]/route.ts'), 'utf8'),
        );
        expect(src).toMatch(/processIncomingWebhook\s*\(/);
    });
});

describe('an unsigned or wrongly-signed callback is rejected', () => {
    const SECRET = 'shared-secret';
    const BODY = JSON.stringify({ sys_id: 'INC1', state: '6' });

    function sign(body: string, secret: string): string {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const crypto = require('node:crypto') as typeof import('node:crypto');
        return crypto.createHmac('sha256', secret).update(body).digest('hex');
    }

    it('ServiceNow has a signature header registered', () => {
        // Without one, extractSignature falls through to the generic headers
        // and a business rule sending ours would not be found.
        expect(PROVIDER_SIGNATURE_HEADERS.servicenow).toBe('x-inflect-signature');
    });

    it('extracts the signature the business rule sends', () => {
        expect(extractSignature('servicenow', { 'x-inflect-signature': 'abc' })).toBe('abc');
    });

    it('returns null when the header is absent — no signature to check', () => {
        expect(extractSignature('servicenow', {})).toBeNull();
    });

    it('a correct HMAC over the RAW body verifies', () => {
        expect(verifyHmacSha256(BODY, sign(BODY, SECRET), SECRET, 'hex')).toBe(true);
    });

    it('a signature over a re-serialised body does NOT verify', () => {
        // The trap the shared processor documents: JSON.stringify(JSON.parse(x))
        // is not byte-identical to x — key order, float normalisation and
        // \uXXXX escapes all differ — so a verifier that rebuilds the body
        // produces failures that look like a wrong secret.
        const reserialised = JSON.stringify(JSON.parse(BODY));
        const spaced = `{ "sys_id": "INC1", "state": "6" }`;
        expect(verifyHmacSha256(spaced, sign(reserialised, SECRET), SECRET, 'hex')).toBe(false);
    });

    it('a signature made with the wrong secret does not verify', () => {
        expect(verifyHmacSha256(BODY, sign(BODY, 'other-secret'), SECRET, 'hex')).toBe(false);
    });

    it('a tampered body does not verify against its original signature', () => {
        const sig = sign(BODY, SECRET);
        expect(verifyHmacSha256(JSON.stringify({ sys_id: 'INC1', state: '7' }), sig, SECRET, 'hex')).toBe(false);
    });

    it('an empty signature does not verify', () => {
        expect(verifyHmacSha256(BODY, '', SECRET, 'hex')).toBe(false);
    });
});

describe('the replay defence is the shared one, and it is the hardened version', () => {
    const src = codeOnly(
        fs.readFileSync(path.join(ROOT, 'src/app-layer/usecases/webhook-processor.ts'), 'utf8'),
    );
    /**
     * BOUNDED TO THE SUPPRESSION QUERY, not the whole file.
     *
     * The first version of the `processed` assertion below searched the entire
     * module — and `status: 'processed'` appears three times in it, including
     * where the event is MARKED processed. So deleting the predicate from the
     * dedupe query left the test green: it was matching an unrelated line that
     * happens to say the same thing.
     *
     * That is the failure this file is otherwise about — a check that looks
     * like it pins a property and is satisfied by something else entirely.
     */
    const suppressionQuery = declarationOf(src, 'duplicateEvent');

    it('dedupes on payloadHash', () => {
        expect(suppressionQuery).toMatch(/payloadHash/);
    });

    it('the suppression lookup is SCOPED TO THE TENANT', () => {
        // Without the predicate, an identical body legitimately delivered to
        // tenant B is discarded because tenant A already received it.
        expect(suppressionQuery).toMatch(/tenantId:/);
    });

    it("only rows that reached 'processed' can suppress a delivery", () => {
        // The poisoning defence. Step 3 persists a `received` row BEFORE
        // authentication, deliberately, so a forged delivery stays forensically
        // visible — which means an attacker replaying an observed body could
        // otherwise plant a row that drops the genuine redelivery.
        expect(suppressionQuery).toMatch(/status:\s*'processed'/);
    });

    it('the suppression window is bounded, so a year-old row cannot drop a delivery', () => {
        expect(suppressionQuery).toMatch(/createdAt:/);
    });

    it('a connection with no configured secret is refused, not allowed', () => {
        // It returned verified:true with a comment conceding "in prod this
        // should be an error". One tenant leaving its secret unset made that
        // tenant the catch-all destination for any forged webhook.
        expect(src).toMatch(/verified:\s*false,\s*reason:\s*'no_secret_configured'/);
    });
});
