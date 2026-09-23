/**
 * The joiner's DRY_RUN planner (#2638, Phase 1).
 *
 * Two things are being pinned here, and they fail in different directions.
 *
 * THE DECISIONS. Ten owner decisions of 2026-09-19 govern this pass, and four of
 * them are refusals — a refusal is the easiest behaviour in the world to lose to
 * a `where` clause, because a filtered-out row and a refused row look identical
 * from the outside (an empty page) and only one of them told anybody why.
 * Decision 6 says that in as many words: MANUAL-sourced employees get an
 * explicit refusal with a named reason, *never* a silent exclusion via a
 * freshness gate. So every refusal below is asserted to APPEAR in the decision
 * list, not merely to be absent from the planned set.
 *
 * THE INERTNESS. A DRY_RUN planner that writes anything, or that reaches a
 * directory, is not a dry run. That property is proved at the top of this file
 * rather than asserted about: `@/lib/prisma` and `@/lib/db-context` are mocked
 * to THROW on import, and `fetch` is replaced with a throwing stub. If the
 * module — or anything in its import graph — pulls a database or opens a socket,
 * this suite cannot even load. A source scan would have been the weaker check:
 * it reads one file, and the import graph is what actually decides.
 */
jest.mock('@/lib/prisma', () => {
    throw new Error('the joiner planner must not reach prisma — a DRY_RUN plan writes nothing');
});
jest.mock('@/lib/db-context', () => {
    throw new Error('the joiner planner must not reach the db context — a DRY_RUN plan reads nothing');
});

import {
    JOINER_MAX_MODE,
    MAX_CREATES_PER_RUN,
    deriveJoinerIdentity,
    planJoinerPass,
    type JoinerCandidate,
    type JoinerPlanInput,
} from '@/app-layer/usecases/identity-joiner-pass';
import { LADDER, isAboveClamp } from '@/lib/identity/write-ladder';
import {
    JOINER_PREDICTION_LIMITS_NO_TIMEZONE,
    JOINER_STANDING_PREDICTION_LIMITS,
} from '../helpers/joiner-prediction-limits';

const NOW = new Date('2026-09-19T09:00:00.000Z');
const STARTS_TODAY = new Date('2026-09-19T00:00:00.000Z');

beforeAll(() => {
    // "Opens no socket", made mechanical. Anything that tried would take the
    // suite down rather than quietly succeeding in CI where a directory happens
    // to be reachable.
    global.fetch = (() => {
        throw new Error('the joiner planner must not open a socket');
    }) as unknown as typeof fetch;
});

function candidate(over: Partial<JoinerCandidate> = {}): JoinerCandidate {
    return {
        employeeId: 'emp-1',
        fullName: 'Jane Smith',
        workEmail: 'jane.smith@acme.com',
        source: 'workday',
        externalId: 'WD-1001',
        department: 'Engineering',
        startDate: STARTS_TODAY,
        hasFreshLink: false,
        ...over,
    };
}

function input(over: Partial<JoinerPlanInput> = {}): JoinerPlanInput {
    return {
        mode: 'DRY_RUN',
        now: NOW,
        starters: [candidate()],
        observedAddresses: [],
        departmentGroups: { Engineering: 'grp-eng' },
        defaultGroupId: 'grp-everyone',
        defaultGroupName: 'Contractors',
        timeZone: 'Europe/Sofia',
        ...over,
    };
}

const outcomeFor = (plan: ReturnType<typeof planJoinerPass>, employeeId: string) =>
    plan.decisions.find((d) => d.employeeId === employeeId);

