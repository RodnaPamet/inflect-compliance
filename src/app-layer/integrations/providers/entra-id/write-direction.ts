/**
 * Which DIRECTION a connection consented to write in — #2674, owner decision 8.
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHY ONE BOOLEAN IS NOT ENOUGH, AND WHY THAT IS A SECURITY STATEMENT
 * ═══════════════════════════════════════════════════════════════════
 *
 * `writer.ts` has always held ONE per-connection flag, `writesEnabled`, and
 * its refusal could not say which direction had been asked for — because
 * until the joiner there was only one. The joiner ends that, and the reason
 * it cannot simply reuse the flag is written in this directory's own
 * consent list (`writer.ts`, `WRITE_ROLES`):
 *
 *     User.EnableDisableAccount.All
 *     User.ReadWrite.All
 *     Directory.ReadWrite.All
 *
 * Creating a user requires one of the latter two, and BOTH are members of
 * that list. So any consent sufficient to CREATE is, by this repo's own
 * list, sufficient to DISABLE, and `hasWriteRole` stops objecting. **The
 * least-privilege separation the leaver relies on does not survive the
 * joiner at the credential layer.** A client-credentials token asks for
 * `.default`, which is not a request at all — it returns exactly what an
 * administrator already consented — so there is no call-time scoping to
 * fall back on either.
 *
 * That leaves the per-connection flag as the ONLY place the separation can
 * be stated, which is what `docs/jml-joiner-design.md` means when it says:
 * *"Either add a per-direction writes flag, or state plainly that enabling
 * joiner writes grants standing disable authority at the credential layer.
 * Silence here decides it by omission."* This module is the first branch.
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHAT AN EXISTING `writesEnabled: true` MEANS NOW — THE NARROW READING
 * ═══════════════════════════════════════════════════════════════════
 *
 * **It grants the LEAVER direction and nothing else.** Every connection
 * already storing it keeps exactly the authority it had the day it was
 * ticked, and gains none.
 *
 * This is a decision, not a default that fell out, so here is the argument:
 *
 *   1. THE FIELD'S OWN COPY SAYS SO. Its label is "Allow offboarding
 *      writes" and its description is "Let leaver offboarding DISABLE
 *      accounts in this directory." An administrator who ticked that box
 *      consented to disables. Reading it as also covering creates would
 *      grant an authority the checkbox never described — consent by
 *      accident, which is the precise failure the sibling HRIS flag
 *      (`providers/hris/write-back.ts`) was given its own switch to avoid.
 *
 *   2. THE CREDENTIAL CANNOT RE-IMPOSE THE SEPARATION. See `WRITE_ROLES`
 *      above. If the flag does not separate the directions, nothing does.
 *
 *   3. THE ERROR IS ASYMMETRIC. Reading it narrowly costs an operator one
 *      deliberate extra grant on the day the joiner ships. Reading it
 *      widely silently hands every existing writing tenant the power to
 *      CREATE accounts in their directory, retroactively, with no diff on
 *      their side. One of those is recoverable by a support ticket.
 *
 * The converse holds by the same argument and is tested with it: a joiner
 * grant does NOT imply a leaver grant. Neither direction is a superset of
 * the other here; they are two separate statements about one credential.
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHY THE JOINER FIELD IS NOT ON THE CONNECTION FORM YET
 * ═══════════════════════════════════════════════════════════════════
 *
 * `ENTRA_JOINER_WRITES_FIELD` is spelled here and read here, and is
 * DELIBERATELY absent from `EntraIdProvider.configSchema.configFields`.
 * `tests/unit/entra-write-direction-split.test.ts` pins that absence so
 * adding it is a reviewed diff rather than a copy-paste.
 *
 * The reasoning is `providers/hris/write-back.ts`'s, one vendor along: *"A
 * checkbox is a question put to a customer."* There is no create verb
 * behind this direction — `JOINER_MAX_MODE` is `DRY_RUN` and the live arm
 * waits on #2608 — so a box ticked
 * today would authorise nothing today and would ALREADY BE TICKED on the
 * day the create verb makes it mean something. A grant collected before
 * the capability exists is not a grant to that capability; it is the same
 * accidental consent read across time instead of across directions.
 *
 * This paragraph used to add "no dispatcher calls the planner" as a third
 * reason. #2687 landed the dispatcher and the schedule (the run route ships in its
 * route half, held back by the CI memory ceiling #2698), so
 * that clause is gone rather than left to rot. The argument is unaffected:
 * what makes a joiner-writes checkbox premature is the absent CREATE VERB,
 * not the absent trigger. A DRY_RUN pass that plans and stops authorises
 * nothing, so the box would still be a grant to a capability that does not
 * exist yet.
 *
 * So the joiner's switch arrives in the diff that ships the joiner's write,
 * and until then this direction refuses for everyone — which is the narrow
 * reading applied to itself.
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHAT THIS MODULE DELIBERATELY DOES NOT TOUCH
 * ═══════════════════════════════════════════════════════════════════
 *
 * `WRITE_ROLES` and `hasWriteRole` are unchanged. The consent list is a
 * statement about what Graph accepts, and narrowing it would refuse tenants
 * whose grant genuinely works — a false negative, for a separation this
 * flag now makes at the layer that CAN make it. The split is per
 * connection, not per role.
 *
 * @module integrations/providers/entra-id/write-direction
 */
