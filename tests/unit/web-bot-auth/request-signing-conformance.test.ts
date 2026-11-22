/**
 * Web Bot Auth Phase 2 — the request signature, judged by an implementation
 * that shares no code with ours.
 *
 * The oracle is Cloudflare's reference library `web-bot-auth@0.2.0`, an exactly
 * pinned devDependency (decisions note, sub-phase 0.3). It never runs in
 * production. Here it verifies what `signRequest` produces, and refuses every
 * tampered variant: a signature that also verified a request it does not
 * cover would sign for nobody in particular.
 *
 * The committed record (`evals/web-bot-auth/records/2026-11-12-request-signing.json`)
 * is the G11 artefact that gates signed crawling: it fixes the inputs (the RFC
 * 9421 B.1.4 test key, a time, a nonce, a URL), the exact bytes our signer
 * produced, and the oracle's verdict on each case. This suite recomputes all
 * of it, so a change to the signer that the record does not describe fails CI
 * until the record is regenerated and the oracle re-asked
 * (`UPDATE_WEB_BOT_AUTH_RECORD=1`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { verify } from 'web-bot-auth';
import { verifierFromJWK } from 'web-bot-auth/crypto';

import { webBotAuthKeyFromSeed, type WebBotAuthKey } from '@/lib/web-bot-auth/key';
import {
    REQUEST_NONCE_BYTES,
    REQUEST_SIGNATURE_TAG,
    REQUEST_SIGNATURE_TTL_SECONDS,
    signatureAgentUrl,
    signRequest,
    type SignedRequestHeaders,
} from '@/lib/web-bot-auth/sign';

const ROOT = path.resolve(__dirname, '../../..');
const RECORD_PATH = 'evals/web-bot-auth/records/2026-11-12-request-signing.json';

// RFC 9421 Appendix B.1.4 — the published Ed25519 TEST key (its `d`, the
// seed). A test vector, not a credential; production refuses it.
const RFC9421_TEST_SEED_B64URL = 'n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU'; // pragma: allowlist secret
const TEST_KEY = webBotAuthKeyFromSeed(Buffer.from(RFC9421_TEST_SEED_B64URL, 'base64url').toString('hex')) as WebBotAuthKey;

const DIRECTORY_AUTHORITY = 'app.inflect.example';
const CREATED = 1_794_528_000; // 2026-11-13T00:00:00Z
const NONCE = Buffer.alloc(REQUEST_NONCE_BYTES, 7).toString('base64');
const URL_SIGNED = 'https://vendor.example/';

function signed(url = URL_SIGNED, method: 'GET' | 'HEAD' = 'GET', key: WebBotAuthKey = TEST_KEY) {
    return signRequest({ method, url }, key, { now: CREATED, directoryAuthority: DIRECTORY_AUTHORITY, nonce: NONCE });
}

/** What the oracle says about a request presented with `headers`, at `nowSeconds`. */
async function oracle(
    presented: { url: string; method?: string; headers: Record<string, string> },
    nowSeconds = CREATED + 1,
    key: WebBotAuthKey = TEST_KEY,
): Promise<'VERIFIED' | 'REFUSED'> {
    const verifier = await verifierFromJWK({ kty: 'OKP', crv: 'Ed25519', x: key.publicJwk.x });
    const request = new Request(presented.url, { method: presented.method ?? 'GET', headers: presented.headers });
    try {
        await verify(request, {
            // Resolve only from local configuration; the candidate's keyid is untrusted.
            resolver: (candidate) => {
                if (candidate.keyid !== verifier.keyid) throw new Error('unknown key');
                return verifier;
            },
            now: new Date(nowSeconds * 1000),
        });
        return 'VERIFIED';
    } catch {
        return 'REFUSED';
    }
}

const asRecord = (h: SignedRequestHeaders): Record<string, string> => ({ ...h });

/** The cases the record holds, each with the verdict it must get. */
function cases(): Array<{ name: string; expected: 'VERIFIED' | 'REFUSED'; run: () => Promise<'VERIFIED' | 'REFUSED'> }> {
    const s = signed();
    const h = asRecord(s.headers);
    const other = webBotAuthKeyFromSeed('11'.repeat(32)) as WebBotAuthKey;
    return [
        { name: 'the request as signed', expected: 'VERIFIED', run: () => oracle({ url: URL_SIGNED, headers: h }) },
        {
            name: 'a HEAD signed as HEAD',
            expected: 'VERIFIED',
            run: () => oracle({ url: URL_SIGNED, method: 'HEAD', headers: asRecord(signed(URL_SIGNED, 'HEAD').headers) }),
        },
        { name: 'presented at another path', expected: 'REFUSED', run: () => oracle({ url: 'https://vendor.example/admin', headers: h }) },
        { name: 'presented at another authority', expected: 'REFUSED', run: () => oracle({ url: 'https://evil.example/', headers: h }) },
        { name: 'presented with another method', expected: 'REFUSED', run: () => oracle({ url: URL_SIGNED, method: 'HEAD', headers: h }) },
        {
            name: 'with the Signature-Agent swapped for another directory',
            expected: 'REFUSED',
            run: () => oracle({ url: URL_SIGNED, headers: { ...h, 'Signature-Agent': '"https://evil.example/.well-known/http-message-signatures-directory"' } }),
        },
        { name: 'after the window closed', expected: 'REFUSED', run: () => oracle({ url: URL_SIGNED, headers: h }, CREATED + REQUEST_SIGNATURE_TTL_SECONDS + 120) },
        { name: 'checked against another key', expected: 'REFUSED', run: () => oracle({ url: URL_SIGNED, headers: h }, CREATED + 1, other) },
    ];
}