describe('the clamp, and the fact that it is ordinal', () => {
    it('is DRY_RUN — a rung the ladder actually has', () => {
        // A clamp off the ladder sorts to -1 in `isAboveClamp`, i.e. nothing is
        // ever above it, i.e. the gate is silently inert rather than loudly
        // wrong. The leaver's own tests pin the same property for the same
        // reason.
        expect(LADDER).toContain(JOINER_MAX_MODE);
        expect(JOINER_MAX_MODE).toBe('DRY_RUN');
    });

    it('refuses AUTOMATIC and carries the starter count', () => {
        const plan = planJoinerPass(input({ mode: 'AUTOMATIC' }));
        expect(plan.refusal).toBe('MODE_ABOVE_CLAMP');
        expect(plan.detail).toMatch(/clamped at DRY_RUN/);
        // The count is the point of the divergence from the leaver: a refusal
        // that says "1 starter" is actionable, and one that says nothing is
        // indistinguishable from a dead worker on the morning somebody is
        // sitting at a desk with no account.
        expect(plan.starters).toBe(1);
        expect(plan.wouldCreate).toBe(0);
    });

    it('does NOT refuse the rung it is clamped AT — the ordinal half', () => {
        // The positive control, and the exact bug the leaver paid for: a
        // `mode !== JOINER_MAX_MODE` gate refuses a tenant that is BELOW or AT
        // the ceiling, and a MODE_ABOVE_CLAMP refusal is the one that produces
        // no plan at all.
        expect(planJoinerPass(input({ mode: 'DRY_RUN' })).refusal).toBeNull();
    });

    it('agrees with `isAboveClamp` on every rung, so the ceiling is one answer', () => {
        for (const rung of LADDER) {
            const plan = planJoinerPass(input({ mode: rung }));
            expect(plan.refusal === 'MODE_ABOVE_CLAMP').toBe(isAboveClamp(rung, JOINER_MAX_MODE));
        }
    });

    it('refuses DISABLED separately, and carries the count there too', () => {
        const plan = planJoinerPass(input({ mode: 'DISABLED' }));
        expect(plan.refusal).toBe('MODE_DISABLED');
        expect(plan.starters).toBe(1);
    });

    it('reports NO_STARTERS when nobody starts — the row that proves the pass ran', () => {
        const plan = planJoinerPass(input({ starters: [] }));
        expect(plan.refusal).toBe('NO_STARTERS');
        expect(plan.starters).toBe(0);
    });
});

describe('deriveJoinerIdentity — one function, no mode parameter', () => {
    it('takes exactly one argument, so a dry-run identity cannot differ from a live one', () => {
        // The design states this as a rule: *"The identifier derivation is ONE
        // exported pure function with NO `mode` parameter, called by the dry-run
        // path and the live path alike."* A `mode` argument is how the two
        // answers begin to diverge, and the rung's whole justification is that
        // they cannot. Asserted on the arity because that is the thing a Phase 2
        // author would have to change.
        expect(deriveJoinerIdentity).toHaveLength(1);
    });

    it('derives first.last at the roster domain', () => {
        const d = deriveJoinerIdentity({ fullName: 'Jane Smith', workEmail: 'jane.smith@acme.com' });
        expect(d).toMatchObject({ ok: true, localPart: 'jane.smith', address: 'jane.smith@acme.com' });
    });

    it('folds diacritics rather than refusing a perfectly ordinary name', () => {
        const d = deriveJoinerIdentity({ fullName: 'José Núñez', workEmail: 'jose.nunez@acme.com' });
        expect(d).toMatchObject({ ok: true, address: 'jose.nunez@acme.com' });
    });

    it('refuses a name that is the work email — the EMAIL_FALLBACK arm', () => {
        // Workday writes `preferredName || legalName || workEmail` into ONE
        // column, so the deriver is handed an address often enough for this to
        // be a live path. Splitting it would mint `jane.smith@acme.com` as a
        // local part.
        const d = deriveJoinerIdentity({
            fullName: 'jane.smith@acme.com',
            workEmail: 'jane.smith@acme.com',
        });
        expect(d.ok).toBe(false);
        expect(d.nameSource).toBe('EMAIL_FALLBACK');
    });

    it('refuses anything that is not exactly two usable tokens — never guesses a split', () => {
        for (const fullName of ['Prince', 'Maria de Souza', 'Jane Smith Jr.', '张 伟']) {
            expect(deriveJoinerIdentity({ fullName, workEmail: 'x@acme.com' }).ok).toBe(false);
        }
    });
});

