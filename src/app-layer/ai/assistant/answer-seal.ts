/**
 * A server-held mark on each answer the assistant gave (#5054).
 *
 * ═══ WHY HISTORY NEEDS ONE ═══
 *
 * Earlier turns come back from the browser, which can write any "answer" it
 * likes, so the history guard scans them with the same injection rules as a
 * typed question. But most of what comes back is text the SERVER wrote: the
 * model's answer after the egress guard, or a sentence the product composed
 * ("…ask an administrator to review the quarantined item."). Those rules were
 * written for questions, and several of them fire on ordinary assistant prose.
 * Scanning the server's own words as if the person had typed them did two
 * wrong things: it wrote an `AI_GUARD_INPUT_FLAGGED` row naming the person as
 * the actor for words the product wrote, and it refused every later question
 * in the conversation.
 *
 * So each answer leaves with a seal: HMAC-SHA256 over the tenant, the asker
 * and the exact answer text, under a key derived from the deployment's master
 * key for this purpose alone. An earlier answer that comes back with a seal
 * that verifies is the server's own text, already egress-guarded when it was
 * produced, and is not scanned again. Anything else (no seal, a seal over other
 * text, another person's or another tenant's seal, an answer the browser
 * shortened to fit the window) is scanned exactly as a question is, which is
 * the forged-turn case the guard exists for. Questions are ALWAYS scanned.
 *
 * A seal grants nothing. It is not an id, it names no row, and it unlocks no
 * tool: it only says "the server already wrote this text for this person".
 * The text still reaches the model as an earlier assistant message that the
 * system prompt says is context, never instruction.
 *
 * Rotating the master key invalidates every seal, which only means the answers
 * in an open conversation are scanned, as every answer was before seals.
 *
 * @module ai/assistant/answer-seal
 */
import { createHmac, timingSafeEqual } from 'crypto';

import { deriveSubkey } from '@/lib/security/encryption';

/** HKDF purpose for the seal key. Bumping the version retires every seal. */
const SEAL_PURPOSE = 'inflect-assistant-answer-seal-v1';

/** A seal on the wire: 64 lowercase hex characters. */
export const ANSWER_SEAL_PATTERN = /^[0-9a-f]{64}$/;

interface SealSubject {
    readonly tenantId: string;
    readonly userId: string;
}

function mac(subject: SealSubject, answer: string): Buffer {
    return createHmac('sha256', deriveSubkey(SEAL_PURPOSE))
        .update(`${subject.tenantId}\u0000${subject.userId}\u0000${answer}`, 'utf8')
        .digest();
}

/** The seal for an answer this server is about to return to `subject`. */
export function sealAssistantAnswer(subject: SealSubject, answer: string): string {
    return mac(subject, answer).toString('hex');
}

/**
 * Did this server give exactly `answer` to exactly `subject`?
 *
 * False for anything that is not a well-formed seal, so a caller never has to
 * check the shape first. Constant-time over the digest.
 */
export function isSealedByServer(subject: SealSubject, answer: string, seal: string | undefined): boolean {
    if (typeof seal !== 'string' || !ANSWER_SEAL_PATTERN.test(seal)) return false;
    const given = Buffer.from(seal, 'hex');
    const expected = mac(subject, answer);
    return given.length === expected.length && timingSafeEqual(given, expected);
}
