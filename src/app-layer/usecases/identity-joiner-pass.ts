/**
 * The JML joiner, Phase 1: a planner that decides everything and writes nothing.
 *
 * Issue #2638. `docs/jml-joiner-design.md` carries the long form; the ten owner
 * decisions of 2026-09-19 on the issue WIN where the two differ, and the places
 * they differ are marked below by decision number.
 *
 * ═══ WHAT THIS MODULE IS, AND WHAT IT DELIBERATELY IS NOT ═══
 *
 * It is the decision core of a DRY_RUN joiner pass: given a set of starters and
 * the tenant's configuration, it says what the joiner WOULD do — which identity
 * each person would be given, which would be refused and by name, and what the
 * plan could not know. It is a pure function. It writes nothing to a directory,
 * nothing to an HRIS, and nothing to our own database; it opens no socket; it
 * does not need an AD or an Entra instance, or a queue, to run.
 *
 * That purity is a load-bearing property rather than a style choice, and it is
 * pinned by a guard (`tests/guards/identity-joiner-dry-run-is-inert.test.ts`):
 * this module imports no prisma, no db-context, no provider and no writer. The
 * design's gate-placement rule is the reason —
 *
 *   > Every gate that decides whether a create happens sits ABOVE the DRY_RUN
 *   > return, in the usecase, evaluated from data the dry run has. A gate inside
 *   > a provider writer is by construction a gate the dry run cannot honour.
 *
 * — and the incident behind it: a live Entra pre-flight tested
 * `onPremisesSyncEnabled === false`, which refused the `null` Graph actually
 * sends for a cloud-only tenant, while the snapshot writer used in DRY_RUN never
 * reached that check and cheerfully reported "would disable" for the same
 * accounts (`entra-id/writer.ts:1094-1101`). A dry run that disagrees with the
 * live path is worse than one that refuses, because the whole point of the seven
 * days is that an operator can compare the two.
 *
 * WHAT IS NOT HERE, and must not be added without the capability it needs:
 *
 *   • No create verb. `DirectoryWriter` still declares exactly one mutating
 *     member, `disable()`, and Phase 2 adds a separate `DirectoryProvisioner`
 *     rather than widening it.
 *   • No HRIS write-back. It is a fourth write, to a second vendor, that this
 *     repo has never performed. Every plan says so — see `predictionLimits`.
 *   • No persisted pre-hire and no persisted reservation. Decision 2 puts
 *     pre-hires outside `Employee`, which is a schema change; until it exists,
 *     two runs cannot compare their derivations, so `IDENTITY_DRIFTED` — the
 *     rung's own justification in the design — is NOT detectable yet, and the
 *     plan says that too rather than implying otherwise by silence.
 *
 * ═══ WHY THE CLAMP IS A SOURCE CONSTANT, AND WHY THE ROUTE IMPORTS IT ═══
 *
 * `JOINER_MAX_MODE` mirrors `LEAVER_MAX_MODE`: raising it must be a diff
 * somebody reviews, not a setting somebody flips. The admin route now IMPORTS it
 * for `honoured.joiner.maxMode` instead of carrying its own `'DISABLED' as
 * const` literal, and that difference is the whole of #2638's acceptance.
 * `write-ladder.ts` wrote the trap down before it was possible to fall into it:
 * flip `DIRECTION_IMPLEMENTED.joiner` while the route still reports a DISABLED
 * ceiling and `isAboveClamp` is true for every rung above off — the client shows
 * the aboveClamp banner while nothing clamps anything. The literal is gone, so
 * the reported ceiling and the enforced ceiling are now one value.
 *
 * @module usecases/identity-joiner-pass
 */
import { isAboveClamp, type IdentityWriteMode } from '@/lib/identity/write-ladder';
import { emailKey } from '@/lib/identity/email-key';

/**
 * The highest rung this pass will act at.
 *
 * DRY_RUN, and the reason is not caution for its own sake: there is no create
 * verb behind this module, so AUTOMATIC would name an authority nothing can
 * exercise. A constant rather than config, for the same reason
 * `LEAVER_MAX_MODE` is one — raising it is a reviewed diff and a deploy.
 *
 * It is enforced at gate 1 below, ORDINALLY (`isAboveClamp`), never
 * `mode !== JOINER_MAX_MODE`. The leaver paid for that distinction: with the
 * clamp at the second rung the inequality is correct by coincidence, and the
 * coincidence breaks the moment the clamp moves.
 */
export const JOINER_MAX_MODE = 'DRY_RUN' as const;