async function buildRecord() {
    const s = signed();
    const verdicts: Record<string, string> = {};
    for (const c of cases()) verdicts[c.name] = await c.run();
    return {
        record: 'web-bot-auth request signing conformance',
        roadmap: 'docs/ai-architecture/web-bot-auth.md Phase 2 (sub-phase 1.4 request half)',
        oracle: { package: 'web-bot-auth', version: '0.2.0', role: 'independent verifier; devDependency only' },
        wireFormat: 'docs/implementation-notes/2026-11-11-web-bot-auth-decisions.md',
        inputs: {
            key: 'RFC 9421 Appendix B.1.4 Ed25519 test key',
            keyid: TEST_KEY.keyid,
            method: 'GET',
            url: URL_SIGNED,
            directoryAuthority: DIRECTORY_AUTHORITY,
            created: CREATED,
            nonce: NONCE,
        },
        produced: { headers: s.headers, signatureBase: s.base },
        verdicts,
    };
}

describe('the oracle verifies our requests and refuses every tampered variant', () => {
    for (const c of cases()) {
        it(`${c.name}: ${c.expected}`, async () => {
            expect(await c.run()).toBe(c.expected);
        });
    }

    it('a freshly signed request (random nonce, current time) verifies too', async () => {
        const now = Math.floor(Date.now() / 1000);
        const s = signRequest({ method: 'GET', url: 'https://vendor.example/x?y=1' }, TEST_KEY, { now, directoryAuthority: DIRECTORY_AUTHORITY });
        expect(await oracle({ url: 'https://vendor.example/x?y=1', headers: asRecord(s.headers) }, now + 1)).toBe('VERIFIED');
    });
});

describe('the wire format is the one the decisions note records', () => {
    it('covers method, authority, path and the Signature-Agent, with tag, window, keyid and nonce', () => {
        const { headers } = signed();
        expect(headers['Signature-Agent']).toBe(`"${signatureAgentUrl(DIRECTORY_AUTHORITY)}"`);
        expect(headers['Signature-Input']).toBe(
            `sig1=("@method" "@authority" "@path" "signature-agent");created=${CREATED};` +
                `expires=${CREATED + REQUEST_SIGNATURE_TTL_SECONDS};keyid="${TEST_KEY.keyid}";alg="ed25519";` +
                `nonce="${NONCE}";tag="${REQUEST_SIGNATURE_TAG}"`,
        );
        expect(headers.Signature).toMatch(/^sig1=:[A-Za-z0-9+/]{86}==:$/);
    });

    it('draws a fresh 64-byte nonce for every request, so no signature is reused', () => {
        const a = signRequest({ method: 'GET', url: URL_SIGNED }, TEST_KEY, { now: CREATED, directoryAuthority: DIRECTORY_AUTHORITY });
        const b = signRequest({ method: 'GET', url: URL_SIGNED }, TEST_KEY, { now: CREATED, directoryAuthority: DIRECTORY_AUTHORITY });
        const nonceOf = (input: string) => /nonce="([^"]+)"/.exec(input)?.[1] ?? '';
        expect(Buffer.from(nonceOf(a.headers['Signature-Input']), 'base64')).toHaveLength(REQUEST_NONCE_BYTES);
        expect(nonceOf(a.headers['Signature-Input'])).not.toBe(nonceOf(b.headers['Signature-Input']));
        expect(a.headers.Signature).not.toBe(b.headers.Signature);
    });

    it('signs nothing but a bodiless https request without credentials', () => {
        const opts = { now: CREATED, directoryAuthority: DIRECTORY_AUTHORITY };
        // @ts-expect-error — POST is not a signable method, and is refused at run time too.
        expect(() => signRequest({ method: 'POST', url: URL_SIGNED }, TEST_KEY, opts)).toThrow(/GET and HEAD/);
        expect(() => signRequest({ method: 'GET', url: 'http://vendor.example/' }, TEST_KEY, opts)).toThrow(/https/);
        expect(() => signRequest({ method: 'GET', url: 'https://u:p@vendor.example/' }, TEST_KEY, opts)).toThrow(/credentials/);
    });
});

describe('the committed record still describes the signer (G11; gates signed crawling)', () => {
    it('recomputes byte for byte, oracle verdicts included', async () => {
        const record = await buildRecord();
        const file = path.join(ROOT, RECORD_PATH);
        if (process.env.UPDATE_WEB_BOT_AUTH_RECORD === '1') {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, `${JSON.stringify(record, null, 4)}\n`);
        }
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(record);
    });
});
