/**
 * Step 3b's acceptance test: the engine's precision is a gate, its recall is a
 * report.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY PRECISION GATES AND RECALL DOES NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A missed link costs a reviewer half a minute. A wrong link grants one person
 * another person's access and then records a human approving it, because the
 * recertification campaign presents an auto-link as settled fact. The two
 * errors are not comparable, so they are not tested the same way: a single
 * false `LINKED` fails this suite, and recall is printed for a human to read.
 *
 * Gating recall would be actively harmful. The honest response to a tightened
 * precision rule is fewer links, and a recall gate would make that look like a
 * regression — so the engine would be pushed back toward linking on weaker
 * evidence by the test suite itself.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT "100 % PRECISION" MEANS HERE, AND WHAT IT DOES NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Step 3b has no name matching — that is Step 4a — so most corpus cases whose
 * expectation is `SUGGESTED` via a name resolve to `UNMATCHED` today. That is
 * not a failure, and this suite must not pretend otherwise. It therefore
 * asserts:
 *
 *   - of the accounts the engine DID link, every one is the link the corpus
 *     expects (precision), and
 *   - the three cases the corpus expects to link via a strong signal DO link,
 *     so the gate cannot be satisfied by linking nothing.
 *
 * That second half is the one that matters. A precision ratchet with no floor
 * is passed trivially by an engine that never links, which is the failure mode
 * of every precision-only gate.
 */

import {
    reconcile,
    strengthOf,
    ALL_SIGNAL_KINDS,
    STRONG_SIGNAL_KINDS,
    SUPPORTING_SIGNAL_KINDS,
    COMPARISON_BUDGET_MULTIPLE,
    type CanonicalAccount,
    type RosterEmployee,
    type DirectoryAccount,
    type EngineInput,
    type Outcome,
    type SupportingSignal,
    type CandidateScorer,
    DuplicateRosterIdError,
} from '@/lib/identity/reconcile/engine';
import { CORPUS, type CorpusCase } from '../fixtures/identity-reconcile/corpus';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// ─── Helpers ───────────────────────────────────────────────────────────────

const NOW = '2026-10-08T00:00:00.000Z';

function inputFor(c: CorpusCase): EngineInput {
    return {
        accounts: [c.account as CanonicalAccount],
        roster: c.hr as readonly RosterEmployee[],
        directory: c.directory as readonly DirectoryAccount[],
        aliases: [],
        now: NOW,
    };
}

function runCase(c: CorpusCase) {
    const r = reconcile(inputFor(c));
    expect(r.resolutions).toHaveLength(1);
    return r.resolutions[0];
}

/**
 * The corpus's per-case `hr` slices, merged into ONE roster.
 *
 * Deduplicated by id, because the corpus is deliberately per-case and the same
 * id appears with different fields across cases — `e-100` three ways, `e-104`
 * two. Concatenating them yields a roster that contradicts itself about one
 * person, which is not a roster any caller has: ids come from a primary key.
 *
 * This helper exists because the first version of the order-independence test
 * concatenated them and failed, correctly — the engine's answer for `tlee` and
 * `tlee2` depended on which `e-104` happened to land in the index last. The
 * engine now refuses such a roster outright
 * ({@link DuplicateRosterIdError}); this keeps the fixture honest.
 */
function combinedRoster(): RosterEmployee[] {
    const byId = new Map<string, RosterEmployee>();
    for (const c of CORPUS) {
        for (const e of c.hr as readonly RosterEmployee[]) {
            if (!byId.has(e.id)) byId.set(e.id, e);
        }
    }
    return [...byId.values()];
}

/** A seeded LCG. `Math.random` would make a failure unreproducible. */
function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

