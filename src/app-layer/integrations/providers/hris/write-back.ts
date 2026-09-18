/**
 * HRIS write-back — the vocabulary and the credential gate. THERE IS NO WRITE
 * HERE, and nothing in this file may grow one.
 *
 * ═══ WHAT PHASE 1 IS ═══
 *
 * `docs/jml-hris-write-back-design.md` phases the outbound work-email write:
 * Phase 0 made the address exist (`Employee.hrisRecordId`, #2549), Phase 1 is
 * "credential and vocabulary. No writes", and Phase 2 is the write itself —
 * which "must not ship before the joiner settles what a pre-hire is. It has no
 * subject until then."
 *
 * So this module names the three things a write will later need permission
 * from, and stops:
 *
 *   · `writeBackEnabled` — the per-connection opt-in, read STRICTLY;
 *   · `HRIS_WRITEBACK_MAX_MODE` — the source-constant ceiling, sorted ordinally
 *     against `LADDER`;
 *   · the preflight seam and its outcome vocabulary — a LIVE check of whether
 *     the credential could write, performed WITHOUT writing.
 *
 * The product has never written a byte to any HRIS. All three mutating HTTP
 * calls in the HRIS providers are non-writes: `workday/token.ts` and
 * `orangehrm/token.ts` are OAuth token exchanges, and the BambooHR call in
 * `hris/index.ts` is the custom-report endpoint — a READ expressed as a POST,
 * whose body is a field list and whose response is the roster. (The write sites
 * in `usecases/hris-sync.ts` write the LOCAL DATABASE. A local-DB write is not
 * an HRIS write.) That remains true after this file lands, and a reviewer can
 * check it the same way: grep the providers tree for a mutating method.
 *
 * ═══ WHY THE FLAG IS ITS OWN, AND NOT `writesEnabled` ═══
 *
 * Owner decision, 2026-09-19. Entra's per-connection `writesEnabled`
 * (`entra-id/index.ts`, enforced in `entra-id/writer.ts`) is consent to DISABLE
 * ACCOUNTS IN A DIRECTORY. An HRIS write-back is a different vendor's token
 * with a different blast radius — it puts a value into a customer's system of
 * record, where the correction is made by hand, in their system, by someone who
 * does not know we did it. Riding on a flag an administrator ticked for
 * directory writes would be consent by accident.
 *
 * Two flags therefore, and they are never read together: nothing here looks at
 * `writesEnabled` and the Entra writer will never look at this one.
 *
 * ═══ WHY BAMBOOHR DOES NOT DECLARE THE FIELD, WHICH IS A DECISION ═══
 *
 * Decision 1 of the design settles BambooHR as the first CUSTOMER target, and
 * that has not changed. What has not been settled is Open Question 1 — whether
 * BambooHR exposes an employee-update API at the same gateway base with the
 * same Basic auth — and the design is explicit that it is not merely unanswered
 * but UNANSWERABLE from this repo: there is no BambooHR tenant to ask, and
 * `liveValidation = false` on that provider means nothing in the product has
 * ever proven that credential does anything at all.
 *
 * A checkbox is a question put to a customer. Putting "allow HRIS write-back"
 * on a connection whose credential we described to them as "A read-only
 * BambooHR API key", for a write we cannot attempt and a preflight we cannot
 * run, asks them to grant something neither side can verify — the same shape of
 * accidental consent the owner decision above exists to refuse, one level up.
 * So BambooHR gets the field on the day its preflight can run, which is the day
 * Open Question 1 is answered by a real tenant, and not before. #2607 is the
 * standing policy that the evidence comes from OrangeHRM in the meantime.
 *
 * `tests/unit/hris-write-back-preflight.test.ts` pins that absence, so adding
 * the field to BambooHR is a reviewed diff rather than a copy-paste.
 *
 * ═══ THE HONEST LIMIT OF A PREFLIGHT THAT DOES NOT WRITE ═══
 *
 * A credential's permission to write is a property of the credential, invisible
 * from a stored value — BambooHR has no scope string at all, and Workday's
 * scopes survive a refresh unchanged and unreported. The design's conclusion is
 * that scope is "unobservable from stored state" and must be proven "by
 * attempting something".
 *
 * Phase 1 attempts nothing that mutates. So the strongest honest verdict this
 * file can reach is `WRITE_PATH_READABLE`: the credential authenticates, a
 * roster read yields an address a write could be sent TO, and the exact field a
 * write would target is READABLE at the exact per-record path the write would
 * be addressed through. That is three of the four prerequisites. The fourth —
 * that the credential may mutate — stays unproven, which is why every result
 * this module builds carries `writeProven: false` as a literal-typed field.
 * Turning it true is a type change, therefore a diff somebody reviews, and it
 * belongs to Phase 2.
 *
 * @module integrations/providers/hris/write-back
 */