/**
 * Decision 7 — the cap is 5 creations PER RUN.
 *
 * Taken knowing what it costs: decision 4 fires the joiner on the start date and
 * permits intra-day retries, so 5-per-run permits 5×N across a day. The owner
 * chose per-run anyway on 2026-09-19, declining the design's per-UTC-day
 * counting, and this constant carries that decision rather than quietly
 * improving on it. A per-day count needs a persisted run history, which Phase 1
 * does not have — implementing it here would mean inventing the storage the same
 * decision says is Phase 2's.
 *
 * It is an ANOMALY DETECTOR, not a rate limit: a batch over the cap is refused
 * WHOLE and never trimmed, because trimming performs part of a probably-wrong
 * action and hides the anomaly behind a number that looks deliberate
 * (`identity-write-breaker.ts:36-37`).
 */
export const MAX_CREATES_PER_RUN = 5;

/** Why a whole pass produced no plan. Exactly one is reported. */
export type JoinerPassRefusal =
    /** Joiner writes are switched off for this tenant. Carries the starter count. */
    | 'MODE_DISABLED'
    /** The tenant sits above `JOINER_MAX_MODE`. Carries the starter count. */
    | 'MODE_ABOVE_CLAMP'
    /** Nobody starts in the window. The boring row that proves the pass ran. */
    | 'NO_STARTERS'
    /** Decision 10's map does not exist for this tenant. */
    | 'NO_DEPARTMENT_MAP'
    /** Decision 5's required refusal: a fallback is only safe when it has a name. */
    | 'NO_DEFAULT_GROUP'
    /** Decision 7: more than `MAX_CREATES_PER_RUN` proposed. Whole batch refused. */
    | 'BATCH_OVER_CAP';

/** What the pass decided about one starter. */
export type JoinerDecisionOutcome =
    /** Everything checked out. In DRY_RUN this is the terminal state. */
    | 'PLANNED'
    /** The worker already holds a fresh link for this provider. Idempotency, not a failure. */
    | 'ALREADY_PROVISIONED'
    /** The last complete enumeration holds this address, unlinked. Fix the link; do not create. */
    | 'ACCOUNT_OBSERVED'
    /** `Employee.startDate` is null. A live path, not a defensive one. */
    | 'REFUSED_NO_START_DATE'
    /**
     * Starts on another day. NOT a refusal and not a failure.
     *
     * It exists because the window is applied HERE rather than in the caller's
     * `where` clause. A query-level filter would make "starts tomorrow" and
     * "has no start date at all" the same absence — and the second is the live
     * data-quality case decision 6 refuses to express as silence.
     */
    | 'NOT_IN_WINDOW'
    /** The stored start date is an Invalid Date. */
    | 'START_DATE_UNPARSEABLE'
    /** Decision 6 — a MANUAL-sourced employee, refused BY NAME rather than filtered out. */
    | 'REFUSED_SOURCE_MANUAL'
    /** No stable handle to key a create or a later write-back on. */
    | 'REFUSED_IDENTIFIER_UNSTABLE'
    /** `first.last` cannot be produced from the one name column the schema holds. */
    | 'REFUSED_NAME_UNDERIVABLE'
    /** Decision 1 — the derived address is not the address the matcher will look for. */
    | 'REFUSED_IDENTITY_DIVERGES';

/**
 * Which name the derivation was handed.
 *
 * TWO values, not the design's three. `Employee` holds a single `fullName`, and
 * the Workday normaliser flattens `preferredName || legalName || workEmail` into
 * it (`workday/roster.ts:99`), so PREFERRED and LEGAL are not distinguishable
 * from a stored row. Decision 1's carried cost says exactly this: *"say which of
 * the two you are shipping; do not record a field the pass cannot actually
 * populate."* `EMAIL_FALLBACK` IS recoverable — the name normalises equal to the
 * work email — and it is the arm that must refuse.
 */
export type NameSource = 'ROSTER_DISPLAY_NAME' | 'EMAIL_FALLBACK';

/** A starter, as the planner needs to see one. Plain data — no Prisma types. */
export interface JoinerCandidate {
    readonly employeeId: string;
    /** The single name column. May be a display name, a mononym, or an email. */
    readonly fullName: string;
    /** `Employee.workEmail` — NOT NULL and unique per tenant today. */
    readonly workEmail: string;
    /** `Employee.source`: 'MANUAL' for a hand-entered row, else the HRIS. */
    readonly source: string;
    /** `Employee.externalId` — null for MANUAL rows by design. */
    readonly externalId: string | null;
    /** Verbatim, for decision 5's by-name reporting. */
    readonly department: string | null;
    readonly startDate: Date | null;
    /**
     * Does this worker already hold a link re-observed by a COMPLETE sync?
     *
     * Passed in rather than computed here, because deciding it needs the link
     * table and the freshness bound — and this module holds no database.
     */
    readonly hasFreshLink: boolean;
}

