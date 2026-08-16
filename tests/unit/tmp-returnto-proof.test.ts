import { encodeState, decodeState } from '@/lib/security/oidc-client';
import { encodeSamlRelayState, decodeSamlRelayState } from '@/lib/security/saml-client';

describe('returnTo round-trip proof', () => {
    it('OIDC: attacker returnTo survives encode->decode and escapes origin', () => {
        const s = encodeState({
            tenantSlug: 'acme', providerId: 'p1',
            codeVerifier: 'v', nonce: 'n',
            returnTo: '//evil.example/harvest',
        });
        const d = decodeState(s);
        expect(d).not.toBeNull();
        expect(d!.returnTo).toBe('//evil.example/harvest');
        expect(new URL(d!.returnTo!, 'https://app.inflect.bg').href)
            .toBe('https://evil.example/harvest');
    });

    it('SAML: same for RelayState', () => {
        const r = encodeSamlRelayState({
            tenantSlug: 'acme', providerId: 'p1',
            returnTo: '//evil.example/harvest',
        });
        const d = decodeSamlRelayState(r);
        expect(d!.returnTo).toBe('//evil.example/harvest');
        expect(new URL(d!.returnTo!, 'https://app.inflect.bg').href)
            .toBe('https://evil.example/harvest');
    });
});
