/**
 * An INDEPENDENT verifier for Web Bot Auth key directories, for tests only.
 *
 * Written from RFC 9421 §3.2 and RFC 7638 directly, and deliberately sharing
 * no code with `src/lib/web-bot-auth/`: a conformance check that verified our
 * signatures with our own serialiser would only prove the serialiser agrees
 * with itself. It reads the headers as a verifier receives them — the
 * `@signature-params` line is the member's text VERBATIM, not re-serialised —
 * and judges the keys by thumbprints it computes itself.
 *
 * It is not the reference verifier the roadmap's record calls for (Cloudflare's
 * `web-bot-auth` package); that stays open, see the implementation note.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';

export interface DirectoryVerdict {
    /** keyid → whether that key's signature verified for the authority. */
    readonly verifiedKeyids: readonly string[];
    readonly failures: readonly string[];
}

/** Split a dictionary header on top-level commas (none occur inside our members' strings). */
function members(header: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const raw of header.split(/,\s*(?=[a-z*][a-z0-9_.*-]*=)/)) {
        const eq = raw.indexOf('=');
        out.set(raw.slice(0, eq).trim(), raw.slice(eq + 1).trim());
    }
    return out;
}

function stringParam(params: string, name: string): string | null {
    const m = new RegExp(`;${name}="([^"\\\\]*)"`).exec(params);
    return m ? m[1] : null;
}

function intParam(params: string, name: string): number | null {
    const m = new RegExp(`;${name}=(\\d+)`).exec(params);
    return m ? Number(m[1]) : null;
}

/** RFC 7638 thumbprint, computed generically: required members sorted, no whitespace. */
export function independentThumbprint(jwk: Record<string, unknown>): string {
    if (jwk.kty !== 'OKP') throw new Error('only OKP keys are expected here');
    const required = ['crv', 'kty', 'x'].sort();
    const canonical = `{${required.map((k) => `${JSON.stringify(k)}:${JSON.stringify(jwk[k])}`).join(',')}}`;
    return createHash('sha256').update(canonical).digest('base64url');
}

export function verifyDirectoryResponse(input: {
    body: string;
    signatureInput: string;
    signature: string;
    /** The authority the verifier fetched the directory from. */
    authority: string;
    /** Verification time, seconds. */
    now: number;
}): DirectoryVerdict {
    const failures: string[] = [];
    const verifiedKeyids: string[] = [];
    const parsed = JSON.parse(input.body) as { keys: Record<string, unknown>[] };
    const byKeyid = new Map(parsed.keys.map((k) => [independentThumbprint(k), k]));
    const inputs = members(input.signatureInput);
    const sigs = members(input.signature);

    for (const [label, paramsText] of inputs) {
        const covered = /^\(([^)]*)\)/.exec(paramsText);
        if (!covered || covered[1] !== '"@authority";req') {
            failures.push(`${label}: covers ${covered?.[1] ?? 'nothing'}, not "@authority";req`);
            continue;
        }
        if (stringParam(paramsText, 'tag') !== 'http-message-signatures-directory') {
            failures.push(`${label}: wrong tag`);
            continue;
        }
        const created = intParam(paramsText, 'created');
        const expires = intParam(paramsText, 'expires');
        if (created === null || created > input.now || (expires !== null && expires <= input.now)) {
            failures.push(`${label}: outside its window`);
            continue;
        }
        const keyid = stringParam(paramsText, 'keyid');
        const jwk = keyid ? byKeyid.get(keyid) : undefined;
        if (!keyid || !jwk) {
            failures.push(`${label}: keyid names no key in the directory`);
            continue;
        }
        const sigMember = sigs.get(label);
        const sig = sigMember ? /^:([A-Za-z0-9+/=]+):$/.exec(sigMember) : null;
        if (!sig) {
            failures.push(`${label}: no signature`);
            continue;
        }
        const base = `"@authority";req: ${input.authority}\n"@signature-params": ${paramsText}`;
        const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x as string }, format: 'jwk' });
        if (verify(null, Buffer.from(base), key, Buffer.from(sig[1], 'base64'))) {
            verifiedKeyids.push(keyid);
        } else {
            failures.push(`${label}: signature does not verify`);
        }
    }
    return { verifiedKeyids, failures };
}