import { isAboveClamp, type IdentityWriteMode } from '@/lib/identity/write-ladder';

/**
 * The per-connection opt-in's key, stated ONCE.
 *
 * A provider's `configSchema` declares it, `CONFIG_FIELD_RULES` classifies it,
 * and `readWriteBackEnabled` reads it. Three places that must agree about a
 * string; the two that are code import it from here, and the third is a
 * hand-written table a test cross-walks. `writesEnabled` is spelled as a
 * literal in each of its own three sites, which is survivable at three and is
 * not the pattern to copy.
 */
export const WRITE_BACK_ENABLED_FIELD = 'writeBackEnabled';

/**
 * The highest rung an HRIS write-back will act at.
 *
 * ═══ WHY IT IS `DRY_RUN` AND NOT `AUTOMATIC` ═══
 *
 * Because there is no write. A tenant at `AUTOMATIC` has granted the joiner
 * standing authority to act unattended (Decision 2: the write-back inherits the
 * joiner's rung rather than getting a third `IdentityDirection`), and Phase 1
 * has nothing to do with that authority beyond declining it. The clamp is the
 * declining.
 *
 * ═══ WHY IT IS A SOURCE CONSTANT ═══
 *
 * The same argument `LEAVER_MAX_MODE` makes in `identity-leaver-pass.ts`:
 * raising it must be a diff somebody reviews, not a setting somebody flips, and
 * lowering it is "the brake you reach for at 05:05 after a pass did something
 * you did not expect". The write-back needs its OWN brake rather than sharing
 * the leaver's, because it touches a different vendor with a different failure
 * mode, and an incident in the HRIS write must be stoppable without also
 * stopping account creation.
 *
 * ═══ AND WHY IT LANDS NOW RATHER THAN WITH THE WRITE ═══
 *
 * `write-ladder.ts` warns, about the joiner's absent clamp, that "a clamp
 * constant with no pass reading it is a fourth thing to keep in sync". The
 * warning is about a constant with NO READER. This one has a reader in the same
 * commit — `gateWriteBackPreflight` below, which is reached by
 * `OrangeHrmProvider.writeBackPreflight` — so it is load bearing on the day it
 * lands rather than decorative until Phase 2.
 *
 * ═══ ORDINAL, NEVER `mode !== HRIS_WRITEBACK_MAX_MODE` ═══
 *
 * `isAboveClamp`, for the reason `identity-leaver-pass.ts` spells out: with the
 * clamp anywhere but the top rung, the inequality refuses tenants that are
 * BELOW it.
 *
 * Stated honestly, the two spellings agree TODAY, because the only rungs left
 * once `DISABLED` is handled separately are `DRY_RUN` (equal to the clamp) and
 * `AUTOMATIC` (above it). They stop agreeing the moment Phase 2 raises this
 * constant to `AUTOMATIC` — at which point `!==` would refuse every `DRY_RUN`
 * tenant, which is the refusal that records nothing and leaves the page blank.
 * Writing the comparison correctly now means that raise is a one-token change
 * and not a one-token change plus a defect.
 *
 * Unlike the leaver's clamp branch — unreachable, because `LEAVER_MAX_MODE` is
 * the TOP rung and nothing sorts above it — this one is reachable today by any
 * tenant at `AUTOMATIC`, and is covered by a test that does not have to invent
 * a mode.
 */
export const HRIS_WRITEBACK_MAX_MODE: IdentityWriteMode = 'DRY_RUN';

