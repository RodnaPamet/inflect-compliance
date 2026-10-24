/**
 * A SAML flow answers one callback, and the server holds that.
 *
 * `clearSsoFlow` asks the browser to drop the flow cookie, which binds nothing:
 * the sealed value stays valid until it expires, and a HAR export or a proxy
 * log carries the cookie and the SAMLResponse together. So the callback spends
 * the flow here before it reads the response: a second callback with the same
 * flow, from any browser, is refused.
 *
 * OIDC does not need this: its authorization code is single-use at the
 * identity provider, so a replayed callback fails the token exchange.
 *
 * Rows live in `VerificationToken` beside the hand-offs and email tokens,
 * apart by identifier prefix, and the hash covers the prefix. A spent flow is
 * kept only as long as the flow could have lived.
 */
import { createHash } from 'crypto';
import prisma from '@/lib/prisma';
import { SSO_FLOW_TTL_SECONDS } from '@/lib/auth/sso-flow';

const IDENTIFIER = 'sso-flow-spent:saml';

/** True the first time a flow is spent; false for every later attempt. */
export async function spendSsoFlowOnce(flowId: string): Promise<boolean> {
    const now = new Date();
    // Opportunistic cleanup of spent flows that could no longer be presented.
    await prisma.verificationToken.deleteMany({
        where: { identifier: IDENTIFIER, expires: { lt: now } },
    });
    try {
        await prisma.verificationToken.create({
            data: {
                identifier: IDENTIFIER,
                token: createHash('sha256').update(`${IDENTIFIER}:${flowId}`).digest('hex'),
                expires: new Date(now.getTime() + SSO_FLOW_TTL_SECONDS * 1000),
            },
        });
        return true;
    } catch (err) {
        if ((err as { code?: unknown } | null)?.code === 'P2002') return false;
        throw err;
    }
}
