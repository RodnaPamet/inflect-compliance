/**
 * The `a2a-peer` provider (#3679): the outbound route to one registered A2A
 * peer. Its fail-closed surface is validation — a connection naming no peer,
 * or carrying a malformed credential, is refused — and the load-bearing fact
 * that a validation confers nothing: the send is gated per message by the
 * peer's admission, its kill and the connection's rung, none of which this
 * provider decides.
 */
import { A2aPeerProvider, A2A_PEER_PROVIDER_ID } from '@/app-layer/integrations/providers/a2a-peer-provider';
import {
    CONFIG_FIELD_RULES,
    originFieldsFor,
    redirectsStoredCredential,
    validateProviderConfig,
} from '@/app-layer/integrations/config-schema';

const provider = new A2aPeerProvider();

describe('what the provider declares about itself', () => {
    it('runs no compliance check and probes nothing live', () => {
        expect(provider.id).toBe(A2A_PEER_PROVIDER_ID);
        expect(provider.supportedChecks).toEqual([]);
        expect(provider.liveValidation).toBe(false);
        // No live peer has been exchanged with: the step's exit is open.
        expect(provider.mappingVerifiedBy).toBeNull();
    });

    it('holds no endpoint: where a task goes is the pinned card, not a typed URL', () => {
        expect(provider.configSchema.configFields.map((f) => f.key)).toEqual(['peerId']);
        expect(provider.configSchema.secretFields.map((f) => f.key)).toEqual(['authorization']);
    });
});

describe('validation fails closed', () => {
    it('refuses a connection that names no peer, or not a peer id', async () => {
        expect((await provider.validateConnection({}, {})).valid).toBe(false);
        expect((await provider.validateConnection({ peerId: 'https://evil.example' }, {})).valid).toBe(false);
    });

    it('refuses a credential that would inject a header', async () => {
        const r = await provider.validateConnection({ peerId: 'cpeer0000001' }, { authorization: 'Bearer x\r\nX-Evil: 1' });
        expect(r.valid).toBe(false);
    });

    it('accepts a well-formed peer reference, with or without a credential', async () => {
        expect((await provider.validateConnection({ peerId: 'cpeer0000001' }, {})).valid).toBe(true);
        expect((await provider.validateConnection({ peerId: 'cpeer0000001' }, { authorization: 'Bearer abc' })).valid).toBe(true);
    });
});

describe('the peer reference is an origin field', () => {
    it('is classified, and changing it while keeping the stored credential is a redirect', () => {
        expect(CONFIG_FIELD_RULES[A2A_PEER_PROVIDER_ID]).toEqual({ peerId: { kind: 'peerReference' } });
        expect(originFieldsFor(A2A_PEER_PROVIDER_ID)).toEqual(['peerId']);
        expect(redirectsStoredCredential(A2A_PEER_PROVIDER_ID, { peerId: 'cpeera' }, { peerId: 'cpeerb' })).toBe('peerId');
        expect(redirectsStoredCredential(A2A_PEER_PROVIDER_ID, { peerId: 'cpeera' }, { peerId: 'cpeera' })).toBeNull();
    });

    it('config validation refuses a value that is not a peer id', () => {
        expect(() => validateProviderConfig(A2A_PEER_PROVIDER_ID, { peerId: '../../etc' })).toThrow(/not a peer id/);
        expect(validateProviderConfig(A2A_PEER_PROVIDER_ID, { peerId: 'cpeer0000001' })).toEqual({ peerId: 'cpeer0000001' });
    });
});