/**
 * What a preflight concluded. Every member is a statement about the CONNECTION,
 * decided once for a batch — never about one candidate.
 *
 * Deliberately NOT the design's full outcome table (`WRITEBACK_CONFIRMED`,
 * `WRITEBACK_NOOP`, `REFUSED_HRIS_DIVERGED`, …). Those describe the result of a
 * write, they belong to Phase 2, and coining them here would put names in the
 * codebase for acts nothing performs — the kind of vocabulary that reads as
 * shipped.
 */
export type HrisWriteBackPreflightOutcome =
    /**
     * The credential authenticated, a roster read yielded an address, and the
     * field a write would target was READ at the path the write would use.
     *
     * NOT "the credential can write" — see the module docblock. The name says
     * what was actually established: the write PATH is readable.
     */
    | 'WRITE_PATH_READABLE'
    /** The connection has not opted in. The design's `HRIS_WRITEBACK_UNAVAILABLE`. */
    | 'REFUSED_WRITE_BACK_DISABLED'
    /** The tenant's rung is `DISABLED`, or above `HRIS_WRITEBACK_MAX_MODE`. */
    | 'REFUSED_MODE'
    /**
     * The roster read SUCCEEDED and carried no address a write could be sent
     * to. Reserved for that: a roster read that FAILED proves nothing about
     * what the roster holds, and is reported as indeterminate instead.
     */
    | 'REFUSED_NO_HANDLE'
    /**
     * An address was obtained, and the field a write would target could not be
     * read at the per-record path — including the case where the vendor serves
     * that path happily and the field is simply not in its shape.
     */
    | 'REFUSED_IDENTITY_FIELD_UNREADABLE'
    /**
     * The vendor PROVED the credential is not usable — a 401 or 403, or a
     * connection that cannot be assembled into a request at all.
     */
    | 'REFUSED_CREDENTIAL'
    /**
     * No proof either way: a timeout, a reset, a 5xx, an unrecognised failure.
     *
     * The same failure direction `DirectoryWriteError.definitivelyNotApplied`
     * takes, and for the same reason — "unsure" must never be recorded as a
     * property of the credential, because a refusal decided once for a batch is
     * sound only when it is proven.
     */
    | 'PREFLIGHT_INDETERMINATE';

/**
 * A preflight's verdict, with the observations it rests on kept separate from
 * the verdict itself.
 *
 * Three booleans rather than one summary, because they fail independently and
 * the difference is the measured finding this whole seam is shaped around:
 * OrangeHRM's list response carries the write-back handle (`empNumber`) and
 * does NOT carry the work email at all, at any `model` — proved by A/B against
 * a live 5.9, since the same employee's contact-details endpoint returns an
 * address the list row omits (#2587). "Handle present, identity field absent"
 * is a real vendor shape, so a result that collapsed both into one flag could
 * not describe the instance it was run against.
 */
export interface HrisWriteBackPreflightResult {
    readonly outcome: HrisWriteBackPreflightOutcome;
    /** Provider id the preflight ran for. */
    readonly provider: string;
    /** Did the credential authenticate at all? */
    readonly authenticated: boolean;
    /** Did a roster read yield an address a write could be sent to? */
    readonly handleObserved: boolean;
    /**
     * Was the field a write would target READ at the per-record path the write
     * would be addressed through?
     *
     * True for a field that is present and EMPTY. An empty work-email field is
     * the expected pre-hire state and the case the write exists for; it is the
     * key being ABSENT FROM THE SHAPE that says the path cannot carry the
     * write. Sibling keys come back as explicit `null` on OrangeHRM 5.9, which
     * is what makes those two distinguishable at all.
     */
    readonly identityFieldReadable: boolean;
    /**
     * ALWAYS false, and typed as the literal so it cannot be set otherwise.
     *
     * Phase 1 does not write, so nothing in this repo has evidence that any
     * HRIS credential may mutate anything. Widening this to `boolean` is the
     * type change that makes Phase 2 visible in review.
     */
    readonly writeProven: false;
    /**
     * One sentence an operator can act on. Carries statuses and field names;
     * never a work email, a client secret or an access token — the probe reads
     * a real person's contact record and the VALUE is nobody's business here,
     * only whether the key was there.
     */
    readonly detail: string;
}

