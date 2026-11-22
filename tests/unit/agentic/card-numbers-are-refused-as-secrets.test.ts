/**
 * The PCI line (D-L1-8, adopted 2026-11-11): Inflect never stores a card
 * number, so a harness report carrying one is refused like any other secret,
 * and an ordinary number is not.
 *
 * Phase 0 of `docs/ai-architecture/mastercard-agent-pay.md`. The test PANs are
 * the networks' published test numbers; the others are built at run time with
 * a computed Luhn check digit, so each "ordinary number" case is a run the
 * Luhn check alone WOULD accept — the rule under test is what refuses it.
 */
import {
    containsCardNumber,
    looksLikeSecret,
    passesLuhn,
} from '@/lib/agentic/harness-contract-rules';
import { verifyAndParseHarnessReport } from '@/lib/agentic/harness-contract';
import { firstSecretShapedMember, firstSecretShapedPath } from '@/lib/agentic/harness-findings';
import {
    createFakeScanner,
    validReportBody,
    validV2ReportBody,
} from '../../helpers/agent-harness-fake-scanner';

/** `prefix` followed by the digit that makes the whole run pass Luhn. */
function withCheckDigit(prefix: string): string {
    for (let d = 0; d <= 9; d++) {
        if (passesLuhn(`${prefix}${d}`)) return `${prefix}${d}`;
    }
    throw new Error('unreachable: one check digit always exists');
}

/** The same run with its last digit changed, so it fails Luhn. */
function breakCheckDigit(run: string): string {
    const last = Number(run[run.length - 1]);
    return `${run.slice(0, -1)}${(last + 1) % 10}`;
}

const TEST_PANS = {
    mastercard: '5555555555554444',
    mastercard2Series: '2223003122003222',
    visa: '4111111111111111',
    visa13: '4222222222222',
    amex: '378282246310005',
    diners14: '30569309025904',
    discover: '6011111111111117',
    jcb: '3530111333300000',
} as const;

describe('the Luhn check', () => {
    it('accepts every published test PAN and refuses each with its check digit changed', () => {
        for (const pan of Object.values(TEST_PANS)) {
            expect(passesLuhn(pan)).toBe(true);
            expect(passesLuhn(breakCheckDigit(pan))).toBe(false);
        }
    });

    it('is a check on digits only', () => {
        expect(passesLuhn('')).toBe(false);
        expect(passesLuhn('5555 5555 5555 4444')).toBe(false);
    });
});

describe('a card number is secret-shaped wherever it appears', () => {
    it('every network\'s test PAN, written contiguously, from 13 to 16 digits', () => {
        for (const pan of Object.values(TEST_PANS)) {
            expect(containsCardNumber(pan)).toBe(true);
            expect(looksLikeSecret(pan)).toBe(true);
        }
    });

    it('a 19-digit card number, contiguous and in 4-4-4-4-3 groups', () => {
        const pan19 = withCheckDigit('622126000000000000');
        expect(pan19).toHaveLength(19);
        expect(containsCardNumber(pan19)).toBe(true);
        const grouped = pan19.replace(/^(\d{4})(\d{4})(\d{4})(\d{4})(\d{3})$/, '$1 $2 $3 $4 $5');
        expect(containsCardNumber(grouped)).toBe(true);
    });

    it('grouped as cards are printed, with spaces or hyphens', () => {
        expect(containsCardNumber('5555 5555 5555 4444')).toBe(true);
        expect(containsCardNumber('5555-5555-5555-4444')).toBe(true);
        expect(containsCardNumber('4222 2222 2222 2')).toBe(true);
        // American Express 4-6-5 and Diners Club 4-6-4.
        expect(containsCardNumber('3782 822463 10005')).toBe(true);
        expect(containsCardNumber('3056 930902 5904')).toBe(true);
    });

    it('inside a longer string: a locator, an assignment, a sentence', () => {
        expect(containsCardNumber('kv://wallets/agent-7/5555555555554444')).toBe(true);
        expect(containsCardNumber('pan=4111111111111111&exp=12/30')).toBe(true);
        expect(containsCardNumber('pay with 5555 5555 5555 4444 today')).toBe(true);
        expect(containsCardNumber('card 5555555555554444.')).toBe(true);
    });
});

