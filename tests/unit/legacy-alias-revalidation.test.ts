/**
 * Step 4b: alias revalidation.
 *
 * The test this file exists for is the LEAVER INVARIANT — that an aliased
 * employee leaving does not suspend the alias, and that the account consequently
 * still resolves to the terminated person. Everything else here is a guard
 * around that one property.
 *
 * It is asserted twice, deliberately. Once on the verdict (`reason === null`),
 * which is cheap and local; and once THROUGH `reconcile()`, which is the claim
 * that actually matters — a verdict of "keep" is worth nothing if the surviving
 * list is then handed to the engine in a shape that fails to produce the link.
 * The first assertion would pass against a bug in `surviving`; the second would
 * not.
 */
import {
    reconcile,
    type CanonicalAccount,
    type RosterEmployee,
} from '@/lib/identity/reconcile/engine';
import {
    revalidateAliases,
    SUSPENSION_REASONS,
    type AliasUnderReview,
    type SuspensionReason,
} from '@/lib/identity/reconcile/alias-revalidation';

const CONFIRMED = '2026-06-01T12:00:00.000Z';
const NOW = '2026-10-09T00:00:00.000Z';

function emp(over: Partial<RosterEmployee> & { id: string }): RosterEmployee {
    return {
        fullName: 'Ada Lovelace',
        givenName: 'Ada',
        familyName: 'Lovelace',
        status: 'ACTIVE',
        ...over,
    };
}

function acct(over: Partial<CanonicalAccount> & { accountKey: string }): CanonicalAccount {
    return { createdAt: '2026-01-15', ...over };
}

function alias(over: Partial<AliasUnderReview> = {}): AliasUnderReview {
    return { accountKey: 'alovelace', employeeId: 'e1', confirmedAt: CONFIRMED, ...over };
}

describe('alias revalidation — the leaver invariant', () => {
    it('does NOT suspend when the aliased employee simply left', () => {
        const r = revalidateAliases({
            aliases: [alias()],
            accounts: [acct({ accountKey: 'alovelace' })],
            roster: [emp({ id: 'e1', status: 'TERMINATED', endDate: '2026-09-01' })],
        });

        expect(r.verdicts[0].reason).toBeNull();
        expect(r.suspensions).toEqual([]);
        expect(r.surviving).toEqual([{ accountKey: 'alovelace', employeeId: 'e1' }]);
    });

    it('and the surviving alias still links the account to the departed employee', () => {
        // THE point of the invariant. Through the engine, not through the
        // verdict: this is what makes the account a leaver finding instead of an
        // anonymous UNMATCHED row in the review queue.
        const roster = [emp({ id: 'e1', status: 'TERMINATED', endDate: '2026-09-01' })];
        const accounts = [acct({ accountKey: 'alovelace' })];
        const r = revalidateAliases({ aliases: [alias()], accounts, roster });

        const engine = reconcile({
            accounts,
            roster,
            directory: [],
            aliases: r.surviving,
            now: NOW,
        });

        const res = engine.resolutions.find((x) => x.accountKey === 'alovelace');
        expect(res?.outcome).toBe('LINKED');
        expect(res?.method).toBe('CONFIRMED_ALIAS');
        expect(res?.employeeId).toBe('e1');
    });

    it('a suspended alias is withheld from the engine on the SAME run', () => {
        // The ordering bug this guards: suspend the row, then hand the engine the
        // list you read before suspending, and the account resolves as
        // CONFIRMED_ALIAS on the very run that stopped trusting it.
        const roster: RosterEmployee[] = [];
        const accounts = [acct({ accountKey: 'alovelace' })];
        const r = revalidateAliases({ aliases: [alias()], accounts, roster });

        expect(r.suspensions).toHaveLength(1);
        expect(r.surviving).toEqual([]);

        const engine = reconcile({ accounts, roster, directory: [], aliases: r.surviving, now: NOW });
        expect(engine.resolutions.find((x) => x.accountKey === 'alovelace')?.method)
            .not.toBe('CONFIRMED_ALIAS');
    });
});