/** One starter's verdict, and everything an operator needs to act on it. */
export interface JoinerDecision {
    readonly employeeId: string;
    readonly outcome: JoinerDecisionOutcome;
    /** Why, in words, for every outcome that is not PLANNED. */
    readonly reason: string | null;
    /** The address this person would be created under, when one could be derived. */
    readonly intendedAddress: string | null;
    readonly nameSource: NameSource | null;
    /** The department string VERBATIM — decision 5 wants both names, not one. */
    readonly department: string | null;
    /** The group this person would be added to, and whether it was the fallback. */
    readonly groupId: string | null;
    readonly groupIsDefaultFallback: boolean;
    /**
     * The fallback group's NAME, and only when the fallback was actually taken.
     *
     * Decision 5 binds this: "a typo'd or brand-new department is otherwise
     * indistinguishable from a mapped one". `groupIsDefaultFallback` says THAT
     * a fallback happened; without the name it does not say TO WHAT, which is
     * the difference between an operator reading "fell back to Contractors,
     * deliberately" and "fell back to something, cause unknown". Null on a
     * MAPPED decision, because there was no fallback to name.
     */
    readonly defaultGroupName: string | null;
    /**
     * Which namespaces the collision read actually covered. A literal list, so
     * widening it later is a visible diff and an old artefact cannot be re-read
     * as having promised more.
     *
     * `email` is `mail || userPrincipalName` as the roster stored it
     * (`entra-id/index.ts:111`) — NOT the namespace a create collides in. See
     * `predictionLimits`.
     */
    readonly namespacesChecked: readonly string[];
}

/** Everything the planner is given. No IO happens inside; the caller does it. */
export interface JoinerPlanInput {
    /** The tenant's rung, ALREADY through `coerceStoredMode` at the read boundary. */
    readonly mode: IdentityWriteMode;
    readonly now: Date;
    /**
     * The population: employees the feed marks as starting. Filtering to a day
     * is NOT done here — a starter with a null or unparseable `startDate` must
     * reach a named refusal rather than be dropped by a `where` clause, which is
     * the shape decision 6 rejects for MANUAL rows and is no better here.
     */
    readonly starters: readonly JoinerCandidate[];
    /**
     * Every account address the last COMPLETE enumeration held for this
     * connection, whatever its status.
     *
     * Not filtered on ACTIVE, deliberately: the deprovision reconcile updates
     * rows in place to DEPROVISIONED and nothing deletes them
     * (`identity-sync.ts:537-543`, `:650-653`), so an ACTIVE-only read would
     * call FREE a UPN still held by a soft-deleted object in Entra's recycle
     * bin — one of the cases a real create rejects.
     */
    readonly observedAddresses: readonly string[];
    /** Decision 10's map: department → security group id. Null when unconfigured. */
    readonly departmentGroups: Readonly<Record<string, string>> | null;
    /** Decision 5's configured fallback. Null is a refusal, not a silent skip. */
    readonly defaultGroupId: string | null;
    /**
     * The fallback's display name, stored beside its id rather than resolved
     * at display time — a directory lookup is absent exactly when the
     * directory call fails, which is when this most needs to be readable.
     */
    readonly defaultGroupName: string | null;
    /**
     * The tenant's IANA zone, for decision 9.
     *
     * Null means the capability does not exist for this tenant, which is the
     * state of every tenant today: nothing stores one. The window below is then
     * computed in UTC and the plan SAYS SO, rather than presenting a UTC day as
     * if it were the starter's local one.
     */
    readonly timeZone: string | null;
}

/** The plan. Exactly one refusal, or none and a list of decisions. */
export interface JoinerPlan {
    readonly mode: IdentityWriteMode;
    readonly clamp: typeof JOINER_MAX_MODE;
    readonly refusal: JoinerPassRefusal | null;
    readonly detail: string;
    /** How many starters were assembled — carried even by a ladder refusal. */
    readonly starters: number;
    /** How many the joiner WOULD create. Zero whenever `refusal` is set. */
    readonly wouldCreate: number;
    readonly decisions: readonly JoinerDecision[];
    /**
     * What this dry run could not know, in the operator's words.
     *
     * Present from the FIRST run, per the design: a DRY_RUN artefact reporting
     * "would create 34 accounts" is otherwise silent about 34 HRIS write-backs
     * that have never been attempted against a system this product has never
     * written to.
     */
    readonly predictionLimits: readonly string[];
}