describe('per-candidate decisions', () => {
    it('plans the ordinary case and records the group it would grant', () => {
        const plan = planJoinerPass(input());
        expect(plan.refusal).toBeNull();
        expect(plan.wouldCreate).toBe(1);
        expect(outcomeFor(plan, 'emp-1')).toMatchObject({
            outcome: 'PLANNED',
            intendedAddress: 'jane.smith@acme.com',
            groupId: 'grp-eng',
            groupIsDefaultFallback: false,
            department: 'Engineering',
        });
    });

    it('DECISION 6 — a MANUAL employee is REFUSED BY NAME, not filtered away', () => {
        const plan = planJoinerPass(
            input({ starters: [candidate({ source: 'MANUAL', externalId: null })] }),
        );
        const d = outcomeFor(plan, 'emp-1');
        // Both halves matter. The outcome is the named refusal…
        expect(d?.outcome).toBe('REFUSED_SOURCE_MANUAL');
        // …and the reason says MANUAL out loud, so an operator reading the
        // artefact is not left to infer it from an absence.
        expect(d?.reason).toMatch(/MANUAL/);
        // And it is IN the list. A silent exclusion would show as a shorter
        // decision list with nothing to read.
        expect(plan.decisions).toHaveLength(1);
        expect(plan.wouldCreate).toBe(0);
    });

    it('refuses a MANUAL employee as MANUAL, not as a missing identifier', () => {
        // The two are one row apart in the pass and one keystroke apart in
        // review, and they give an operator opposite advice: an unstable
        // identifier is a data-quality problem somebody can go and fix, while a
        // MANUAL row has no HRIS to fix it in. Ordering is the whole difference.
        const plan = planJoinerPass(
            input({ starters: [candidate({ source: 'MANUAL', externalId: null })] }),
        );
        const d = outcomeFor(plan, 'emp-1');
        // Asserted present FIRST. `outcomeFor(...)?.outcome` on a row that was
        // filtered away is `undefined`, and `undefined` is not
        // REFUSED_IDENTIFIER_UNSTABLE either — so the negative alone would go
        // green on the exact regression decision 6 forbids. Measured: it did,
        // under the filter mutation that reddened the test above.
        expect(d).toBeDefined();
        expect(d?.outcome).not.toBe('REFUSED_IDENTIFIER_UNSTABLE');
    });

    it('refuses an HRIS employee with no external id — the identifier rail proper', () => {
        const plan = planJoinerPass(input({ starters: [candidate({ externalId: null })] }));
        expect(outcomeFor(plan, 'emp-1')?.outcome).toBe('REFUSED_IDENTIFIER_UNSTABLE');
    });

    it('refuses an externalId that IS the work email — the roster fallback chain', () => {
        const plan = planJoinerPass(
            input({ starters: [candidate({ externalId: 'Jane.Smith@ACME.com' })] }),
        );
        // Note the casing: the comparison goes through the shared `emailKey`,
        // so a differently-cased copy of the address is still the address.
        expect(outcomeFor(plan, 'emp-1')?.outcome).toBe('REFUSED_IDENTIFIER_UNSTABLE');
    });

    it('DECISION 1 — refuses when the derived address is not the one the matcher will look for', () => {
        // `j.smith@acme.com` is what the roster holds; `jane.smith@acme.com` is
        // what the derivation produces. Creating the second makes an account the
        // link reconciler never joins to this employee — and therefore one the
        // LEAVER can never disable. That is the joiner's worst failure landing
        // in the leaver's blast radius months later, on a termination.
        const plan = planJoinerPass(
            input({ starters: [candidate({ workEmail: 'j.smith@acme.com' })] }),
        );
        const d = outcomeFor(plan, 'emp-1');
        expect(d?.outcome).toBe('REFUSED_IDENTITY_DIVERGES');
        expect(d?.reason).toMatch(/leaver can never disable/i);
        expect(plan.wouldCreate).toBe(0);
    });

    it('never renames around a collision — decision 1 declines the token arm', () => {
        const plan = planJoinerPass(input({ observedAddresses: ['JANE.SMITH@acme.com'] }));
        const d = outcomeFor(plan, 'emp-1');
        expect(d?.outcome).toBe('ACCOUNT_OBSERVED');
        // The address is reported unchanged. A `-4f2a` suffix here would be the
        // settled 2026-08-20 decision the owner declined on 2026-09-19.
        expect(d?.intendedAddress).toBe('jane.smith@acme.com');
        expect(plan.wouldCreate).toBe(0);
    });

    it('normalises the collision read the way the link matcher does', () => {
        // Same address, different casing and padding. A private normaliser here
        // is exactly how the collision check and the matcher come to disagree.
        expect(
            outcomeFor(planJoinerPass(input({ observedAddresses: ['  Jane.Smith@Acme.COM '] })), 'emp-1')
                ?.outcome,
        ).toBe('ACCOUNT_OBSERVED');
    });

    it('reports ALREADY_PROVISIONED — but only AFTER the derivation refusals', () => {
        const provisioned = planJoinerPass(
            input({ starters: [candidate({ hasFreshLink: true })] }),
        );
        expect(outcomeFor(provisioned, 'emp-1')?.outcome).toBe('ALREADY_PROVISIONED');

        // The ordering claim, stated as the case that distinguishes it. The
        // leaver checks ALREADY_DISABLED early and is right to; for a create,
        // checking a fresh link first would turn every derivation problem into a
        // clean skip — and the derivation problems are what the seven days exist
        // to surface before Phase 2 can act on them.
        const alsoBroken = planJoinerPass(
            input({ starters: [candidate({ hasFreshLink: true, fullName: 'Prince' })] }),
        );
        expect(outcomeFor(alsoBroken, 'emp-1')?.outcome).toBe('REFUSED_NAME_UNDERIVABLE');
    });

    it('separates a missing start date from an unparseable one from another day', () => {
        const none = planJoinerPass(input({ starters: [candidate({ startDate: null })] }));
        expect(outcomeFor(none, 'emp-1')?.outcome).toBe('REFUSED_NO_START_DATE');

        const junk = planJoinerPass(
            input({ starters: [candidate({ startDate: new Date('not-a-date') })] }),
        );
        expect(outcomeFor(junk, 'emp-1')?.outcome).toBe('START_DATE_UNPARSEABLE');

        const later = planJoinerPass(
            input({ starters: [candidate({ startDate: new Date('2026-09-25T00:00:00.000Z') })] }),
        );
        // NOT a refusal: this person starts on another day, and saying so is
        // different from saying they have no start date at all.
        expect(outcomeFor(later, 'emp-1')?.outcome).toBe('NOT_IN_WINDOW');
    });

    it('carries the namespace it actually checked on every decision', () => {
        const plan = planJoinerPass(
            input({
                starters: [candidate(), candidate({ employeeId: 'emp-2', fullName: 'Prince' })],
            }),
        );
        for (const d of plan.decisions) {
            // A literal list, so widening it later is a visible diff and an old
            // artefact cannot be re-read as having promised more.
            expect(d.namespacesChecked).toEqual(['email']);
        }
    });
});