describe('alias revalidation — each suspension trigger', () => {
    it('HR_RECORD_VANISHED when the employee id is off the roster', () => {
        const r = revalidateAliases({
            aliases: [alias()],
            accounts: [acct({ accountKey: 'alovelace' })],
            roster: [emp({ id: 'someone-else' })],
        });
        expect(r.verdicts[0].reason).toBe<SuspensionReason>('HR_RECORD_VANISHED');
    });

    it('HR_RECORD_REKEYED when the terminated record has a successor', () => {
        const r = revalidateAliases({
            aliases: [alias()],
            accounts: [acct({ accountKey: 'alovelace' })],
            roster: [
                emp({ id: 'e1', status: 'TERMINATED', endDate: '2026-09-01' }),
                // Same name, starts after the predecessor left — the engine's
                // definition of a re-key.
                emp({ id: 'e2', status: 'ACTIVE', startDate: '2026-09-15' }),
            ],
        });
        expect(r.verdicts[0].reason).toBe<SuspensionReason>('HR_RECORD_REKEYED');
        expect(r.verdicts[0].detail).toContain('e2');
    });

    it('ACCOUNT_RECREATED when the account postdates its own confirmation', () => {
        const r = revalidateAliases({
            aliases: [alias({ confirmedAt: CONFIRMED })],
            // Created AFTER the reviewer confirmed it — impossible unless remade.
            accounts: [acct({ accountKey: 'alovelace', createdAt: '2026-08-20' })],
            roster: [emp({ id: 'e1' })],
        });
        expect(r.verdicts[0].reason).toBe<SuspensionReason>('ACCOUNT_RECREATED');
    });

    it('ACCOUNT_POSTDATES_EMPLOYMENT_END when an end date is backdated after the fact', () => {
        // Passed at confirmation time and fails now, which is the case a one-off
        // check at confirmation would never catch.
        const r = revalidateAliases({
            aliases: [alias()],
            accounts: [acct({ accountKey: 'alovelace', createdAt: '2026-05-10' })],
            roster: [emp({ id: 'e1', status: 'TERMINATED', endDate: '2026-04-01' })],
        });
        expect(r.verdicts[0].reason).toBe<SuspensionReason>('ACCOUNT_POSTDATES_EMPLOYMENT_END');
    });

    it('every reason the function can emit is in SUSPENSION_REASONS', () => {
        // Keeps the exported list honest — it is what the write path and the
        // metrics range over, and a reason missing from it would be a suspension
        // nobody could count.
        const emitted = new Set<string>();
        const cases: Array<() => void> = [
            () => emitted.add(String(revalidateAliases({
                aliases: [alias()], accounts: [], roster: [],
            }).verdicts[0].reason)),
            () => emitted.add(String(revalidateAliases({
                aliases: [alias()],
                accounts: [acct({ accountKey: 'alovelace', createdAt: '2026-08-20' })],
                roster: [emp({ id: 'e1' })],
            }).verdicts[0].reason)),
            () => emitted.add(String(revalidateAliases({
                aliases: [alias()],
                accounts: [acct({ accountKey: 'alovelace', createdAt: '2026-05-10' })],
                roster: [emp({ id: 'e1', status: 'TERMINATED', endDate: '2026-04-01' })],
            }).verdicts[0].reason)),
            () => emitted.add(String(revalidateAliases({
                aliases: [alias()],
                accounts: [acct({ accountKey: 'alovelace' })],
                roster: [
                    emp({ id: 'e1', status: 'TERMINATED', endDate: '2026-09-01' }),
                    emp({ id: 'e2', status: 'ACTIVE', startDate: '2026-09-15' }),
                ],
            }).verdicts[0].reason)),
        ];
        cases.forEach((c) => c());

        expect([...emitted].sort()).toEqual([...SUSPENSION_REASONS].sort());
    });
});

