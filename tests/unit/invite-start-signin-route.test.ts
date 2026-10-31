/**
 * GET /api/invites/:token/start-signin (#4689).
 *
 * It stores the token in an HttpOnly cookie and sends the person to sign in.
 * After sign-in they must land on /invite/result, which says what became of
 * the invite — the sign-in callback that redeems it can only log a refusal.
 * The destination must not carry the token: the cookie is where it lives.
 */
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/invites/[token]/start-signin/route';

describe('/api/invites/:token/start-signin', () => {
    it('sets the invite cookie and sends sign-in on to /invite/result, with no token in the URL', async () => {
        const req = new NextRequest('http://localhost:3000/api/invites/tok-abc/start-signin');

        const res = await GET(req, { params: Promise.resolve({ token: 'tok-abc' }) });

        expect(res.status).toBe(307);
        const location = new URL(res.headers.get('location') ?? '');
        expect(location.pathname).toBe('/login');
        expect(location.searchParams.get('callbackUrl')).toBe('/invite/result');
        expect(location.toString()).not.toContain('tok-abc');

        const setCookie = res.headers.get('set-cookie') ?? '';
        expect(setCookie).toContain('inflect_invite_token=tok-abc');
        expect(setCookie.toLowerCase()).toContain('httponly');
    });
});
