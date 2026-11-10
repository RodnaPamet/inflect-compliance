/**
 * THE GENERIC HIGH-ENTROPY EGRESS RULE, AND THE SCAN REFS IT USED TO REFUSE (#5012).
 *
 * The reference agent-harness scanner names a scan
 * `<estate>-<YYYYMMDD>T<HHMMSS>Z-<hex>`, and `get_discovered_agent` returns that
 * ref with every observation. The ref is one 37-character candidate whose only
 * upper case is the timestamp's `T` and `Z`, so every `discovered-agent-review`
 * run parked for a human review at its first READ (live, 2026-11-10).
 *
 * Both directions are asserted: the timestamp no longer supplies the upper case,
 * and a real secret that carries a timestamp-shaped run still fires.
 */
import { EGRESS_RULES } from '@/app-layer/ai/guard/patterns';

const RULE = EGRESS_RULES.find((r) => r.id === 'egr.high_entropy_secret.token');
const fires = (s: string): boolean => RULE!.test(s);

/** The exact scan ref that parked the first live discovered-agent review. */
const LIVE_SCAN_REF = 'inflect-own-20261109T074741Z-52a93bd5';

describe('egr.high_entropy_secret.token — scan refs', () => {
    it('the rule under test exists', () => {
        // Positive control: every assertion below is vacuous without it.
        expect(RULE).toBeDefined();
    });

    it('does not fire on the scan ref that parked the live run', () => {
        expect(fires(LIVE_SCAN_REF)).toBe(false);
    });

    it('does not fire on it inside the facts JSON it arrived in', () => {
        expect(
            fires(`{"observations":[{"scanRef":"${LIVE_SCAN_REF}","asOf":"2026-11-09T07:47:41.000Z"}]}`),
        ).toBe(false);
    });

    it.each([
        'customer-prod-estate-20270101T000000Z-0a1b2c3d',
        'acme-eu-west-20261231T235959123Z-ffeeddcc',
    ])('does not fire on other scan refs of the same shape: %s', (ref) => {
        expect(fires(ref)).toBe(false);
    });

    it('fires on the ref when something else in it supplies the upper case', () => {
        expect(fires('inflect-OWN-20261109T074741Z-52a93bd5')).toBe(true);
    });

    it('fires on a secret that merely contains a timestamp-shaped run', () => {
        expect(fires('aB3xK9pQ7rT2vW5y20261109T074741ZcE1gH4jL6nM0sU4dF9')).toBe(true);
    });

    it('still fires on a plain high-entropy token', () => {
        expect(fires('aB3xK9pQ7rT2vW5yZ8cE1gH4jL6nM0sU4dF9kR3t')).toBe(true);
    });
});
