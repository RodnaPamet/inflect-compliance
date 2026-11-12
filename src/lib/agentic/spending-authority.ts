/**
 * Spending authority — the pure half (docs/ai-architecture/mastercard-agent-pay.md
 * Phase 1; owner decisions D-L1-8 and D-L1-9, 2026-11-11).
 *
 * An agent's spending authority is an ENVELOPE the cardholder consented to:
 * rail, per-transaction limit, period budget, merchant scope, expiry, the
 * consenting member, and the token requestor (agent platform) with its own
 * reference for the token. It is a declaration to REVIEW, never a grant Inflect
 * enforces at payment time: Mastercard and the issuer enforce the token's
 * limits, and Inflect knows them, checks them and stops them.
 *
 * This module holds what needs no database: the input schema, the comparison
 * that decides whether a change WIDENS (needs a second person) or NARROWS (one
 * person is enough), and the identifier shape that keeps a card number out of
 * the row (D-L1-8). The comparison mirrors the trigger
 * `agent_spending_authority_lifecycle` in migration
 * `20261111230000_agent_spending_authority`, which refuses an in-place change
 * to a REVIEWED envelope that is not a narrowing; the two are kept in step by
 * `tests/unit/agentic/spending-authority.test.ts` and the integration test.
 *
 * Client-safe: no server imports.
 */
import { z } from 'zod';

export const SPENDING_RAILS = ['AGENT_PAY_TOKEN', 'AP4M', 'OTHER'] as const;
export type SpendingRail = (typeof SPENDING_RAILS)[number];

export const SPENDING_BUDGET_PERIODS = ['DAY', 'WEEK', 'MONTH'] as const;
export type SpendingBudgetPeriod = (typeof SPENDING_BUDGET_PERIODS)[number];

/**
 * The named refusals of the spending-authority writer, carried as
 * `details.reason` beside a sentence written for the operator.
 */
export type SpendingAuthorityRefusal =
    | 'AGENT_NOT_FOUND'
    | 'AGENT_RETIRED'
    | 'ENVELOPE_NOT_FOUND'
    | 'IDENTIFIER_CARRIES_CARD_NUMBER'
    | 'IDENTIFIER_CARRIES_CREDENTIAL'
    | 'CONSENTER_NOT_A_MEMBER'
    | 'NOT_A_NARROWING'
    | 'NOT_DECLARED'
    | 'NOT_CHANGEABLE'
    | 'DECLARATION_CHANGED'
    | 'REVIEWER_NOT_A_PERSON'
    | 'REVIEWER_IS_DECLARER'
    | 'REVIEWER_IS_OWNER'
    | 'ALREADY_WITHDRAWN';

/** The activation refusal `assertActivatable` raises, and the trigger's message prefix. */
export const SPENDING_AUTHORITY_UNREVIEWED = 'SPENDING_AUTHORITY_UNREVIEWED' as const;

/** The finding raised when an ACTIVE agent's envelope is declared or widened. */
export const SPENDING_AUTHORITY_WIDENED_FINDING_SOURCE_KIND = 'SPENDING_AUTHORITY_WIDENED';
export const SPENDING_AUTHORITY_WIDENED_FINDING_SEVERITY = 'HIGH' as const;

/**
 * The longest run of digits an identifier may carry. A primary account number
 * is 13 to 19 digits, so a run of 13 is refused whether or not it passes Luhn:
 * these fields hold a platform's name and its OWN reference for a token, and
 * neither needs that many digits in a row. Stricter than a card-number check,
 * on purpose — a reference that happened to fail Luhn is still not a reference
 * this row should keep. Everything but letters and digits is ignored, so
 * `4111-1111-1111-1111` and `4111 1111 1111 1111` count as the run they spell.
 * The CHECK `AgentSpendingAuthority_identifiers_carry_no_card_number` applies
 * the same rule below the usecase.
 */
export const MAX_DIGIT_RUN = 12;