function shuffled<T>(xs: readonly T[], rand: () => number): T[] {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// ─── 1. Precision on the corpus, with a floor ──────────────────────────────

describe('RQ-3b precision — the gate', () => {
    it('links nothing the corpus does not expect linked, and reports recall', () => {
        const expectedLinks = CORPUS.filter((c) => c.expected.outcome === 'LINKED');
        // The denominator, printed so a shrinking corpus cannot quietly weaken
        // the gate while the assertion still passes.
        expect(expectedLinks.length).toBeGreaterThan(0);

        const falseLinks: string[] = [];
        const correctLinks: string[] = [];
        const outcomes = new Map<string, Outcome>();

        for (const c of CORPUS) {
            const res = runCase(c);
            outcomes.set(c.id, res.outcome);
            if (res.outcome !== 'LINKED') continue;

            const right =
                c.expected.outcome === 'LINKED' && c.expected.employeeId === res.employeeId;
            if (right) correctLinks.push(c.id);
            else {
                falseLinks.push(
                    `${c.id}: linked ${res.employeeId} via ${res.method}; corpus expects ` +
                        `${c.expected.outcome} ${c.expected.employeeId ?? '(nobody)'} — ${c.why}`
                );
            }
        }

        const exact = CORPUS.filter((c) => outcomes.get(c.id) === c.expected.outcome).length;
        console.log(
            [
                '',
                '  ── Step 3b engine over the Step 3a corpus ──',
                `  cases                 ${CORPUS.length}`,
                `  auto-links made       ${correctLinks.length + falseLinks.length}`,
                `  false links           ${falseLinks.length}   (GATED: must be 0)`,
                `  expected links hit    ${correctLinks.length}/${expectedLinks.length}   (GATED: must be all)`,
                `  outcome matches       ${exact}/${CORPUS.length}   (reported; name matching is Step 4a)`,
                '',
            ].join('\n')
        );

        expect(falseLinks).toEqual([]);
    });

    it('links every case the corpus expects linked, so the gate has a floor', () => {
        // Without this, an engine that links NOTHING passes the precision gate.
        for (const c of CORPUS.filter((x) => x.expected.outcome === 'LINKED')) {
            const res = runCase(c);
            expect({ id: c.id, outcome: res.outcome, employeeId: res.employeeId }).toEqual({
                id: c.id,
                outcome: 'LINKED',
                employeeId: c.expected.employeeId,
            });
        }
    });

    it('resolves every account to exactly one outcome', () => {
        const r = reconcile({
            accounts: CORPUS.map((c) => c.account as CanonicalAccount),
            roster: combinedRoster(),
            directory: CORPUS.flatMap((c) => c.directory as readonly DirectoryAccount[]),
            aliases: [],
            now: NOW,
        });
        expect(r.resolutions).toHaveLength(CORPUS.length);
        expect(r.resolutions.map((x) => x.accountKey)).toEqual(
            CORPUS.map((c) => c.account.accountKey)
        );
    });
});

// ─── 2. No combination of supporting signals ever links ────────────────────

describe('RQ-3b — supporting signals cannot link, exhaustively', () => {
    const person: RosterEmployee = { id: 'e-1', fullName: 'Ada Nwosu', status: 'ACTIVE' };
    const other: RosterEmployee = { id: 'e-2', fullName: 'Bea Svcic', status: 'ACTIVE' };
    const account: CanonicalAccount = { accountKey: 'anwosu', displayName: 'Ada Nwosu' };

    /** Every non-empty subset of the supporting kinds: 2^n - 1. */
    const subsets: ReadonlyArray<readonly string[]> = (() => {
        const kinds = [...SUPPORTING_SIGNAL_KINDS];
        const out: string[][] = [];
        for (let mask = 1; mask < 1 << kinds.length; mask++) {
            out.push(kinds.filter((_, i) => mask & (1 << i)));
        }
        return out;
    })();

    it('covers every subset, and the count is stated', () => {
        expect(SUPPORTING_SIGNAL_KINDS.length).toBeGreaterThanOrEqual(7);
        expect(subsets).toHaveLength(2 ** SUPPORTING_SIGNAL_KINDS.length - 1);
    });

    it('never yields LINKED, at any score, for one candidate or two', () => {
        const linked: string[] = [];
        let evaluated = 0;

        for (const subset of subsets) {
            // Scores far above every strong signal's weight. If the engine
            // summed and thresholded, this would link; it must not.
            const scorer: CandidateScorer = () =>
                subset.map(
                    (kind) =>
                        ({ kind, score: 10_000, evidence: 'synthetic' }) as SupportingSignal
                );

            for (const roster of [[person], [person, other]]) {
                const r = reconcile({
                    accounts: [account],
                    roster,
                    directory: [],
                    aliases: [],
                    now: NOW,
                    config: { scorers: [scorer] },
                });
                evaluated += 1;
                const res = r.resolutions[0];
                if (res.outcome === 'LINKED') {
                    linked.push(`${subset.join('+')} (roster ${roster.length}) -> ${res.method}`);
                }
            }
        }

        // The denominator, so an empty selection cannot pass as a clean sweep.
        expect(evaluated).toBe(subsets.length * 2);
        expect(linked).toEqual([]);
    });

    it('classifies every signal kind, so a new kind cannot default to strong', () => {
        for (const k of ALL_SIGNAL_KINDS) {
            expect(['STRONG', 'SUPPORTING']).toContain(strengthOf(k));
        }
        expect(STRONG_SIGNAL_KINDS).toEqual([
            'CONFIRMED_ALIAS',
            'EMPLOYEE_NUMBER',
            'EMAIL_EXACT',
            'DIRECTORY_BRIDGE',
        ]);
    });
});

// ─── 3. Any veto prevents a link to the vetoed candidate ───────────────────

describe('RQ-3b — every veto beats every strong signal', () => {
    /**
     * One strong signal per row, paired with each veto. The strong signal alone
     * must link; with the veto it must not. Both halves are asserted, so a
     * veto that "works" only because the signal never fired is caught.
     */
    const strongSetups: ReadonlyArray<{
        readonly name: string;
        readonly account: CanonicalAccount;
        readonly employee: RosterEmployee;
        readonly directory?: readonly DirectoryAccount[];
        readonly aliases?: readonly { accountKey: string; employeeId: string }[];
    }> = [
        {
            name: 'EMAIL_EXACT',
            account: { accountKey: 'anwosu', email: 'ada@corp.example.test' },
            employee: {
                id: 'e-1',
                fullName: 'Ada Nwosu',
                status: 'ACTIVE',
                workEmail: 'ada@corp.example.test',
            },
        },
        {
            name: 'EMPLOYEE_NUMBER',
            account: { accountKey: '004711' },
            employee: {
                id: 'e-1',
                fullName: 'Ada Nwosu',
                status: 'ACTIVE',
                employeeNumber: '4711',
            },
        },
        {
            name: 'DIRECTORY_BRIDGE',
            account: { accountKey: 'anwosu' },
            employee: { id: 'e-1', fullName: 'Ada Nwosu', status: 'ACTIVE' },
            directory: [
                {
                    connectionId: 'c-1',
                    email: 'ada@corp.example.test',
                    samAccountName: 'anwosu',
                    linkFresh: true,
                    linkedEmployeeId: 'e-1',
                },
            ],
        },
        {
            name: 'CONFIRMED_ALIAS',
            account: { accountKey: 'anwosu' },
            employee: { id: 'e-1', fullName: 'Ada Nwosu', status: 'ACTIVE' },
            aliases: [{ accountKey: 'anwosu', employeeId: 'e-1' }],
        },
    ];

    const vetoMakers: ReadonlyArray<{
        readonly kind: string;
        readonly apply: (a: CanonicalAccount, e: RosterEmployee) => [CanonicalAccount, RosterEmployee];
    }> = [
        {
            kind: 'EMPLOYEE_NUMBER_CONFLICT',
            apply: (a, e) => [
                { ...a, employeeNumber: '9999' },
                { ...e, employeeNumber: e.employeeNumber ?? '1111' },
            ],
        },
        {
            kind: 'EMAIL_DOMAIN_CONFLICT',
            apply: (a, e) => [
                { ...a, email: 'someone.else@corp.example.test' },
                { ...e, workEmail: 'ada@corp.example.test' },
            ],
        },
        {
            kind: 'ACCOUNT_POSTDATES_END_DATE',
            apply: (a, e) => [
                { ...a, createdAt: '2026-01-01' },
                { ...e, endDate: '2024-01-01', status: 'TERMINATED' as const },
            ],
        },
    ];

    it.each(strongSetups.map((s) => [s.name, s] as const))(
        '%s links on its own (the control for the veto cases)',
        (_name, setup) => {
            const r = reconcile({
                accounts: [setup.account],
                roster: [setup.employee],
                directory: setup.directory ?? [],
                aliases: setup.aliases ?? [],
                now: NOW,
            });
            expect(r.resolutions[0].outcome).toBe('LINKED');
            expect(r.resolutions[0].employeeId).toBe('e-1');
        }
    );

    it('every (strong signal × veto) pair refuses to link to the vetoed candidate', () => {
        const checked: string[] = [];
        for (const setup of strongSetups) {
            for (const veto of vetoMakers) {
                const [account, employee] = veto.apply(setup.account, setup.employee);
                const r = reconcile({
                    accounts: [account],
                    roster: [employee],
                    directory: setup.directory ?? [],
                    aliases: setup.aliases ?? [],
                    now: NOW,
                });
                const res = r.resolutions[0];
                checked.push(`${setup.name}×${veto.kind}`);
                // Not LINKED to the vetoed candidate. The outcome may be
                // SUGGESTED or UNMATCHED; what is forbidden is an auto-link.
                expect({
                    pair: `${setup.name}×${veto.kind}`,
                    linkedTo: res.outcome === 'LINKED' ? res.employeeId : null,
                }).toEqual({ pair: `${setup.name}×${veto.kind}`, linkedTo: null });
            }
        }
        expect(checked).toHaveLength(strongSetups.length * vetoMakers.length);
    });
});

// ─── 4. Ties on the strongest signal ───────────────────────────────────────

describe('RQ-3b — a tie is AMBIGUOUS, never a pick', () => {
    it('two candidates with the same exact email yield AMBIGUOUS', () => {
        const r = reconcile({
            accounts: [{ accountKey: 'shared', email: 'shared@corp.example.test' }],
            roster: [
                {
                    id: 'e-1',
                    fullName: 'Ada One',
                    status: 'ACTIVE',
                    workEmail: 'shared@corp.example.test',
                },
                {
                    id: 'e-2',
                    fullName: 'Bea Two',
                    status: 'ACTIVE',
                    workEmail: 'shared@corp.example.test',
                },
            ],
            directory: [],
            aliases: [],
            now: NOW,
        });
        expect(r.resolutions[0].outcome).toBe('AMBIGUOUS');
        expect(r.resolutions[0].employeeId).toBeNull();
        expect(r.resolutions[0].method).toBe('STRONG_SIGNAL_TIE');
    });

    it('two candidates with the same employee number yield AMBIGUOUS', () => {
        const r = reconcile({
            accounts: [{ accountKey: '004711' }],
            roster: [
                { id: 'e-1', fullName: 'Ada One', status: 'ACTIVE', employeeNumber: '4711' },
                { id: 'e-2', fullName: 'Bea Two', status: 'ACTIVE', employeeNumber: '04711' },
            ],
            directory: [],
            aliases: [],
            now: NOW,
        });
        expect(r.resolutions[0].outcome).toBe('AMBIGUOUS');
        expect(r.resolutions[0].employeeId).toBeNull();
    });
});

// ─── 5. Order independence ─────────────────────────────────────────────────

describe('RQ-3b — no result depends on input order', () => {
    const accounts = CORPUS.map((c) => c.account as CanonicalAccount);
    const roster = combinedRoster();
    const directory = CORPUS.flatMap((c) => c.directory as readonly DirectoryAccount[]);

    /**
     * Sorts on the WHOLE row, not on `accountKey`.
     *
     * Four corpus cases share the key `jjones` (`lf-01`, `db-01`, `db-02`,
     * `db-03`), so `accountKey` is not a total order over this population and
     * sorting by it alone leaves equal-keyed rows in arrival order — which
     * made this test fail while the engine was right: the multiset of
     * resolutions was identical and only the order among the four `jjones`
     * rows moved. Exactly the defect the engine's own candidate comparator
     * documents, committed one level up in the test that checks for it.
     */
    function canonical(input: EngineInput): string {
        const r = reconcile(input);
        const rows = r.resolutions.map((x) =>
            JSON.stringify({
                accountKey: x.accountKey,
                outcome: x.outcome,
                employeeId: x.employeeId,
                method: x.method,
            })
        );
        return JSON.stringify([...rows].sort());
    }

    it('is unchanged when accounts AND roster are shuffled, over many seeds', () => {
        const reference = canonical({ accounts, roster, directory, aliases: [], now: NOW });
        for (let seed = 1; seed <= 24; seed++) {
            const rand = lcg(seed);
            const got = canonical({
                accounts: shuffled(accounts, rand),
                roster: shuffled(roster, rand),
                directory: shuffled(directory, rand),
                aliases: [],
                now: NOW,
            });
            expect({ seed, got }).toEqual({ seed, got: reference });
        }
    });
});

// ─── 6. The re-keyed person rule ───────────────────────────────────────────

describe('RQ-3b — a strong signal onto a terminated record suggests, never links', () => {
    const terminated: RosterEmployee = {
        id: 'e-400',
        fullName: 'Ada Nwosu',
        workEmail: 'ada.old@example.test',
        status: 'TERMINATED',
        startDate: '2018-05-01',
        endDate: '2024-01-31',
    };
    const successor: RosterEmployee = {
        id: 'e-401',
        fullName: 'Ada Nwosu',
        workEmail: 'ada.nwosu@example.test',
        status: 'ACTIVE',
        startDate: '2024-02-01',
    };
    const account: CanonicalAccount = {
        accountKey: 'aold',
        email: 'ada.old@example.test',
        displayName: 'Ada Nwosu',
    };

    it('suggests the successor rather than linking the terminated record', () => {
        const r = reconcile({
            accounts: [account],
            roster: [terminated, successor],
            directory: [],
            aliases: [],
            now: NOW,
        });
        const res = r.resolutions[0];
        expect(res.outcome).toBe('SUGGESTED');
        expect(res.employeeId).toBe('e-401');
        expect(res.method).toBe('REKEYED_PERSON_RULE');
    });

    it('holds for EVERY strong signal, not just the email it was written for', () => {
        const byNumber = reconcile({
            accounts: [{ accountKey: '004711', displayName: 'Ada Nwosu' }],
            roster: [{ ...terminated, employeeNumber: '4711' }, successor],
            directory: [],
            aliases: [],
            now: NOW,
        });
        expect(byNumber.resolutions[0].outcome).toBe('SUGGESTED');

        const byAlias = reconcile({
            accounts: [{ accountKey: 'aold', displayName: 'Ada Nwosu' }],
            roster: [terminated, successor],
            directory: [],
            aliases: [{ accountKey: 'aold', employeeId: 'e-400' }],
            now: NOW,
        });
        expect(byAlias.resolutions[0].outcome).toBe('SUGGESTED');
    });

    it('still refuses to link when there is no successor to suggest', () => {
        // The rule is not "redirect to the successor"; it is "do not link a
        // terminated record". With nobody to redirect to it must still refuse.
        const r = reconcile({
            accounts: [account],
            roster: [terminated],
            directory: [],
            aliases: [],
            now: NOW,
        });
        expect(r.resolutions[0].outcome).toBe('SUGGESTED');
        expect(r.resolutions[0].outcome).not.toBe('LINKED');
    });

    it('does not treat two concurrent namesakes as a re-key', () => {
        const concurrent: RosterEmployee = { ...successor, startDate: '2019-01-01' };
        const r = reconcile({
            accounts: [account],
            roster: [terminated, concurrent],
            directory: [],
            aliases: [],
            now: NOW,
        });
        // No successor identified, so no redirect — and still no link.
        expect(r.resolutions[0].outcome).not.toBe('LINKED');
        expect(r.resolutions[0].employeeId).toBe('e-400');
    });
});

// ─── 7. One login in two connections is no bridge ──────────────────────────

describe('RQ-3b — the directory bridge requires exactly one connection', () => {
    const base = {
        accounts: [{ accountKey: 'jjones', displayName: 'Jones, Jamie' }],
        roster: [
            { id: 'e-100', fullName: 'Jamie Jones', status: 'ACTIVE' as const },
            { id: 'e-102', fullName: 'Jordan Jones', status: 'ACTIVE' as const },
        ],
        aliases: [],
        now: NOW,
    };

    it('links on one fresh link in one connection (the control)', () => {
        const r = reconcile({
            ...base,
            roster: [base.roster[0]],
            directory: [
                {
                    connectionId: 'c-1',
                    email: 'jamie.jones@example.test',
                    samAccountName: 'jjones',
                    linkFresh: true,
                    linkedEmployeeId: 'e-100',
                },
            ],
        });
        expect(r.resolutions[0].outcome).toBe('LINKED');
        expect(r.resolutions[0].method).toBe('DIRECTORY_BRIDGE');
    });

    it('produces NO bridge when the same sAMAccountName is in two connections', () => {
        const r = reconcile({
            ...base,
            directory: [
                {
                    connectionId: 'c-1',
                    email: 'jamie.jones@example.test',
                    samAccountName: 'jjones',
                    linkFresh: true,
                    linkedEmployeeId: 'e-100',
                },
                {
                    connectionId: 'c-2',
                    email: 'jordan.jones@example.test',
                    samAccountName: 'jjones',
                    linkFresh: true,
                    linkedEmployeeId: 'e-102',
                },
            ],
        });
        const res = r.resolutions[0];
        expect(res.outcome).not.toBe('LINKED');
        expect(
            res.candidates.flatMap((c) => c.signals.map((s) => s.kind))
        ).not.toContain('DIRECTORY_BRIDGE');
    });

    it('produces no bridge from a stale link', () => {
        const r = reconcile({
            ...base,
            roster: [base.roster[0]],
            directory: [
                {
                    connectionId: 'c-1',
                    email: 'jamie.jones@example.test',
                    samAccountName: 'jjones',
                    linkFresh: false,
                    linkedEmployeeId: 'e-100',
                },
            ],
        });
        const res = r.resolutions[0];
        expect(res.outcome).not.toBe('LINKED');
        expect(res.candidates[0].signals.map((s) => s.kind)).toContain('STALE_DIRECTORY_LINK');
    });
});

// ─── 8. Comparisons stay within the stated budget ──────────────────────────

describe('RQ-3b — blocking keeps comparisons within the stated budget', () => {
    it('stays within COMPARISON_BUDGET_MULTIPLE at scale, counted not timed', () => {
        const N = 2000;
        const accounts: CanonicalAccount[] = [];
        const roster: RosterEmployee[] = [];
        for (let i = 0; i < N; i++) {
            accounts.push({
                accountKey: `user${i}`,
                email: `user${i}@corp.example.test`,
                displayName: `User ${i}`,
            });
            roster.push({
                id: `e-${i}`,
                fullName: `User ${i}`,
                workEmail: `user${i}@corp.example.test`,
                status: 'ACTIVE',
                employeeNumber: String(100000 + i),
            });
        }

        const r = reconcile({ accounts, roster, directory: [], aliases: [], now: NOW });
        const budget = COMPARISON_BUDGET_MULTIPLE * (accounts.length + roster.length);

        console.log(
            `  blocking: ${r.metrics.comparisons} comparisons for ${N} accounts × ${N} roster ` +
                `(budget ${budget}, cross product would be ${N * N})`
        );

        expect(r.metrics.comparisons).toBeLessThanOrEqual(budget);
        // And the budget must be doing work: a cross product would blow it.
        expect(budget).toBeLessThan(N * N);
        expect(r.metrics.accounts).toBe(N);
        expect(r.resolutions).toHaveLength(N);
    });

    it('instruments comparisons rather than leaving them unmeasured', () => {
        const r = reconcile({
            accounts: [{ accountKey: 'a', email: 'a@x.test' }],
            roster: [{ id: 'e-1', fullName: 'A', status: 'ACTIVE', workEmail: 'a@x.test' }],
            directory: [],
            aliases: [],
            now: NOW,
        });
        expect(r.metrics.comparisons).toBe(1);
        expect(r.metrics.blockedAccounts).toBe(1);
    });

    it('does no comparisons for an account that blocks to nobody', () => {
        const r = reconcile({
            accounts: [{ accountKey: 'nobody', email: 'nobody@elsewhere.test' }],
            roster: [{ id: 'e-1', fullName: 'A', status: 'ACTIVE', workEmail: 'a@x.test' }],
            directory: [],
            aliases: [],
            now: NOW,
        });
        expect(r.metrics.comparisons).toBe(0);
        expect(r.metrics.blockedAccounts).toBe(0);
        expect(r.resolutions[0].method).toBe('NO_CANDIDATES');
    });
});

// ─── 9. Byte-identical output ──────────────────────────────────────────────

describe('RQ-3b — identical inputs produce byte-identical output', () => {
    it('is stable across repeated runs', () => {
        const input: EngineInput = {
            accounts: CORPUS.map((c) => c.account as CanonicalAccount),
            roster: combinedRoster(),
            directory: CORPUS.flatMap((c) => c.directory as readonly DirectoryAccount[]),
            aliases: [],
            now: NOW,
        };
        const a = JSON.stringify(reconcile(input));
        const b = JSON.stringify(reconcile(input));
        expect(a).toBe(b);
        expect(a.length).toBeGreaterThan(0);
    });
});

// ─── 10. The module reaches no database ────────────────────────────────────

describe('RQ-3b — the engine imports nothing that touches the database', () => {
    it('has no db import anywhere in its transitive local graph', () => {
        const root = path.join(process.cwd(), 'src/lib/identity/reconcile/engine.ts');
        const seen = new Set<string>();
        const forbidden: string[] = [];
        const imports: string[] = [];
        // Matched against IMPORT SPECIFIERS, never raw text. A text scan would
        // fire on this module's own docblock, which cites
        // `db/concurrency-limits.ts` for its budget reasoning — a mention of a
        // path is not a dependency on it.
        const FORBIDDEN = [
            /^@prisma\/client/,
            /^@\/lib\/prisma$/,
            /^@\/lib\/db-context$/,
            /^@\/lib\/db\//,
            /^\.\.?\/.*\bprisma\b/,
        ];

        const walk = (file: string): void => {
            if (seen.has(file)) return;
            seen.add(file);
            const src = readFileSync(file, 'utf8');
            // Every import/export specifier, bare or relative.
            const specRe = /(?:from|require\()\s*'([^']+)'/g;
            let sm: RegExpExecArray | null;
            while ((sm = specRe.exec(src))) {
                const spec = sm[1];
                imports.push(`${path.relative(process.cwd(), file)} -> ${spec}`);
                if (FORBIDDEN.some((re) => re.test(spec))) {
                    forbidden.push(`${path.relative(process.cwd(), file)} -> ${spec}`);
                }
            }
            const re = /from\s+'(\.[^']+|@\/[^']+)'/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(src))) {
                const spec = m[1];
                const abs = spec.startsWith('@/')
                    ? path.join(process.cwd(), 'src', spec.slice(2))
                    : path.resolve(path.dirname(file), spec);
                for (const cand of [`${abs}.ts`, `${abs}.tsx`, path.join(abs, 'index.ts')]) {
                    try {
                        readFileSync(cand, 'utf8');
                        walk(cand);
                        break;
                    } catch {
                        // not this extension; try the next
                    }
                }
            }
        };

        walk(root);
        // The walk must have actually traversed, or an empty graph passes.
        expect(seen.size).toBeGreaterThan(1);
        // And it must have SEEN specifiers, or a regex that matches nothing
        // reads as a clean result.
        expect(imports.length).toBeGreaterThan(0);
        expect(forbidden).toEqual([]);

        // Positive control: the patterns do discriminate.
        expect(FORBIDDEN.some((re) => re.test('@prisma/client'))).toBe(true);
        expect(FORBIDDEN.some((re) => re.test('@/lib/db-context'))).toBe(true);
        expect(FORBIDDEN.some((re) => re.test('./normalise'))).toBe(false);
    });
});