import type { IdentityDirection } from '@/lib/identity/write-ladder';

/**
 * The leaver's opt-in. The LEGACY spelling, kept exactly.
 *
 * Renaming it would silently un-consent every connection already storing
 * it — the writer compares `=== true` against a key that would no longer be
 * there — and a migration that rewrites `configJson` for every tenant to
 * change a boolean's NAME is a write across every customer's connection
 * row for no behavioural gain. The name is worse than `leaverWritesEnabled`
 * and it stays.
 */
export const ENTRA_LEAVER_WRITES_FIELD = 'writesEnabled';

/**
 * The joiner's opt-in, spelled ONCE.
 *
 * Not declared on the connection form yet — see the module docblock. When
 * it is declared, the same three places `writeBackEnabled` needs must agree
 * about the string: the provider's `configSchema`, `CONFIG_FIELD_RULES` in
 * `config-schema.ts` (an undeclared key is rejected outright by
 * `validateProviderConfig`), and this reader. Two of those three are code
 * and import it from here.
 */
export const ENTRA_JOINER_WRITES_FIELD = 'joinerWritesEnabled';

/**
 * Named in operator-facing copy: the Graph permission an admin should
 * actually grant for the LEAVER direction.
 *
 * It lives here rather than in `writer.ts` because both the refusal copy
 * below and the writer's 403 diagnostics quote it, and a permission string
 * spelled twice in two modules is the drift this file exists to stop. It is
 * NOT the consent list — `WRITE_ROLES` stays in `writer.ts`, unchanged and
 * unwidened.
 */
export const LEAST_PRIVILEGE_WRITE_ROLE = 'User.EnableDisableAccount.All';

/** The field each direction is consented through. Never shared, by construction. */
export const ENTRA_WRITE_FLAG_FIELD: Readonly<Record<IdentityDirection, string>> = {
    leaver: ENTRA_LEAVER_WRITES_FIELD,
    joiner: ENTRA_JOINER_WRITES_FIELD,
};

/**
 * The substring `identity-writer-factory` classifies a constructor failure
 * by, exported so the message and its classifier cannot drift apart.
 *
 * It used to be an inline regex in that file, matched against a literal
 * sentence in this one — two spellings of the same string, in different
 * modules, with nothing holding them together. Naming the direction in the
 * refusal is exactly the kind of edit that breaks that pair silently, and
 * the symptom would have been a deliberate operator state
 * (`WRITES_NOT_ENABLED`) being reported as an unexplained `WRITER_REFUSED`.
 */
export const WRITES_NOT_ENABLED_PHRASE = 'not enabled for directory writes';