/**
 * Build a result, and refuse to build a dishonest one.
 *
 * The invariant is the point: `WRITE_PATH_READABLE` is a claim about three
 * observations, so it may not be constructed unless all three were made. A
 * provider that returns the verdict while having skipped a call throws here
 * rather than reporting a green it did not earn — the failure mode
 * `orangehrm/index.ts` already argues about for its unreachable `runCheck`.
 *
 * It throws rather than downgrading, because a downgrade would be this module
 * guessing at what the caller meant to observe, and the caller is the only
 * thing that knows.
 */
export function writeBackPreflightResult(input: {
    outcome: HrisWriteBackPreflightOutcome;
    provider: string;
    detail: string;
    authenticated?: boolean;
    handleObserved?: boolean;
    identityFieldReadable?: boolean;
}): HrisWriteBackPreflightResult {
    const result: HrisWriteBackPreflightResult = {
        outcome: input.outcome,
        provider: input.provider,
        authenticated: input.authenticated ?? false,
        handleObserved: input.handleObserved ?? false,
        identityFieldReadable: input.identityFieldReadable ?? false,
        writeProven: false,
        detail: input.detail,
    };
    if (
        result.outcome === 'WRITE_PATH_READABLE' &&
        !(result.authenticated && result.handleObserved && result.identityFieldReadable)
    ) {
        throw new Error(
            'HRIS write-back preflight reported WRITE_PATH_READABLE without all three observations ' +
                `(authenticated=${result.authenticated}, handleObserved=${result.handleObserved}, ` +
                `identityFieldReadable=${result.identityFieldReadable})`,
        );
    }
    return result;
}

/**
 * Is this connection opted in to HRIS write-back?
 *
 * STRICT `=== true`, copying the Entra writer's comparison rather than
 * paraphrasing it. A value that merely LOOKS affirmative is not a considered
 * grant: `configJson` is written from an admin form whose controls all produce
 * strings, and the string `'true'` reaching this comparison means a checkbox
 * that ticks, saves and reloads ticked while the capability stays off.
 *
 * `coerceDeclaredBooleans` is what makes that not happen — it converts exactly
 * the two spellings the checkbox emits, for exactly the keys a provider
 * declares as `type: 'boolean'`. So the strictness costs nothing for a value
 * that came from the form, and `describeWriteBackEnabled` exists for the value
 * that did not.
 */
export function readWriteBackEnabled(config: Record<string, unknown>): boolean {
    return config[WRITE_BACK_ENABLED_FIELD] === true;
}

/**
 * The trailing half of the refusal, when the STORED VALUE is the reason rather
 * than the absence of one.
 *
 * Empty for a plainly absent opt-in, where the base message already says
 * everything. The extra sentence is earned only by a value an operator would
 * reasonably read as an opt-in, because that is the case where repeating "turn
 * it on" describes something they have already done. Modelled on
 * `describeWritesEnabled` in `entra-id/writer.ts`, which was written after
 * exactly that support round trip.
 */
export function describeWriteBackEnabled(value: unknown): string {
    if (value === undefined || value === null || value === false) return '';
    const shown = typeof value === 'string' ? JSON.stringify(value) : String(value);
    const looksAffirmative =
        (typeof value === 'string' && ['true', 'yes', 'on', '1'].includes(value.trim().toLowerCase())) ||
        value === 1;
    if (!looksAffirmative) {
        return (
            ` (This connection stores ${WRITE_BACK_ENABLED_FIELD} as ${typeof value} ${shown}, which is not ` +
            'an opt-in: the flag is compared strictly against the boolean true.)'
        );
    }
    return (
        ` (This connection stores ${WRITE_BACK_ENABLED_FIELD} as the ${typeof value} ${shown} rather than the ` +
        'boolean true, so the flag reads as ON in the admin UI and OFF here — the opt-in is compared ' +
        'strictly, on purpose, because a value that merely looks affirmative is not a deliberate grant of ' +
        'permission to write into a customer system of record. Re-save the connection, or correct the ' +
        'stored value to a JSON boolean.)'
    );
}

