/**
 * The pure half of spending authority (Agent Pay Phase 1): what counts as a
 * widening (a second person reviews it) and what as a narrowing (one person is
 * enough), and the identifier shape that keeps a card number out of the row
 * (D-L1-8). The trigger `agent_spending_authority_lifecycle` holds the same
 * comparison in the database; `tests/integration/agent-spending-authority.test.ts`
 * proves the two agree on real rows.
 */
import {
    carriesCardNumberShape,
    isUnrestrictedScope,
    SpendingEnvelopeSchema,
    wideningsOf,
    type SpendingEnvelope,
} from '@/lib/agentic/spending-authority';

const BASE: SpendingEnvelope = {
    perTransactionLimitMinor: 5_000,
    periodBudgetMinor: BigInt(50_000),
    budgetPeriod: 'MONTH',
    currency: 'EUR',
    merchantDomains: ['shop.example.com', 'travel.example.com'],
    merchantCategoryCodes: ['4511'],
    expiresAt: new Date('2027-03-01T00:00:00Z'),
    consentedByUserId: 'u-consenter',
    tokenRequestor: 'Example Agent Platform',
    tokenReference: 'DWSPMC000000000132d72d4f',
};
const with_ = (over: Partial<SpendingEnvelope>): SpendingEnvelope => ({ ...BASE, ...over });

describe('a change is a widening when any field grants more', () => {
    it('the same envelope widens nothing', () => {
        expect(wideningsOf(BASE, BASE)).toEqual([]);
    });

    it('lower limits, an earlier expiry and a smaller scope are a narrowing', () => {
        expect(
            wideningsOf(
                BASE,
                with_({
                    perTransactionLimitMinor: BigInt(1_000),
                    periodBudgetMinor: 10_000,
                    expiresAt: new Date('2026-12-01T00:00:00Z'),
                    merchantDomains: ['shop.example.com'],
                }),
            ),
        ).toEqual([]);
    });

    it.each([
        ['perTransactionLimitMinor', { perTransactionLimitMinor: 5_001 }],
        ['periodBudgetMinor', { periodBudgetMinor: BigInt(50_001) }],
        ['expiresAt', { expiresAt: new Date('2027-03-01T00:00:01Z') }],
        ['currency', { currency: 'USD' }],
        ['budgetPeriod', { budgetPeriod: 'DAY' }],
        ['consentedByUserId', { consentedByUserId: 'u-other' }],
        ['tokenRequestor', { tokenRequestor: 'Another Platform' }],
        ['tokenReference', { tokenReference: 'OTHER-REF' }],
        ['merchantScope', { merchantDomains: ['shop.example.com', 'casino.example.com'] }],
        ['merchantScope', { merchantCategoryCodes: ['4511', '7995'] }],
    ] as const)('%s is named when it widens', (field, over) => {
        expect(wideningsOf(BASE, with_(over as Partial<SpendingEnvelope>))).toEqual([field]);
    });

    it('clearing a restricted merchant scope makes it UNRESTRICTED, the widest there is', () => {
        const cleared = with_({ merchantDomains: [], merchantCategoryCodes: [] });
        expect(isUnrestrictedScope(cleared)).toBe(true);
        expect(wideningsOf(BASE, cleared)).toEqual(['merchantScope']);
    });

    it('restricting an UNRESTRICTED scope is a narrowing', () => {
        const open = with_({ merchantDomains: [], merchantCategoryCodes: [] });
        expect(wideningsOf(open, BASE)).toEqual([]);
    });

    it('amounts compare as integers whatever their type, past 2^53', () => {
        const big = with_({ periodBudgetMinor: BigInt('9007199254740993') });
        expect(wideningsOf(big, with_({ periodBudgetMinor: BigInt('9007199254740994') }))).toEqual(['periodBudgetMinor']);
        expect(wideningsOf(big, with_({ periodBudgetMinor: BigInt('9007199254740992') }))).toEqual([]);
    });
});

describe('no identifier can carry a card number (D-L1-8)', () => {
    it.each([
        '4111111111111111',
        '4111 1111 1111 1111',
        '4111-1111-1111-1111',
        'tok_5555555555554444',
        '1234567890123', // 13 digits: refused whether or not it passes Luhn
    ])('%s is refused', (value) => {
        expect(carriesCardNumberShape(value)).toBe(true);
    });

    it.each(['DWSPMC000000000132d72d4fcb2f4136', 'Example Agent Platform', '123456789012', 'ref-2026-11-11'])(
        '%s is an ordinary identifier',
        (value) => {
            expect(carriesCardNumberShape(value)).toBe(false);
        },
    );
});

describe('the declared envelope', () => {
    const input = {
        rail: 'AGENT_PAY_TOKEN',
        perTransactionLimitMinor: 5_000,
        periodBudgetMinor: 50_000,
        budgetPeriod: 'MONTH',
        currency: 'EUR',
        merchantDomains: ['Shop.Example.com'],
        merchantCategoryCodes: ['4511'],
        expiresAt: '2027-03-01T00:00:00Z',
        consentedByUserId: 'u-consenter',
        tokenRequestor: 'Example Agent Platform',
        tokenReference: 'DWSPMC000000000132d72d4f',
    };

    it('parses, lower-casing host names', () => {
        const parsed = SpendingEnvelopeSchema.parse(input);
        expect(parsed.merchantDomains).toEqual(['shop.example.com']);
        expect(parsed.expiresAt).toBeInstanceOf(Date);
    });

    it('refuses a transaction limit above the period budget', () => {
        expect(SpendingEnvelopeSchema.safeParse({ ...input, perTransactionLimitMinor: 60_000 }).success).toBe(false);
    });

    it('refuses an unknown field, so nothing the schema does not name is stored', () => {
        expect(SpendingEnvelopeSchema.safeParse({ ...input, pan: '4111111111111111' }).success).toBe(false);
    });

    it.each([
        ['a missing expiry', { expiresAt: undefined }],
        ['a lower-case currency', { currency: 'eur' }],
        ['a three-digit MCC', { merchantCategoryCodes: ['451'] }],
        ['a reference with spaces', { tokenReference: 'has space' }],
        ['an unknown rail', { rail: 'CRYPTO' }],
    ])('refuses %s', (_label, over) => {
        expect(SpendingEnvelopeSchema.safeParse({ ...input, ...over }).success).toBe(false);
    });
});