/** Is this constructor failure the deliberate opt-out rather than a misconfiguration? */
export function isWritesNotEnabledRefusal(detail: string): boolean {
    return detail.toLowerCase().includes(WRITES_NOT_ENABLED_PHRASE);
}

/**
 * Just the flags, so a caller can hand over a merged connection bag or the
 * writer's own config without either being widened.
 */
export interface EntraWriteFlags {
    readonly writesEnabled?: unknown;
    readonly joinerWritesEnabled?: unknown;
}

/**
 * The stored value for one direction.
 *
 * A `switch` over the direction rather than `config[FIELD[direction]]`, and
 * that is not style. A dynamic key is one typo — or one future direction
 * added to the record without a branch here — away from reading the OTHER
 * direction's flag, which is the single failure this whole module exists to
 * make impossible. The `never` arm makes a third direction a compile error
 * rather than a silent alias onto the joiner's.
 */
function storedWriteFlag(config: EntraWriteFlags, direction: IdentityDirection): unknown {
    switch (direction) {
        case 'leaver':
            return config.writesEnabled;
        case 'joiner':
            return config.joinerWritesEnabled;
        default: {
            const unreachable: never = direction;
            return unreachable;
        }
    }
}

/**
 * Has this connection opted in to writes IN THIS DIRECTION?
 *
 * STRICT `=== true`, unchanged from the single-flag original and for its
 * reason: `configJson` is written from an admin form whose controls all
 * produce strings, so the string `'true'` reaching this comparison means a
 * checkbox that ticks, saves and reloads ticked while the capability stays
 * off. `coerceDeclaredBooleans` converts exactly the two spellings the form
 * emits for keys a provider declares boolean, so the strictness costs
 * nothing for a value that came from the form — and
 * `describeStoredWriteFlag` exists for the value that did not.
 *
 * Reads ONE field. A `true` in the other direction's field is not consulted
 * and cannot contribute.
 */
export function readDirectionWritesEnabled(
    config: EntraWriteFlags,
    direction: IdentityDirection,
): boolean {
    return storedWriteFlag(config, direction) === true;
}

/**
 * What an operator should DO about a stored value that merely looks
 * affirmative — and it differs per direction, because the two fields are not
 * both on the connection form.
 *
 * The leaver's field is declared, so the admin UI has a control showing it and
 * re-saving rewrites it. The joiner's is deliberately undeclared (see the
 * module docblock), so there is no control to read as ON, `re-save the
 * connection` would not rewrite it, and `validateProviderConfig` rejects the
 * key outright — a stored value can only have arrived from outside the form.
 * Telling a joiner operator to look at a checkbox and re-save would be two
 * false statements in one sentence.
 *
 * Splitting this is precaution rather than a bug fix: the joiner sentence is
 * UNREACHABLE today, twice over, and both reasons are checked by tests.
 * `directionWriteRefusal(config, 'joiner')` has no production caller at all —
 * the only call site in `src/` is `writer.ts`'s constructor, which passes
 * `'leaver'` — and even given one, `CONFIG_FIELD_RULES['entra-id']` does not
 * list `joinerWritesEnabled`, so `validateProviderConfig` throws `Unknown
 * configuration field` before such a value could be stored. It is split now
 * because the day the create verb lands is the day this ships to an operator,
 * and a wrong sentence discovered then is discovered in a support ticket.
 */
const DIRECTION_STORED_VALUE_REMEDY: Readonly<Record<IdentityDirection, string>> = {
    leaver:
        'Other booleans on this same connection are read through a string-coercing helper and WILL ' +
        'be on, which is why the checkbox looks inconsistent with the behaviour. Re-save the ' +
        'connection, or correct the stored value to a JSON boolean.',
    joiner:
        'There is no control for this field on the connection form, so re-saving will not rewrite ' +
        'it — the value did not come from the form, and the form would reject the key. Correct the ' +
        'stored value to a JSON boolean, or remove it.',
};