/**
 * Everything settleable WITHOUT touching the network. Returns a refusal, or
 * `null` meaning "go and look".
 *
 * ═══ THE ORDER, WHICH IS NOT ARBITRARY ═══
 *
 * The rung first, the opt-in second. Both are free, so this is not about cost:
 * the rung is the TENANT's own statement about how much autonomy this product
 * has, and the opt-in is one connection's statement about one credential. A
 * tenant at `DISABLED` has said no to the whole direction, and reporting
 * "this connection is not enabled for write-back" to them would invite them to
 * tick a box that changes nothing.
 *
 * ═══ WHY `mode` IS A PARAMETER AND NOT A READ ═══
 *
 * Per Decision 2 the write-back inherits the JOINER's rung — there is no third
 * `IdentityDirection` and no third pair of columns — so the value belongs to
 * `getIdentityWritePolicy(ctx).joiner.mode`. Reading it here would pull prisma
 * and the tenant-context helpers into this module and, through it, into every
 * provider that imports the seam. `write-ladder.ts` carries no server imports
 * for the same reason. The caller has the context; it passes the rung.
 *
 * The mode handed in must already have been through `coerceStoredMode` at the
 * read boundary, which `getIdentityWritePolicy` does. That is not a formality:
 * `isAboveClamp` sorts an unrecognised mode to -1, which reads as NOT above the
 * clamp — the permissive direction — so a raw column value reaching this
 * function would be a value that sails through a ceiling.
 */
export function gateWriteBackPreflight(input: {
    provider: string;
    config: Record<string, unknown>;
    mode: IdentityWriteMode;
}): HrisWriteBackPreflightResult | null {
    const { provider, config, mode } = input;

    if (mode === 'DISABLED') {
        return writeBackPreflightResult({
            outcome: 'REFUSED_MODE',
            provider,
            detail:
                'Identity writes are switched off for this tenant, so the HRIS write-back preflight did not run.',
        });
    }
    if (isAboveClamp(mode, HRIS_WRITEBACK_MAX_MODE)) {
        return writeBackPreflightResult({
            outcome: 'REFUSED_MODE',
            provider,
            detail:
                `This tenant is configured at ${mode}, above the HRIS write-back ceiling of ` +
                `${HRIS_WRITEBACK_MAX_MODE}. The write itself is Phase 2 of ` +
                'docs/jml-hris-write-back-design.md and does not exist yet.',
        });
    }
    if (!readWriteBackEnabled(config)) {
        return writeBackPreflightResult({
            outcome: 'REFUSED_WRITE_BACK_DISABLED',
            provider,
            detail:
                'This connection is not enabled for HRIS write-back. Turn on "Allow HRIS write-back" on the ' +
                'connection — it is a separate opt-in from directory writes, because it is a different ' +
                'vendor’s credential writing into the customer system of record.' +
                describeWriteBackEnabled(config[WRITE_BACK_ENABLED_FIELD]),
        });
    }
    return null;
}

/**
 * A provider that can prove — without writing — what its stored credential can
 * reach.
 *
 * SEPARATE FROM `HrisSyncProvider`, and separate from `DirectoryWriter`.
 *
 * Not on `HrisSyncProvider` because every registered HRIS provider implements
 * that one and only OrangeHRM can honour this: BambooHR's credential cannot be
 * probed live at all and Workday's roster surface is a customer-authored report
 * that accepts nothing. Widening the sync interface would make two providers
 * owe a method they must answer dishonestly.
 *
 * Not `DirectoryWriter.preflight` because that interface is `readState` /
 * `disable` / `preflight` over a DIRECTORY ACCOUNT. Forcing an HRIS record into
 * it would put a non-directory verb into the leaver's writer factory, as the
 * design says at length.
 */
export interface HrisWriteBackPreflightProvider {
    /**
     * @param config merged connection config + decrypted secrets, as the sync
     *   path already hands providers.
     * @param mode the tenant's JOINER rung, already coerced. See
     *   `gateWriteBackPreflight`.
     */
    writeBackPreflight(
        config: Record<string, unknown>,
        mode: IdentityWriteMode,
    ): Promise<HrisWriteBackPreflightResult>;
}

/** Membership test, mirroring `isHrisSyncProvider`. */
export function isHrisWriteBackPreflightProvider(p: unknown): p is HrisWriteBackPreflightProvider {
    return (
        typeof p === 'object' &&
        p !== null &&
        typeof (p as HrisWriteBackPreflightProvider).writeBackPreflight === 'function'
    );
}
