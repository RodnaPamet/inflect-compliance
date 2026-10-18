/**
 * Reading a peer's agent card off the wire (#3673): https only, a deadline, a
 * byte cap that aborts, and a failure that names a reason and carries no body
 * (`docs/a2a-threat-model.md`, I0 I and D; pinning rule 8).
 */
import { fetchAgentCard } from '@/lib/agentic/peer-agent-card-fetch';
import { AGENT_CARD_MAX_BYTES } from '@/lib/agentic/peer-agent-card';

const CARD = {
    name: 'Partner Reconciler',
    description: 'Reconciles supplier invoices.',
    url: 'https://agents.partner.example/a2a',
    skills: [{ id: 'reconcile', name: 'Reconcile', description: 'Matches an invoice.' }],
};

function respond(body: string, init: ResponseInit = {}) {
    return jest.fn(async () => new Response(body, { status: 200, ...init }));
}

describe('fetchAgentCard', () => {
    it('reads and hashes a card', async () => {
        const fetchImpl = respond(JSON.stringify(CARD));
        const r = await fetchAgentCard('https://partner.example/.well-known/agent-card.json', { fetchImpl });
        expect(r.ok).toBe(true);
        expect(r.ok && r.hashes.cardHash).toMatch(/^[0-9a-f]{64}$/);
        expect(fetchImpl).toHaveBeenCalledWith(
            'https://partner.example/.well-known/agent-card.json',
            expect.objectContaining({ method: 'GET' }),
        );
    });

    it('refuses anything but https, before any request — the test seam included', async () => {
        const fetchImpl = respond(JSON.stringify(CARD));
        for (const url of ['http://partner.example/card.json', 'file:///etc/passwd', 'not a url']) {
            await expect(fetchAgentCard(url, { fetchImpl })).resolves.toEqual({ ok: false, reason: 'SCHEME_REFUSED' });
        }
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('refuses a declared oversize body without reading it', async () => {
        const fetchImpl = respond('{}', { headers: { 'content-length': String(AGENT_CARD_MAX_BYTES + 1) } });
        await expect(fetchAgentCard('https://p.example/c', { fetchImpl })).resolves.toEqual({ ok: false, reason: 'TOO_LARGE' });
    });

    it('aborts a body that grows past the cap with no length declared', async () => {
        let pulled = 0;
        const chunk = new Uint8Array(16 * 1024).fill(0x20);
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled += 1;
                controller.enqueue(chunk);
            },
        });
        const fetchImpl = jest.fn(async () => new Response(stream, { status: 200 }));
        await expect(fetchAgentCard('https://p.example/c', { fetchImpl })).resolves.toEqual({ ok: false, reason: 'TOO_LARGE' });
        // The cap stopped the transfer: an unbounded stream was not read to the end.
        expect(pulled).toBeLessThan(AGENT_CARD_MAX_BYTES / chunk.byteLength + 3);
    });

    it('a slow peer times out', async () => {
        const fetchImpl = jest.fn(
            (_url: string, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                }),
        );
        await expect(fetchAgentCard('https://p.example/c', { fetchImpl, timeoutMs: 20 })).resolves.toEqual({
            ok: false,
            reason: 'TIMEOUT',
        });
    });

    it.each([
        ['an HTTP error', respond('nope', { status: 404 }), 'HTTP_ERROR'],
        ['a non-JSON body', respond('<html>'), 'NOT_JSON'],
        ['JSON that is not a card', respond('{"hello":"world"}'), 'NOT_AN_AGENT_CARD'],
        ['a card naming a plaintext endpoint', respond(JSON.stringify({ ...CARD, url: 'http://x.example' })), 'ENDPOINT_NOT_HTTPS'],
    ])('names the reason for %s and carries no body', async (_label, fetchImpl, reason) => {
        const r = await fetchAgentCard('https://p.example/c', { fetchImpl });
        expect(r).toEqual({ ok: false, reason });
    });

    it('a network refusal is EGRESS_REFUSED', async () => {
        const fetchImpl = jest.fn(async () => {
            throw new Error('private address 10.0.0.1');
        });
        await expect(fetchAgentCard('https://p.example/c', { fetchImpl })).resolves.toEqual({ ok: false, reason: 'EGRESS_REFUSED' });
    });
});