describe('the entitlement configuration, which decisions 5 and 10 make a refusal', () => {
    it('refuses NO_DEPARTMENT_MAP — and still reports what it decided', () => {
        const plan = planJoinerPass(input({ departmentGroups: null }));
        expect(plan.refusal).toBe('NO_DEPARTMENT_MAP');
        expect(plan.wouldCreate).toBe(0);
        // The half that keeps the refusal from destroying the rung's value: the
        // identity verdicts survive it, because THEY are what makes a wrong
        // derivation visible seven days early.
        expect(plan.decisions).toHaveLength(1);
        expect(outcomeFor(plan, 'emp-1')?.intendedAddress).toBe('jane.smith@acme.com');
    });

    it('refuses NO_DEFAULT_GROUP when a map exists but the fallback has no name', () => {
        const plan = planJoinerPass(input({ defaultGroupId: null }));
        expect(plan.refusal).toBe('NO_DEFAULT_GROUP');
    });

    it('records BOTH names when it falls back — the mitigation decision 5 is conditional on', () => {
        const plan = planJoinerPass(
            input({ starters: [candidate({ department: 'Growth Marketing' })] }),
        );
        const d = outcomeFor(plan, 'emp-1');
        // A row recording only the department says a fallback happened but not
        // TO WHAT, which is the mitigation stated and not implemented.
        expect(d).toMatchObject({
            outcome: 'PLANNED',
            department: 'Growth Marketing',
            groupId: 'grp-everyone',
            groupIsDefaultFallback: true,
        });
    });
});