describe('an ordinary number is not, even when its digits pass Luhn', () => {
    it('a digit run that fails Luhn', () => {
        for (const pan of Object.values(TEST_PANS)) {
            expect(containsCardNumber(breakCheckDigit(pan))).toBe(false);
            expect(containsCardNumber(breakCheckDigit(pan).replace(/(\d{4})(?=\d)/g, '$1 '))).toBe(false);
        }
    });

    it('a run outside 13 to 19 digits', () => {
        const twelve = withCheckDigit('55555555555');
        const twenty = withCheckDigit('5555555555555555555');
        expect(twelve).toHaveLength(12);
        expect(twenty).toHaveLength(20);
        expect(containsCardNumber(twelve)).toBe(false);
        expect(containsCardNumber(twenty)).toBe(false);
        // Three groups of four are a printed grouping, and still too short.
        expect(containsCardNumber(twelve.replace(/(\d{4})(?=\d)/g, '$1 '))).toBe(false);
    });

    it('a grouped reference that starts with 1', () => {
        const ref = withCheckDigit('100020003000400');
        const grouped = (run: string) => run.replace(/(\d{4})(?=\d)/g, '$1 ');
        expect(containsCardNumber(grouped(ref))).toBe(false);
        expect(containsCardNumber(grouped(withCheckDigit(`5${ref.slice(1, -1)}`)))).toBe(true);
    });

    it('an id or a clock that starts with 1: a millisecond timestamp and a Snowflake id', () => {
        const millis = withCheckDigit('176283360000');
        const snowflake = withCheckDigit('117306425128034304');
        expect([millis.length, snowflake.length]).toEqual([13, 19]);
        expect(containsCardNumber(millis)).toBe(false);
        expect(containsCardNumber(snowflake)).toBe(false);
        // The same run with a payment-card first digit IS a card number.
        expect(containsCardNumber(withCheckDigit(`5${snowflake.slice(1, -1)}`))).toBe(true);
    });

    it('a card-shaped run inside a longer digit run: a 21-digit GCP unique id', () => {
        const uniqueId = `10${TEST_PANS.mastercard}123`;
        expect(uniqueId).toHaveLength(21);
        expect(containsCardNumber(uniqueId)).toBe(false);
    });

    it('a phone number, in E.164 and as people write it', () => {
        const e164 = withCheckDigit('35988812345678');
        expect(e164).toHaveLength(15);
        expect(containsCardNumber(`+${e164}`)).toBe(false);
        expect(containsCardNumber(`tel:+${e164}`)).toBe(false);
        // Without the `+` the same digits are a 15-digit card-shaped run.
        expect(containsCardNumber(e164)).toBe(true);
        for (const spaced of ['+359 888 123 4567', '+44 20 7946 0958', '+1 (415) 555-0132', '0888 123 456']) {
            expect(containsCardNumber(spaced)).toBe(false);
        }
    });

    it('a date, a date range and a timestamp', () => {
        // Sixteen digits that pass Luhn and start with 2, in date groups.
        const range = '2026-11-11 2026-01-13';
        expect(passesLuhn(range.replace(/\D/g, ''))).toBe(true);
        expect(containsCardNumber(range)).toBe(false);
        expect(containsCardNumber('2026-11-11')).toBe(false);
        expect(containsCardNumber('2026-11-11T05:00:00.000Z')).toBe(false);
    });

    it('an amount, a merchant category code, a limit and a budget', () => {
        expect(containsCardNumber(`0.${TEST_PANS.mastercard}`)).toBe(false);
        expect(containsCardNumber(`${TEST_PANS.mastercard}.25`)).toBe(false);
        for (const v of ['EUR 1250.00', '5411', 'per-transaction 500 USD', 'budget 250000 per month']) {
            expect(containsCardNumber(v)).toBe(false);
        }
    });

    it('an all-digit GUID, whose groups never fall into card groups', () => {
        expect(containsCardNumber('55555555-5555-5555-5555-444455556666')).toBe(false);
    });
});

describe('a card printed beside other numbers is still a card', () => {
    it('followed by its expiry, its CVV, a second card or a trailing group', () => {
        for (const printed of [
            '5555 5555 5555 4444 12/30',
            '5555-5555-5555-4444-12/30',
            '4111 1111 1111 1111 123',
            '3782 822463 10005 1234',
            'card: 4111-1111-1111-1111 exp 12-30 cvv 123',
        ]) {
            expect(containsCardNumber(printed)).toBe(true);
        }
    });

    it('two cards in one list, each found on its own', () => {
        expect(containsCardNumber('5555 5555 5555 4444 4111 1111 1111 1111')).toBe(true);
        // The first card's check digit broken: the second is still found.
        expect(containsCardNumber(`${breakCheckDigit('5555555555554444').replace(/(\d{4})(?=\d)/g, '$1 ')} 4111 1111 1111 1111`)).toBe(true);
    });

    it('after an order number', () => {
        expect(containsCardNumber('Order 7 5555 5555 5555 4444')).toBe(true);
    });
});

