/**
 * Config validation and the secret-bearing request paths must agree on which
 * hosts are Workday.
 *
 * ═══ THE BUG THIS EXISTS FOR ═══
 *
 * These two consumers used to read SEPARATE domain lists with identical
 * contents:
 *
 *   validateProviderConfig  → WORKDAY_HOSTS      (the config gate)
 *   assertWorkdayHost       → its own local copy (token exchange + roster read)
 *
 * Identical contents made the duplication look harmless. The failure is not the
 * state, it is the next EDIT, and both directions fail badly:
 *
 *   added to WORKDAY_HOSTS only → config accepts a host the roster read then
 *                                 refuses. Validates, then does not work.
 *   added to the local copy only → a host reaches a request carrying client
 *                                 credentials and a bearer token WITHOUT ever
 *                                 passing the schema meant to be the gate.
 *
 * `assertWorkdayHost` now delegates, so there is one list. This test is what
 * keeps that true: it asserts the two paths AGREE, not that a particular
 * implementation is used — so it fails on drift no matter how the drift is
 * introduced, including a well-meaning re-fork of the constant.
 */
import { assertWorkdayHost } from '@/app-layer/integrations/providers/workday/host';
import { validateProviderConfig } from '@/app-layer/integrations/config-schema';

/** Accepted by one path iff accepted by the other — that is the whole claim. */
const HOSTS: ReadonlyArray<readonly [string, boolean]> = [
    // Real Workday shapes.
    ['acme.workday.com', true],
    ['wd2-impl-services1.workday.com', true],
    ['workday.com', true],
    ['acme.workdaysuv.com', true],
    ['workdaysuv.com', true],
    // The lookalikes a naive endsWith would wave through.
    ['evil-workday.com', false],
    ['workday.com.attacker.net', false],
    // Outright off-domain, including the SSRF favourites.
    ['attacker.example', false],
    ['localhost', false],
    ['169.254.169.254', false],
    ['127.0.0.1', false],
];

function configAccepts(host: string): boolean {
    try {
        validateProviderConfig('workday', { host });
        return true;
    } catch {
        return false;
    }
}

function requestPathAccepts(host: string): boolean {
    try {
        assertWorkdayHost(host);
        return true;
    } catch {
        return false;
    }
}

describe('one Workday host list, read by both consumers', () => {
    it.each(HOSTS)('%s — config gate and request path agree', (host, expected) => {
        expect(configAccepts(host)).toBe(expected);
        expect(requestPathAccepts(host)).toBe(expected);
    });

    it('the table actually exercises both answers', () => {
        // A table that drifted to all-true or all-false would pass every case
        // above while proving nothing about disagreement.
        const accepted = HOSTS.filter(([, ok]) => ok).length;
        expect(accepted).toBeGreaterThan(0);
        expect(accepted).toBeLessThan(HOSTS.length);
    });

    it('a host added to the shared list reaches BOTH paths', () => {
        // The direct proof that they are one list rather than two that happen
        // to match: mutate the shared constant and watch both consumers move
        // together. If someone re-forks a local copy, only one moves and this
        // fails.
        const { WORKDAY_HOSTS } = jest.requireActual<typeof import('@/app-layer/integrations/allowed-host')>(
            '@/app-layer/integrations/allowed-host',
        );
        const suffixes = WORKDAY_HOSTS.suffixes as string[];
        suffixes.push('.wd-test-invariant.example');
        try {
            expect(configAccepts('acme.wd-test-invariant.example')).toBe(true);
            expect(requestPathAccepts('acme.wd-test-invariant.example')).toBe(true);
        } finally {
            const i = suffixes.indexOf('.wd-test-invariant.example');
            if (i >= 0) suffixes.splice(i, 1);
        }
        // And the removal really took effect, so the next test is not polluted.
        expect(requestPathAccepts('acme.wd-test-invariant.example')).toBe(false);
    });
});