/** The result of asking for one person's identity. Never throws. */
export type DerivedIdentity =
    | {
          readonly ok: true;
          readonly localPart: string;
          readonly address: string;
          readonly nameSource: NameSource;
      }
    | {
          readonly ok: false;
          readonly reason: 'NAME_UNDERIVABLE';
          readonly detail: string;
          readonly nameSource: NameSource;
      };

/**
 * `first.last@domain`, or a refusal — the ONE derivation, with NO `mode`
 * parameter.
 *
 * The missing parameter is the point. The design states it as a rule: *"The
 * identifier derivation is ONE exported pure function with NO `mode` parameter,
 * called by the dry-run path and the live path alike"* — because a `mode`
 * argument is exactly how the dry run's identity and the live path's identity
 * begin to disagree, and the whole justification of the rung is that they
 * cannot. Phase 2's create verb calls THIS function; if it ever grows a second
 * spelling, the seven days bought nothing.
 *
 * ═══ NO COLLISION TOKEN. THAT IS DECISION 1 OF 2026-09-19. ═══
 *
 * The settled decision of 2026-08-20 appended a deterministic token derived from
 * the worker id on collision (`john.smith-4f2a`). The owner DECLINED that arm on
 * 2026-09-19: *"Refuse on divergence. The joiner declines to create unless the
 * address is guaranteed to match. Never create an account the leaver cannot
 * later disable."* So a collision is a refusal here, not a rename — see
 * `ACCOUNT_OBSERVED` and `REFUSED_IDENTITY_DIVERGES` in the planner.
 *
 * WHAT IT REFUSES, AND WHY IT NEVER GUESSES. `Employee` holds one `fullName`
 * (`personnel.prisma:234`) filled from `preferredName || legalName || workEmail`
 * (`workday/roster.ts:99`), so this function can be handed an email address, a
 * mononym, or a three-token name. A wrong split is a wrong human-readable
 * identity that a person then carries for years, and decision 1's declined token
 * could not have repaired it anyway — a token only disambiguates a name that was
 * already right. Exactly two usable tokens, or refuse.
 */