/**
 * The trailing half of the refusal, when the STORED VALUE is the reason
 * rather than the absence of one.
 *
 * Empty for a plainly absent opt-in, where the base message already says
 * everything. The extra sentence is earned only by a value an operator
 * would reasonably read as an opt-in, because that is the case where
 * repeating "turn it on" describes something they have already done. The
 * wording is the one `describeWritesEnabled` reached after a real support
 * round trip; the parts that are TRUE OF BOTH directions are parameterised by
 * field, and the part that is not comes from `DIRECTION_STORED_VALUE_REMEDY`.
 */
export function describeStoredWriteFlag(direction: IdentityDirection, value: unknown): string {
    if (value === undefined || value === null || value === false) return '';
    const field = ENTRA_WRITE_FLAG_FIELD[direction];
    const shown = typeof value === 'string' ? JSON.stringify(value) : String(value);
    const looksAffirmative =
        (typeof value === 'string' && ['true', 'yes', 'on', '1'].includes(value.trim().toLowerCase())) ||
        value === 1;
    if (!looksAffirmative) {
        return (
            ` (This connection stores ${field} as ${typeof value} ${shown}, which is not an opt-in: ` +
            'the flag is compared strictly against the boolean true.)'
        );
    }
    return (
        ` (This connection stores ${field} as the ${typeof value} ${shown} rather than the boolean ` +
        'true, so it is read as OFF here — writes are compared strictly, on purpose, because a value ' +
        'that merely looks affirmative is not a deliberate grant of standing power to write to a ' +
        `directory. ${DIRECTION_STORED_VALUE_REMEDY[direction]})`
    );
}

/** Per-direction operator copy. What was asked for, and which switch grants it. */
const DIRECTION_COPY: Readonly<
    Record<IdentityDirection, { readonly act: string; readonly instruction: string }>
> = {
    leaver: {
        act: 'DISABLE an account',
        instruction:
            'Turn on "Allow offboarding writes" on the connection, and make sure an administrator ' +
            `has consented the application permission ${LEAST_PRIVILEGE_WRITE_ROLE}.`,
    },
    joiner: {
        act: 'CREATE an account',
        instruction:
            `There is no switch for this direction on the connection yet: ${ENTRA_JOINER_WRITES_FIELD} ` +
            'is deliberately undeclared until the create verb exists (#2674, blocked on #2608), because ' +
            'a box ticked for a capability that does not exist would already be ticked on the day it ' +
            'gains one. Until then this direction refuses for every connection.',
    },
};

/**
 * The refusal for one direction, or null when this connection consented to it.
 *
 * Pure and exported so the sentence can be asserted directly and so a caller
 * can explain the refusal BEFORE acting rather than after — the shape
 * `describeRefusal` and `gateWriteBackPreflight` already use.
 *
 * The message NAMES THE DIRECTION, which is the whole point: a single-flag
 * refusal told an operator that "directory writes" were off, and once there
 * are two of them that sentence does not say which switch to look at. It
 * also says that the other direction is a SEPARATE grant — otherwise the
 * natural reading of a leaver-shaped success is that writes, plural and
 * undifferentiated, are on.
 *
 * `WRITES_NOT_ENABLED_PHRASE` is present in every arm, because the factory
 * classifies on it to tell a deliberate opt-out from a broken config.
 */
export function directionWriteRefusal(
    config: EntraWriteFlags,
    direction: IdentityDirection,
): string | null {
    if (readDirectionWritesEnabled(config, direction)) return null;
    const copy = DIRECTION_COPY[direction];
    const other: IdentityDirection = direction === 'leaver' ? 'joiner' : 'leaver';
    return (
        `Entra writer refused: this connection is ${WRITES_NOT_ENABLED_PHRASE} in the ${direction} ` +
        `direction (${copy.act}). ${copy.instruction} The ${other} direction is a separate opt-in ` +
        `(${ENTRA_WRITE_FLAG_FIELD[other]}) and neither grants the other — a grant to disable is not ` +
        'a grant to create.' +
        describeStoredWriteFlag(direction, storedWriteFlag(config, direction))
    );
}
