import { withValidatedBody } from '@/lib/validation/route';
import { EmptyBodySchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(withValidatedBody(EmptyBodySchema, async () => {
    const response = jsonResponse({ success: true });
    // The legacy `token` cookie is no longer minted or read (see
    // src/lib/auth.ts), so any outstanding one is already inert. This clear
    // stays for one more release purely to evict it from browsers that are
    // still carrying one — deleting the line would leave a dead credential
    // sitting in users' cookie jars for up to its 7-day life.
    response.cookies.set('token', '', { maxAge: 0, path: '/' });
    return response;
}));