/** Every 13-19 digit run, bounded only by digits, that starts 2-6 and passes Luhn. */
function hasBareCardShapedRun(value: string): boolean {
    for (const run of value.match(/\d+/g) ?? []) {
        for (let len = 13; len <= 19; len++) {
            for (let at = 0; at + len <= run.length; at++) {
                const digits = run.slice(at, at + len);
                if (digits[0] >= '2' && digits[0] <= '6' && passesLuhn(digits)) return true;
            }
        }
    }
    return false;
}

describe('a hex digest or a UUID is never a card, whatever decimal runs it holds', () => {
    const { createHash } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
    const hex = (algo: 'sha256' | 'sha1', i: number) => createHash(algo).update(`value-${i}`).digest('hex');
    const uuid = (i: number) => hex('sha256', i).slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

    it('the digests the review found refused, each holding a Luhn-valid run between letters', () => {
        for (const digest of [
            'sha256:3acafb459d5b4f52e80f1f1b69a9fc3793089196403e06500038ae9f7f0afcaa',
            'sha256:d7d0ffd90e4efceb742e060e35922d753e0d4e3235874276578c723ddd537220',
        ]) {
            expect(hasBareCardShapedRun(digest)).toBe(true);
            expect(containsCardNumber(digest)).toBe(false);
            expect(looksLikeSecret(digest)).toBe(false);
        }
    });

    it('a tool manifest hash in a report is not secret-shaped', () => {
        const manifestHash = 'sha256:d7d0ffd90e4efceb742e060e35922d753e0d4e3235874276578c723ddd537220';
        expect(firstSecretShapedPath({ agents: [{ tools: [{ manifestHash }] }] })).toBeNull();
    });

    it('none of 20,000 sha256 digests, SHA-1s or UUIDs is refused, though some hold card-shaped runs', () => {
        const population: string[] = [];
        for (let i = 0; i < 20_000; i++) {
            population.push(`sha256:${hex('sha256', i)}`, hex('sha1', i), uuid(i));
        }
        // The population is not vacuous: read as bare digit runs, some of it
        // holds exactly the run a card number is.
        expect(population.filter(hasBareCardShapedRun).length).toBeGreaterThan(10);
        expect(population.filter((v) => containsCardNumber(v))).toEqual([]);
    });
});

describe('a harness report carrying a card number is refused, and names the member only', () => {
    const scanner = createFakeScanner();

    it('the ingest\'s walk finds one in a member the contract does not check', () => {
        expect(firstSecretShapedMember(validReportBody())).toBeNull();
        const body = validReportBody();
        body.agents[1].tools[0].name = `charge-${TEST_PANS.mastercard}`;
        const at = firstSecretShapedMember(body);
        expect(at).toBe('agents[1].tools[0].name');
        expect(at).not.toContain(TEST_PANS.mastercard);
    });

    it('the contract refuses one inside a credential reference, without echoing it', () => {
        const body = { ...validV2ReportBody(), unboundCredentials: [{ ref: `kv://wallet/${TEST_PANS.visa}`, sourceKind: 'vault' }] };
        const result = verifyAndParseHarnessReport(scanner.serialise(body), [scanner.publicKeyHex]);
        if (result.ok) throw new Error('expected a refusal');
        expect(result.reason).toBe('SCHEMA');
        expect((result.issues ?? []).some((i) => i.startsWith('unboundCredentials.0.ref:'))).toBe(true);
        expect((result.issues ?? []).join(' ')).not.toContain(TEST_PANS.visa);
    });

    it('a valid report with ordinary numbers in its strings still verifies', () => {
        const body = validReportBody();
        body.agents[1].tools[0].name = 'refund-under-5411-limit-2026-11-11';
        const result = verifyAndParseHarnessReport(scanner.serialise(body), [scanner.publicKeyHex]);
        expect(result.ok).toBe(true);
        expect(firstSecretShapedMember(body)).toBeNull();
    });
});

describe('the generic walk a register writer reuses', () => {
    it('reads a numeric member as its digits, so a PAN typed into a number field is refused', () => {
        expect(firstSecretShapedPath({ envelope: { limit: Number(TEST_PANS.mastercard) } })).toBe('envelope.limit');
        expect(firstSecretShapedPath({ envelope: { limit: BigInt(TEST_PANS.visa) } })).toBe('envelope.limit');
    });

    it('passes an envelope of ordinary values', () => {
        expect(firstSecretShapedPath({
            rail: 'AGENT_PAY_TOKEN',
            perTransactionLimit: 500,
            currency: 'EUR',
            periodBudget: 250_000,
            merchantCategoryCodes: [5411, '5812'],
            merchantDomains: ['shop.example'],
            expiresAt: '2027-11-11',
            tokenReference: 'tokref_7f3a9c',
        })).toBeNull();
    });
});