export function deriveJoinerIdentity(input: {
    readonly fullName: string;
    readonly workEmail: string;
}): DerivedIdentity {
    const name = String(input.fullName ?? '').trim();
    const address = emailKey(input.workEmail);
    const domain = address ? address.split('@')[1] : undefined;

    // The EMAIL_FALLBACK arm, and it is checked first because it is the one the
    // normaliser can actually prove: Workday's third fallback writes the work
    // email into the name column, so a name that normalises equal to the address
    // is not a name at all. Splitting it would mint `john.smith@acme.com` as a
    // local part.
    const nameSource: NameSource =
        emailKey(name) !== null && emailKey(name) === address ? 'EMAIL_FALLBACK' : 'ROSTER_DISPLAY_NAME';
    if (nameSource === 'EMAIL_FALLBACK') {
        return {
            ok: false,
            reason: 'NAME_UNDERIVABLE',
            nameSource,
            detail:
                'The only name on the employee record is the work email address itself ' +
                '(Workday writes preferredName || legalName || workEmail into one column). ' +
                'There is no first/last to split, and guessing one would mint a wrong ' +
                'human-readable identity the person then carries for years.',
        };
    }

    if (!domain) {
        return {
            ok: false,
            reason: 'NAME_UNDERIVABLE',
            nameSource,
            detail:
                'The employee record carries no usable work-email domain, so there is no ' +
                'namespace to derive an address in.',
        };
    }

    // Diacritics are folded rather than refused — José Núñez is an ordinary name
    // and an address namespace that cannot hold it is a property of the
    // namespace, not a reason to refuse the person. Anything still non-ASCII
    // after folding (a script with no ASCII form) refuses rather than being
    // transliterated by guesswork.
    const tokens = name
        .normalize('NFD')
        .replace(/\p{M}+/gu, '')
        .split(/\s+/)
        .filter((t) => t.length > 0);

    const usable = tokens.filter((t) => /^[A-Za-z][A-Za-z'’-]*$/.test(t));
    if (tokens.length !== 2 || usable.length !== 2) {
        return {
            ok: false,
            reason: 'NAME_UNDERIVABLE',
            nameSource,
            detail:
                `"${name}" does not yield exactly two usable name tokens (it yields ` +
                `${usable.length} of ${tokens.length}). A mononym, a name carrying a suffix, ` +
                'a three-part name and a non-Latin script all land here. Refuse; never guess ' +
                'a split.',
        };
    }

    const part = (t: string) => t.toLowerCase().replace(/['’]/g, '');
    const localPart = `${part(usable[0])}.${part(usable[1])}`;
    return { ok: true, localPart, address: `${localPart}@${domain}`, nameSource };
}

/** UTC day bounds for `now`. Decision 9's local-day version needs a zone nobody stores. */
function utcDayWindow(now: Date): { from: Date; to: Date } {
    const from = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
    );
    return { from, to: new Date(from.getTime() + 86_400_000) };
}

/**
 * The namespace the collision read actually covers, as a literal list.
 *
 * `email` is what `ConnectedIdentityAccount` stores, and for Entra that column
 * is `mail || userPrincipalName` — MAIL WINS (`entra-id/index.ts:111`). Create
 * -time uniqueness is enforced on `userPrincipalName`, `mailNickname` and across
 * `proxyAddresses`; for Active Directory the most collision-prone namespace is
 * `sAMAccountName`, which is persisted NOWHERE. So this list is short on purpose
 * and errs in both directions, and every decision carries it.
 */
const NAMESPACES_CHECKED: readonly string[] = ['email'];

function decide(
    candidate: JoinerCandidate,
    ctx: {
        readonly window: { from: Date; to: Date };
        readonly observed: ReadonlySet<string>;
        readonly departmentGroups: Readonly<Record<string, string>> | null;
        readonly defaultGroupId: string | null;
        readonly defaultGroupName: string | null;
    },
): JoinerDecision {
    const base = {
        employeeId: candidate.employeeId,
        intendedAddress: null,
        nameSource: null,
        department: candidate.department,
        groupId: null,
        groupIsDefaultFallback: false,
        defaultGroupName: null,
        namespacesChecked: NAMESPACES_CHECKED,
    } as const;

    // ── 1. The date. Both arms are live paths, not defensive ones.
    //
    // `deriveEmploymentStatus` returns ONBOARDING from the status STRING alone,
    // with no date, so an ONBOARDING employee with a null `startDate` is
    // reachable in real data. And the persisted column bypasses the guard the
    // status rule uses: `startDate` is a bare `new Date(row.hireDate)`
    // (`workday/roster.ts:105`) while the status rule routes the same string
    // through `parseVendorDate`, which returns null on garbage specifically so
    // it falls through.
    if (!candidate.startDate) {
        return {
            ...base,
            outcome: 'REFUSED_NO_START_DATE',
            reason:
                'The employee record carries no start date, so the joiner cannot know which ' +
                'day to act on. Decision 4 fires ON the start date; there is nothing here to ' +
                'fire on.',
        };
    }
    if (Number.isNaN(candidate.startDate.getTime())) {
        return {
            ...base,
            outcome: 'START_DATE_UNPARSEABLE',
            reason:
                'The stored start date is an Invalid Date — the roster writes `new Date(hireDate)` ' +
                'without the vendor-date guard the status rule uses, so a malformed value reaches ' +
                'the column intact.',
        };
    }

    // Outside the window is not a refusal and not an error: this person starts
    // on another day. They are reported so the artefact shows the whole
    // population that was considered, with the reason stated plainly.
    const startedMs = candidate.startDate.getTime();
    if (startedMs < ctx.window.from.getTime() || startedMs >= ctx.window.to.getTime()) {
        return {
            ...base,
            outcome: 'NOT_IN_WINDOW',
            reason:
                `Starts ${candidate.startDate.toISOString()}, which is outside the window ` +
                `${ctx.window.from.toISOString()} – ${ctx.window.to.toISOString()}. Decision 4 ` +
                'fires on the start date, not before it.',
        };
    }

    // ── 2. Decision 6, and it is deliberately BEFORE the identifier rail.
    //
    // A MANUAL employee has no `externalId` by design, so it would fall into
    // REFUSED_IDENTIFIER_UNSTABLE below and be reported as a data-quality
    // problem somebody could go and fix. It is not one: a MANUAL row has no
    // HRIS behind it at all, so there is no system to write the created address
    // back to, and no run of any sync will ever give it a handle. The owner
    // asked for an explicit refusal with a named reason rather than a silent
    // exclusion — which is what a freshness or `source` filter in the query
    // would have been.
    if (candidate.source.trim().toUpperCase() === 'MANUAL') {
        return {
            ...base,
            outcome: 'REFUSED_SOURCE_MANUAL',
            reason:
                'This employee was entered by hand (source: MANUAL), not synced from an HRIS. ' +
                'The joiner refuses it by name rather than filtering it out: a MANUAL row has ' +
                'no HRIS record to write the new work email back to and no stable external id ' +
                'to address one with, so a created account could never be reconciled with the ' +
                'roster. Create the person in the HRIS if they should be provisioned.',
        };
    }

    // ── 3. A stable handle. Without one there is nothing to key a later
    // write-back on, and nothing that survives a domain change.
    const externalId = candidate.externalId?.trim() ?? '';
    if (externalId.length === 0) {
        return {
            ...base,
            outcome: 'REFUSED_IDENTIFIER_UNSTABLE',
            reason:
                'The employee has no external id from its HRIS, so there is no stable handle ' +
                'to address the Phase 2 write-back with.',
        };
    }
    if (emailKey(externalId) === emailKey(candidate.workEmail)) {
        return {
            ...base,
            outcome: 'REFUSED_IDENTIFIER_UNSTABLE',
            reason:
                'The external id IS the work email — the last arm of the roster fallback chain ' +
                '(`employeeId || workerId || workEmail`). It moves the day the domain changes, ' +
                'so it is not a handle.',
        };
    }

    // ── 4. The identity. One deriver, no mode parameter — see its docblock.
    const derived = deriveJoinerIdentity({
        fullName: candidate.fullName,
        workEmail: candidate.workEmail,
    });
    if (!derived.ok) {
        return {
            ...base,
            outcome: 'REFUSED_NAME_UNDERIVABLE',
            nameSource: derived.nameSource,
            reason: derived.detail,
        };
    }

    const withIdentity = {
        ...base,
        intendedAddress: derived.address,
        nameSource: derived.nameSource,
    };

    // ── 5. DECISION 1 — refuse on divergence.
    //
    // The joiner declines to create unless the address is guaranteed to match.
    // "Match" is not an aesthetic: `reconcileIdentityAccountLinks` joins
    // `Employee.workEmail` to `ConnectedIdentityAccount.email` through
    // `emailKey`, and the leaver acts ONLY on linked accounts. An account
    // created at an address the roster does not hold for this person is an
    // account no link ever covers — i.e. one the leaver can never disable, which
    // is the joiner's worst failure landing in the leaver's blast radius months
    // later, on a termination.
    //
    // In Phase 2 the HRIS write-back is what makes the two converge. Phase 1 has
    // no write-back, so the guarantee has exactly one source: the address the
    // roster already holds. Where the derivation disagrees with it, refuse.
    if (emailKey(derived.address) !== emailKey(candidate.workEmail)) {
        return {
            ...withIdentity,
            outcome: 'REFUSED_IDENTITY_DIVERGES',
            reason:
                `The derived address (${derived.address}) is not the address the roster holds ` +
                `for this person (${candidate.workEmail}). Creating it would produce an account ` +
                'the link matcher never joins to this employee — and therefore one the leaver ' +
                'can never disable. The HRIS write-back that would make the two agree is Phase 2; ' +
                'until it exists the joiner refuses rather than creating an orphan.',
        };
    }

    // ── 6. ALREADY_PROVISIONED, checked after every derivation refusal.
    //
    // This inverts the leaver, which returns ALREADY_DISABLED before its
    // write-target rail. The reason is specific to a create in DRY_RUN: checked
    // FIRST, a fresh link turns every derivation problem into a clean skip, and
    // the derivation problems are exactly what the seven days exist to surface
    // before Phase 2 can act on them. Checked here, a provisioned worker still
    // reports an underivable name.
    if (candidate.hasFreshLink) {
        return {
            ...withIdentity,
            outcome: 'ALREADY_PROVISIONED',
            reason:
                'This worker already holds a directory link re-observed by a complete sync. ' +
                'Idempotency, not a failure.',
        };
    }

    // ── 7. The collision read. One namespace, and NEVER rendered as "available".
    if (ctx.observed.has(emailKey(derived.address) ?? '')) {
        return {
            ...withIdentity,
            outcome: 'ACCOUNT_OBSERVED',
            reason:
                `The last complete enumeration holds an account at ${derived.address} that is ` +
                'not linked to this worker. Fix the link; do not create. Decision 1 declines the ' +
                'collision-token arm, so the joiner never routes around this by renaming.',
        };
    }

    // ── 8. Entitlement (decisions 5 and 10). Both names recorded, never one.
    const department = candidate.department?.trim() ?? '';
    const mapped = ctx.departmentGroups && department.length > 0
        ? ctx.departmentGroups[department]
        : undefined;
    const groupId = mapped ?? ctx.defaultGroupId;

    return {
        ...withIdentity,
        outcome: 'PLANNED',
        reason: null,
        groupId: groupId ?? null,
        // Decision 5's binding mitigation, now IMPLEMENTED (#2713): a row
        // recording only the department says a fallback happened but not TO
        // WHAT. Both names travel together — the department verbatim above,
        // and the fallback group's name here, populated only when the fallback
        // was actually taken.
        groupIsDefaultFallback: mapped === undefined,
        defaultGroupName: mapped === undefined ? ctx.defaultGroupName : null,
    };
}


/**
 * Plan one DRY_RUN joiner pass. Pure: no IO, no directory, no clock of its own.
 *
 * ═══ GATE ORDER, AND WHY ASSEMBLY COMES FIRST ═══
 *
 * The leaver checks the ladder before assembling candidates, for a reason it
 * states plainly: *"a tenant in DISABLED mode must not generate directory
 * traffic to discover that it is in DISABLED mode"* — the ordering argument is
 * about DIRECTORY traffic. Joiner assembly generates none, so the argument does
 * not carry across, and the opposite ordering is worth more: a `MODE_DISABLED`
 * row carrying `starters: 3` is the most actionable row on the page, and the
 * empty-page-versus-dead-worker ambiguity the leaver tolerates over a seven-day
 * watch is not tolerable on the morning somebody is sitting at a desk with no
 * account. The starter count is therefore carried by BOTH ladder refusals.
 */
export function planJoinerPass(input: JoinerPlanInput): JoinerPlan {
    const starters = input.starters.length;
    const limits = predictionLimits(input);
    const refuse = (refusal: JoinerPassRefusal, detail: string, decisions: readonly JoinerDecision[] = []): JoinerPlan => ({
        mode: input.mode,
        clamp: JOINER_MAX_MODE,
        refusal,
        detail,
        starters,
        wouldCreate: 0,
        decisions,
        predictionLimits: limits,
    });

    // ── 1. The ladder, carrying the count.
    if (input.mode === 'DISABLED') {
        return refuse(
            'MODE_DISABLED',
            `Joiner writes are switched off for this tenant. ${starters} starter(s) were assembled ` +
                'and nothing was planned for any of them.',
        );
    }
    if (isAboveClamp(input.mode, JOINER_MAX_MODE)) {
        return refuse(
            'MODE_ABOVE_CLAMP',
            `This tenant is configured at ${input.mode}, but the joiner pass is clamped at ` +
                `${JOINER_MAX_MODE}. The clamp is a source constant, not a tenant setting — raising ` +
                'it is a reviewed code change and a deploy, not something an administrator can ' +
                `switch on. ${starters} starter(s) were assembled; nothing was created, and nothing ` +
                'was sent to any directory.',
        );
    }

    // ── 2. Nobody to plan for. The boring daily row that proves the pass ran.
    if (starters === 0) {
        return refuse('NO_STARTERS', 'No employee is marked as starting in the window.');
    }

    // ── 3. Per-candidate decisions, computed BEFORE the tenant-level entitlement
    // refusals below. A pass that returned early on an unconfigured group map
    // would throw away the identity verdicts, and those verdicts are the whole
    // reason the rung exists: they are what makes a wrong derivation visible
    // seven days before it could create a wrong account.
    const observed = new Set(
        input.observedAddresses.map((a) => emailKey(a)).filter((a): a is string => a !== null),
    );
    const window = utcDayWindow(input.now);
    const decisions = input.starters.map((c) =>
        decide(c, {
            window,
            observed,
            departmentGroups: input.departmentGroups,
            defaultGroupId: input.defaultGroupId,
            defaultGroupName: input.defaultGroupName,
        }),
    );
    const planned = decisions.filter((d) => d.outcome === 'PLANNED');

    // ── 4. Decision 7's cap, BEFORE the configuration refusals below.
    //
    // Ordered that way because the two answer different questions and only one
    // of them is about today. An unconfigured group map is a standing state an
    // operator fixes once; a batch over the cap is an ANOMALY in this morning's
    // data — thirty people "starting" today is a roster fault or a status
    // mapping bug, and it must not be hidden behind a configuration notice that
    // will be there tomorrow as well. Refused WHOLE, never trimmed.
    if (planned.length > MAX_CREATES_PER_RUN) {
        return refuse(
            'BATCH_OVER_CAP',
            `${planned.length} creations would be proposed, above the per-run cap of ` +
                `${MAX_CREATES_PER_RUN}. The whole batch is refused rather than trimmed: trimming ` +
                'performs part of a probably-wrong action and hides the anomaly behind a number ' +
                'that looks deliberate.',
            decisions,
        );
    }

    // ── 5. Decisions 10 and 5 — the entitlement configuration.
    //
    // Group membership is the privilege half of a create, which is why both
    // halves sit behind the OWNER gate. Decision 10 was REVISED 2026-09-21
    // (#2713): the RULES live in `IdentityDepartmentGroupRule`, one row each
    // so a rule carries its own provenance, and the SINGULAR fallback lives
    // on `TenantSecuritySettings` as `identityDefaultGroupId` +
    // `identityDefaultGroupName`. Both refusals below are reachable, and
    // as of #2839 NOT yet fixable by a tenant: #2713 shipped the schema and
    // the planner's reader, but nothing in `src/` WRITES either half, so
    // every tenant lands here and no operator surface can move them off it.
    // The refusals are correct; what is missing is the write path.
    if (!input.departmentGroups || Object.keys(input.departmentGroups).length === 0) {
        return refuse(
            'NO_DEPARTMENT_MAP',
            'No department → security-group map is configured for this tenant (decision 10, as ' +
                'revised 2026-09-21, puts the rules in IdentityDepartmentGroupRule and the singular ' +
                'fallback on TenantSecuritySettings, both behind the OWNER gate). Without it a create cannot ' +
                'say which group it would add the person to, and a create that grants no ' +
                'entitlement is an account nobody can work from. The identity decisions below were ' +
                'still computed.',
            decisions,
        );
    }
    if (!input.defaultGroupId) {
        return refuse(
            'NO_DEFAULT_GROUP',
            'No default security group is configured. Decision 5 accepts falling back to a ' +
                'default for an unmapped department, on the binding condition that the fallback ' +
                'has a name — a typo\'d or brand-new department is otherwise indistinguishable ' +
                'from a mapped one. Configure the default, or the fallback is a silent guess.',
            decisions,
        );
    }

    return {
        mode: input.mode,
        clamp: JOINER_MAX_MODE,
        refusal: null,
        detail:
            `${planned.length} of ${starters} starter(s) would be provisioned. Nothing was written ` +
            'to any directory, to the HRIS, or to this database: DRY_RUN plans and stops.',
        starters,
        wouldCreate: planned.length,
        decisions,
        predictionLimits: limits,
    };
}

/**
 * What this dry run could not know — carried on EVERY plan, including refused
 * ones, and written for the operator rather than for us.
 *
 * The design requires this from the first run and names the reason: an artefact
 * that says "would create 34 accounts" is silent about 34 HRIS write-backs never
 * attempted, and about a collision read that did not cover the namespace the
 * create would actually have been rejected in. A number with no bound on it is
 * how a dry run becomes a promise.
 */
function predictionLimits(input: JoinerPlanInput): readonly string[] {
    const limits = [
        'The HRIS write-back is Phase 2 and has never been attempted. A planned creation says ' +
            'nothing about whether the new address could be written back to the HRIS — which is ' +
            'the step whose failure leaves an orphaned account nobody can match to a person.',
        'The collision read covers the stored `email` column only (for Entra that is ' +
            '`mail || userPrincipalName`). Create-time uniqueness is enforced on ' +
            '`userPrincipalName`, `mailNickname` and `proxyAddresses`, and on Active Directory ' +
            'most often on `sAMAccountName`, which this product persists nowhere. A plan that ' +
            'found no conflict is NOT a statement that the address is available.',
        'No reservation is persisted. Two runs therefore cannot be compared, so a derived ' +
            'identity that DRIFTS between runs (a renamed employee, a changed domain) is not ' +
            'detectable yet — the reservation that would detect it needs the pre-hire model ' +
            'decision 2 puts outside Employee.',
    ];

    if (!input.timeZone) {
        limits.push(
            'The start-date window was computed in UTC. Decision 9 fires dispatch on the ' +
                "tenant's own timezone, and no timezone is stored for this tenant — so a person " +
                'whose local start date falls either side of midnight UTC can be planned a day ' +
                'early or a day late.',
        );
    }

    return limits;
}