/** True when `value` holds a run of more than `MAX_DIGIT_RUN` digits, separators ignored. */
export function carriesCardNumberShape(value: string): boolean {
    const digitsJoined = value.replace(/[^0-9A-Za-z]+/g, '');
    return new RegExp(`[0-9]{${MAX_DIGIT_RUN + 1},}`).test(digitsJoined);
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The envelope as a caller declares it. Every field is required: a missing limit is no limit. */
export const SpendingEnvelopeSchema = z
    .object({
        rail: z.enum(SPENDING_RAILS),
        perTransactionLimitMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        periodBudgetMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        budgetPeriod: z.enum(SPENDING_BUDGET_PERIODS),
        currency: z.string().regex(/^[A-Z]{3}$/, 'An ISO 4217 code, three upper-case letters'),
        merchantDomains: z
            .array(z.string().trim().toLowerCase().regex(HOSTNAME, 'A host name, such as shop.example.com'))
            .max(100),
        merchantCategoryCodes: z.array(z.string().regex(/^[0-9]{4}$/, 'A four-digit merchant category code')).max(100),
        expiresAt: z.coerce.date(),
        consentedByUserId: z.string().min(1).max(64),
        tokenRequestor: z.string().trim().min(1).max(80),
        tokenReference: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/, 'A reference: letters, digits and . _ : - only'),
    })
    .strict()
    .refine((e) => e.perTransactionLimitMinor <= e.periodBudgetMinor, {
        message: 'A single transaction cannot be larger than the period budget',
        path: ['perTransactionLimitMinor'],
    });
export type SpendingEnvelopeInput = z.infer<typeof SpendingEnvelopeSchema>;

/** The envelope fields the comparison reads. Amounts may arrive as bigint from the row. */
export interface SpendingEnvelope {
    readonly perTransactionLimitMinor: number | bigint;
    readonly periodBudgetMinor: number | bigint;
    readonly budgetPeriod: string;
    readonly currency: string;
    readonly merchantDomains: readonly string[];
    readonly merchantCategoryCodes: readonly string[];
    readonly expiresAt: Date;
    readonly consentedByUserId: string;
    readonly tokenRequestor: string;
    readonly tokenReference: string;
}

/** An empty merchant scope is UNRESTRICTED: the widest scope there is. */
export function isUnrestrictedScope(e: Pick<SpendingEnvelope, 'merchantDomains' | 'merchantCategoryCodes'>): boolean {
    return e.merchantDomains.length === 0 && e.merchantCategoryCodes.length === 0;
}

const subsetOf = (a: readonly string[], b: readonly string[]) => {
    const inB = new Set(b);
    return a.every((x) => inB.has(x));
};

/**
 * Every way `after` is WIDER than `before`, by field name; empty when `after`
 * is a narrowing (or the same envelope).
 *
 * A change to the currency, the period, the consenter, the token requestor or
 * the token reference is not comparable, so it counts as a widening: it points
 * the declaration at a different consent or a different token, which is a new
 * declaration a second person reviews. A merchant scope narrows when an
 * unrestricted one becomes restricted, or a restricted one keeps a non-empty
 * subset of each list; clearing it entirely makes it UNRESTRICTED, the widest.
 */
export function wideningsOf(before: SpendingEnvelope, after: SpendingEnvelope): string[] {
    const out: string[] = [];
    if (BigInt(after.perTransactionLimitMinor) > BigInt(before.perTransactionLimitMinor)) out.push('perTransactionLimitMinor');
    if (BigInt(after.periodBudgetMinor) > BigInt(before.periodBudgetMinor)) out.push('periodBudgetMinor');
    if (after.expiresAt.getTime() > before.expiresAt.getTime()) out.push('expiresAt');
    if (after.currency !== before.currency) out.push('currency');
    if (after.budgetPeriod !== before.budgetPeriod) out.push('budgetPeriod');
    if (after.consentedByUserId !== before.consentedByUserId) out.push('consentedByUserId');
    if (after.tokenRequestor !== before.tokenRequestor) out.push('tokenRequestor');
    if (after.tokenReference !== before.tokenReference) out.push('tokenReference');
    if (!isUnrestrictedScope(before)) {
        const scopeNarrows =
            !isUnrestrictedScope(after) &&
            subsetOf(after.merchantDomains, before.merchantDomains) &&
            subsetOf(after.merchantCategoryCodes, before.merchantCategoryCodes);
        if (!scopeNarrows) out.push('merchantScope');
    }
    return out;
}