describe('DECISION 7 — the per-run cap is an anomaly detector', () => {
    // Alphabetic surnames on purpose: the deriver refuses a token carrying a
    // digit, so `Ada Lovelace1` would have made this a test of
    // REFUSED_NAME_UNDERIVABLE wearing a cap test's name.
    const SURNAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'];
    const many = (n: number) =>
        Array.from({ length: n }, (_, i) => {
            const surname = SURNAMES[i];
            if (!surname) throw new Error(`no surname for index ${i} — widen SURNAMES`);
            return candidate({
                employeeId: `emp-${i}`,
                fullName: `Ada ${surname}`,
                workEmail: `ada.${surname.toLowerCase()}@acme.com`,
                externalId: `WD-${i}`,
            });
        });

    it('admits a batch AT the cap', () => {
        const plan = planJoinerPass(input({ starters: many(MAX_CREATES_PER_RUN) }));
        expect(plan.refusal).toBeNull();
        expect(plan.wouldCreate).toBe(MAX_CREATES_PER_RUN);
    });

    it('refuses the WHOLE batch one over it, and never trims', () => {
        const plan = planJoinerPass(input({ starters: many(MAX_CREATES_PER_RUN + 1) }));
        expect(plan.refusal).toBe('BATCH_OVER_CAP');
        expect(plan.wouldCreate).toBe(0);
        // Trimming would perform part of a probably-wrong action AND hide the
        // anomaly behind a number that looks deliberate. The decisions are all
        // still reported so the operator can see the batch that alarmed it.
        expect(plan.decisions).toHaveLength(MAX_CREATES_PER_RUN + 1);
    });

    it('counts PLANNED creations, not bodies — a refused starter does not spend the cap', () => {
        const plan = planJoinerPass(
            input({ starters: [...many(MAX_CREATES_PER_RUN), candidate({ employeeId: 'm', source: 'MANUAL' })] }),
        );
        expect(plan.refusal).toBeNull();
        expect(plan.wouldCreate).toBe(MAX_CREATES_PER_RUN);
    });
});

describe('what the dry run says it could not know', () => {
    it('states the HRIS write-back has never been attempted — on every plan', () => {
        for (const plan of [
            planJoinerPass(input()),
            planJoinerPass(input({ mode: 'DISABLED' })),
            planJoinerPass(input({ departmentGroups: null })),
        ]) {
            expect(plan.predictionLimits.some((l) => /write-back/i.test(l))).toBe(true);
        }
    });

    it('bounds the collision read, so "no conflict" is never read as "available"', () => {
        const limits = planJoinerPass(input()).predictionLimits;
        expect(limits.some((l) => /userPrincipalName/.test(l) && /NOT a statement/.test(l))).toBe(true);
    });

    it('says drift is undetectable while no reservation is persisted', () => {
        // The rung's own justification in the design is that a second run can
        // refuse IDENTITY_DRIFTED. Phase 1 stores nothing, so it cannot — and
        // the plan says so rather than implying the opposite by silence.
        expect(planJoinerPass(input()).predictionLimits.some((l) => /drift/i.test(l))).toBe(true);
    });

    it('is EXACTLY the standing three, in order, when a timezone IS stored', () => {
        // The assertions above this one are keyed on a TOPIC word, and a topic
        // word is satisfied by a sentence saying the opposite of what the limit
        // says. Measured, not assumed (#2687): rewriting limit 1 from "has
        // never been attempted" to "is covered by this plan" left every test in
        // the joiner population green — including the two named for acceptance
        // 3. Equality against a second, independently-written copy is what
        // makes a reword visible; the copy lives in tests/helpers so the IO
        // suite asserts the same text from the other end of the seam.
        expect(planJoinerPass(input({ timeZone: 'Europe/Sofia' })).predictionLimits).toEqual(
            JOINER_STANDING_PREDICTION_LIMITS,
        );
    });

    it('APPENDS the UTC caveat LAST when no timezone is stored, and changes nothing else', () => {
        // Order is part of "verbatim": an operator reads these top to bottom,
        // and the conditional one belongs at the end rather than interleaved
        // with the three that are always true.
        expect(planJoinerPass(input({ timeZone: null })).predictionLimits).toEqual(
            JOINER_PREDICTION_LIMITS_NO_TIMEZONE,
        );
    });

    it('says the same on EVERY refusal as on a clean plan — same text, same order', () => {
        // `refuse(...)` is a SECOND return site carrying its own
        // `predictionLimits`, so the refused artefact can lose them while the
        // clean one keeps them, and the refused artefact is the one most likely
        // to be trimmed. One case per gate that can produce a plan.
        const refusals: Partial<JoinerPlanInput>[] = [
            { mode: 'DISABLED' },
            { mode: 'AUTOMATIC' },
            { starters: [] },
            { departmentGroups: null },
            { defaultGroupId: null },
        ];
        for (const over of refusals) {
            const plan = planJoinerPass(input({ ...over, timeZone: null }));
            expect(plan.refusal).not.toBeNull();
            expect(plan.predictionLimits).toEqual(JOINER_PREDICTION_LIMITS_NO_TIMEZONE);
        }
    });

    it('DECISION 9 — names the UTC window only when no tenant timezone exists', () => {
        const utc = planJoinerPass(input({ timeZone: null })).predictionLimits;
        expect(utc.some((l) => /computed in UTC/.test(l))).toBe(true);

        // The positive control. A limit that is always present is not a signal,
        // and this one must disappear the day a tenant timezone is stored.
        const zoned = planJoinerPass(input({ timeZone: 'Europe/Sofia' })).predictionLimits;
        expect(zoned.some((l) => /computed in UTC/.test(l))).toBe(false);
    });
});