describe('alias revalidation — what must NOT trigger', () => {
    it('an account absent from this snapshot keeps its alias', () => {
        const r = revalidateAliases({
            aliases: [alias()],
            accounts: [],
            roster: [emp({ id: 'e1' })],
        });
        expect(r.verdicts[0].reason).toBeNull();
    });

    it('a source that carries no createdAt produces no suspension', () => {
        // The fail-safe direction: absent data is not evidence of recreation.
        const r = revalidateAliases({
            aliases: [alias()],
            accounts: [acct({ accountKey: 'alovelace', createdAt: null })],
            roster: [emp({ id: 'e1', status: 'TERMINATED', endDate: '2020-01-01' })],
        });
        expect(r.verdicts[0].reason).toBeNull();
    });

    it('an account predating the employment start is NOT suspended', () => {
        // Deliberate: contractor conversions and re-used logins are routine, the
        // engine does not veto on it, and suspending would send a large correct
        // population back to a human queue.
        const r = revalidateAliases({
            aliases: [alias()],
            accounts: [acct({ accountKey: 'alovelace', createdAt: '2025-01-01' })],
            roster: [emp({ id: 'e1', startDate: '2026-03-01' })],
        });
        expect(r.verdicts[0].reason).toBeNull();
    });

    it('two namesakes with overlapping tenure are not a re-key, so a departure stays a departure', () => {
        // The engine requires the successor to start at or after the predecessor
        // ended. Overlapping means two people, not one re-keyed person — and
        // getting this wrong would suspend a genuine leaver's alias.
        const r = revalidateAliases({
            aliases: [alias()],
            accounts: [acct({ accountKey: 'alovelace' })],
            roster: [
                emp({ id: 'e1', status: 'TERMINATED', endDate: '2026-09-01' }),
                emp({ id: 'e2', status: 'ACTIVE', startDate: '2026-01-01' }),
            ],
        });
        expect(r.verdicts[0].reason).toBeNull();
    });
});

describe('alias revalidation — determinism', () => {
    it('the verdict for an alias does not depend on roster or alias order', () => {
        const roster = [
            emp({ id: 'e1', status: 'TERMINATED', endDate: '2026-09-01' }),
            emp({ id: 'e2', status: 'ACTIVE', startDate: '2026-09-15' }),
            emp({ id: 'e3', fullName: 'Grace Hopper', givenName: 'Grace', familyName: 'Hopper' }),
        ];
        const aliases = [alias(), alias({ accountKey: 'ghopper', employeeId: 'e3' })];
        const accounts = [
            acct({ accountKey: 'alovelace' }),
            acct({ accountKey: 'ghopper' }),
        ];

        const forward = revalidateAliases({ aliases, accounts, roster });
        const reversed = revalidateAliases({
            aliases: [...aliases].reverse(),
            accounts: [...accounts].reverse(),
            roster: [...roster].reverse(),
        });

        const key = (vs: typeof forward.verdicts) =>
            [...vs].sort((a, b) => a.accountKey.localeCompare(b.accountKey))
                .map((v) => `${v.accountKey}:${v.reason}`);

        expect(key(reversed.verdicts)).toEqual(key(forward.verdicts));
    });

    it('verdicts are returned in input order, one per alias', () => {
        const aliases = [
            alias({ accountKey: 'a', employeeId: 'e1' }),
            alias({ accountKey: 'b', employeeId: 'gone' }),
            alias({ accountKey: 'c', employeeId: 'e1' }),
        ];
        const r = revalidateAliases({
            aliases,
            accounts: [acct({ accountKey: 'a' }), acct({ accountKey: 'b' }), acct({ accountKey: 'c' })],
            roster: [emp({ id: 'e1' })],
        });
        expect(r.verdicts.map((v) => v.accountKey)).toEqual(['a', 'b', 'c']);
        expect(r.verdicts.map((v) => v.reason)).toEqual([null, 'HR_RECORD_VANISHED', null]);
    });
});
