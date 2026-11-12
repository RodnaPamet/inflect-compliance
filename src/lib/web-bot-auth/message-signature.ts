/**
 * WEB BOT AUTH — the RFC 9421 (HTTP Message Signatures) subset Inflect SIGNS
 * with: the signature base, the `@signature-params` line, Ed25519 signing, and
 * the `Signature-Input` / `Signature` dictionary members (RFC 8941).
 *
 * Pure. It takes component VALUES the caller has already derived — it parses
 * no HTTP message, so it has no parser for an attacker to reach. Phase 1 calls
 * it only to sign the key directory's response; Phase 2's request signer will
 * call the same function, so the base is serialised in one place.
 *
 * Strict by refusal rather than by escaping: a component value carrying a CR,
 * LF or any byte outside visible ASCII and space would let one line of the
 * signature base masquerade as another, and is refused outright.
 */
import { sign, type KeyObject } from 'node:crypto';

/** One covered component and the value the caller derived for it. */
export interface CoveredComponent {
    /** Lower-case field name or derived component (`@authority`, `@method`, …). */
    readonly name: string;
    /** RFC 9421 §2.4: the value comes from the REQUEST of a signed response. */
    readonly req?: boolean;
    readonly value: string;
}

/** The signature parameters this signer emits (RFC 9421 §2.3), in emission order. */
export interface SignatureParameters {
    readonly created: number;
    readonly expires?: number;
    readonly keyid: string;
    readonly alg?: 'ed25519';
    readonly nonce?: string;
    readonly tag?: string;
}

const COMPONENT_NAME = /^@?[a-z0-9!#$%&'*+.^_`|~-]+$/;
// Visible ASCII plus space: what an sf-string may carry (RFC 8941 §3.3.3)
// and what a component value may carry without folding.
const PRINTABLE = /^[\x20-\x7e]*$/;
// RFC 8941 §3.1.2 key: the dictionary label.
const SF_KEY = /^[a-z*][a-z0-9_.*-]*$/;

function assertInteger(name: string, n: number): void {
    if (!Number.isSafeInteger(n) || n < 0 || n > 999_999_999_999_999) {
        throw new Error(`message-signature: ${name} must be a non-negative sf-integer`);
    }
}

/** RFC 8941 §4.1.6 sf-string. */
export function sfString(value: string): string {
    if (!PRINTABLE.test(value)) {
        throw new Error('message-signature: sf-string carries a byte outside visible ASCII and space');
    }
    return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

function componentIdentifier(c: CoveredComponent): string {
    if (!COMPONENT_NAME.test(c.name)) {
        throw new Error('message-signature: component name is not a lower-case token');
    }
    return `${sfString(c.name)}${c.req ? ';req' : ''}`;
}

/**
 * The `@signature-params` value (RFC 9421 §2.3): the inner list of component
 * identifiers, then the parameters in a fixed order.
 */
export function signatureParamsValue(
    components: readonly CoveredComponent[],
    params: SignatureParameters,
): string {
    const seen = new Set<string>();
    for (const c of components) {
        const id = componentIdentifier(c);
        if (seen.has(id)) throw new Error('message-signature: a component is covered twice');
        seen.add(id);
    }
    assertInteger('created', params.created);
    let out = `(${components.map(componentIdentifier).join(' ')});created=${params.created}`;
    if (params.expires !== undefined) {
        assertInteger('expires', params.expires);
        if (params.expires <= params.created) {
            throw new Error('message-signature: expires must be after created');
        }
        out += `;expires=${params.expires}`;
    }
    out += `;keyid=${sfString(params.keyid)}`;
    if (params.alg !== undefined) out += `;alg=${sfString(params.alg)}`;
    if (params.nonce !== undefined) out += `;nonce=${sfString(params.nonce)}`;
    if (params.tag !== undefined) out += `;tag=${sfString(params.tag)}`;
    return out;
}

/** The signature base (RFC 9421 §2.5): one line per component, then the params line, no trailing LF. */
export function signatureBase(
    components: readonly CoveredComponent[],
    params: SignatureParameters,
): string {
    const lines = components.map((c) => {
        if (!PRINTABLE.test(c.value)) {
            throw new Error('message-signature: a component value carries a byte outside visible ASCII and space');
        }
        return `${componentIdentifier(c)}: ${c.value}`;
    });
    lines.push(`"@signature-params": ${signatureParamsValue(components, params)}`);
    return lines.join('\n');
}

export interface SignedMember {
    /** The `Signature-Input` dictionary member: `label=(…);created=…`. */
    readonly signatureInput: string;
    /** The `Signature` dictionary member: `label=:base64:`. */
    readonly signature: string;
    /** The exact bytes signed, for conformance records and tests. */
    readonly base: string;
}

/** Sign one labelled member with an Ed25519 key. */
export function signMember(
    label: string,
    components: readonly CoveredComponent[],
    params: SignatureParameters,
    privateKey: KeyObject,
): SignedMember {
    if (!SF_KEY.test(label)) throw new Error('message-signature: label is not an sf-key');
    if (privateKey.asymmetricKeyType !== 'ed25519') {
        throw new Error('message-signature: only Ed25519 keys sign Web Bot Auth messages');
    }
    const base = signatureBase(components, params);
    const sig = sign(null, Buffer.from(base, 'utf8'), privateKey).toString('base64');
    return {
        signatureInput: `${label}=${signatureParamsValue(components, params)}`,
        signature: `${label}=:${sig}:`,
        base,
    };
}

/** Join members into the two dictionary header values (RFC 8941 §4.1.2). */
export function joinMembers(members: readonly SignedMember[]): { signatureInput: string; signature: string } {
    return {
        signatureInput: members.map((m) => m.signatureInput).join(', '),
        signature: members.map((m) => m.signature).join(', '),
    };
}