// ─── 11. A self-contradicting roster is refused, not silently resolved ─────

describe('RQ-3b — a roster that contradicts itself about one person is refused', () => {
    const account: CanonicalAccount = { accountKey: 'tlee', email: 'tess.lee@example.test' };

    it('throws on one id carrying two different records', () => {
        // The exact shape that made this suite fail: same id, different email.
        const roster: RosterEmployee[] = [
            {
                id: 'e-104',
                fullName: 'Tess Lee',
                status: 'ACTIVE',
                workEmail: 'tess.lee@example.test',
            },
            {
                id: 'e-104',
                fullName: 'Tess Lee',
                status: 'ACTIVE',
                workEmail: 'zz-corpus-tess@gmail.com',
            },
        ];
        expect(() =>
            reconcile({ accounts: [account], roster, directory: [], aliases: [], now: NOW })
        ).toThrow(DuplicateRosterIdError);
    });

    it('names the offending id, so the caller can fix the snapshot', () => {
        const roster: RosterEmployee[] = [
            { id: 'e-1', fullName: 'A One', status: 'ACTIVE', workEmail: 'a@x.test' },
            { id: 'e-1', fullName: 'A Two', status: 'ACTIVE', workEmail: 'b@x.test' },
        ];
        try {
            reconcile({ accounts: [account], roster, directory: [], aliases: [], now: NOW });
            throw new Error('expected a DuplicateRosterIdError');
        } catch (e) {
            expect(e).toBeInstanceOf(DuplicateRosterIdError);
            expect((e as DuplicateRosterIdError).duplicateIds).toEqual(['e-1']);
            expect((e as Error).message).toContain('primary key');
        }
    });

    it('tolerates an exactly-repeated row, which contradicts nothing', () => {
        // The control. Refusing this too would make the check about duplication
        // rather than about contradiction, and callers legitimately concatenate.
        const row: RosterEmployee = {
            id: 'e-104',
            fullName: 'Tess Lee',
            status: 'ACTIVE',
            workEmail: 'tess.lee@example.test',
        };
        const r = reconcile({
            accounts: [account],
            roster: [row, { ...row }],
            directory: [],
            aliases: [],
            now: NOW,
        });
        expect(r.resolutions[0].outcome).toBe('LINKED');
        expect(r.resolutions[0].employeeId).toBe('e-104');
        // And it is counted once, not twice.
        expect(r.metrics.comparisons).toBe(1);
    });
});