describe('THE WINDOW IS ONE UTC DAY, and both edges are the assertion', () => {
    // #2687 acceptance 2, the date half. Widen this window and the pass becomes
    // an ALL-DATES one with nothing in the artefact looking different: every
    // starter simply stops being reported NOT_IN_WINDOW, and a plausible number
    // goes on being published over a population somebody quietly enlarged.
    //
    // The neighbouring case (`separates a missing start date from an
    // unparseable one from another day`) uses a date six days out, so it stays
    // GREEN on a window widened to a month — which is why the two boundary
    // milliseconds are asserted here instead of a second comfortable date.
    // NOW is 09:00 UTC on 2026-09-19, so the window is [09-19T00:00:00.000Z,
    // 09-20T00:00:00.000Z).
    const startingAt = (iso: string) =>
        planJoinerPass(
            input({ starters: [candidate({ startDate: new Date(iso) })], timeZone: null }),
        );

    it('admits the FIRST millisecond of the UTC day', () => {
        expect(outcomeFor(startingAt('2026-09-19T00:00:00.000Z'), 'emp-1')?.outcome).toBe(
            'PLANNED',
        );
    });

    it('admits the LAST millisecond of the UTC day', () => {
        expect(outcomeFor(startingAt('2026-09-19T23:59:59.999Z'), 'emp-1')?.outcome).toBe(
            'PLANNED',
        );
    });

    it('excludes the FIRST millisecond of the next UTC day — the ceiling is exclusive', () => {
        expect(outcomeFor(startingAt('2026-09-20T00:00:00.000Z'), 'emp-1')?.outcome).toBe(
            'NOT_IN_WINDOW',
        );
    });

    it('excludes the LAST millisecond of the previous UTC day — the floor is inclusive', () => {
        expect(outcomeFor(startingAt('2026-09-18T23:59:59.999Z'), 'emp-1')?.outcome).toBe(
            'NOT_IN_WINDOW',
        );
    });
});

describe('the planner is pure', () => {
    it('does not mutate its input and returns the same plan twice', () => {
        const starters = [candidate()];
        const frozen = Object.freeze(input({ starters: Object.freeze(starters) as JoinerCandidate[] }));
        const first = planJoinerPass(frozen);
        const second = planJoinerPass(frozen);
        expect(second).toEqual(first);
        expect(starters).toHaveLength(1);
        expect(starters[0]).toEqual(candidate());
    });
});
