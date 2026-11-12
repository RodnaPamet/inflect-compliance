/**
 * The per-type redaction action (D-L1-1, docs/ai-architecture/presidio.md
 * Phase 1.2).
 *
 * Every D-L1-1 type is REPLACED with a numbered placeholder (`<PERSON_1>`),
 * which is what Phase 2.3's "placeholders stay" note explains to a user.
 *
 * `MASK` exists for a surface that must keep the text's shape (a trace view
 * lining spans up with the original); it is not the egress default because it
 * keeps each value's length. There is deliberately NO `HASH` action, although
 * the roadmap's 0.1 lists one: an unkeyed digest of a 10-digit ЕГН or a phone
 * number is reversed by enumerating the space, so it would be a redaction that
 * redacts nothing. A keyed digest needs a key-management decision of its own.
 */
import { PII_ENTITY_TYPES, type PiiEntityType } from './scope';
import type { PiiRedactionAction, PiiRedactionPolicy } from './types';

/** The egress policy. A `Record` over the union, so a new type without an action fails `tsc`. */
export const EGRESS_REDACTION_POLICY: PiiRedactionPolicy = {
    PERSON: 'REPLACE',
    EMAIL_ADDRESS: 'REPLACE',
    PHONE_NUMBER: 'REPLACE',
    IBAN_CODE: 'REPLACE',
    BG_EGN: 'REPLACE',
};

/** A policy applying one action to every type — for tests and shape-keeping surfaces. */
export function uniformPolicy(action: PiiRedactionAction): PiiRedactionPolicy {
    return Object.fromEntries(PII_ENTITY_TYPES.map((t) => [t, action])) as Record<PiiEntityType, PiiRedactionAction>;
}
