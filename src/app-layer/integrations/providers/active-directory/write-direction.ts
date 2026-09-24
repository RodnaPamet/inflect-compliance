/**
 * Which DIRECTION an Active Directory connection consented to write in — #2841.
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHAT WAS MISSING, AND WHY IT IS A SECURITY STATEMENT
 * ═══════════════════════════════════════════════════════════════════
 *
 * Entra has had a per-connection write opt-in since #2674. Active Directory
 * had none, while the leaver pass's own rail list read as though both arms
 * were gated the same way. For AD the ONLY consent statement was the
 * tenant-level `identityLeaverMode`, and that is a statement about the
 * TENANT'S AUTOMATION POSTURE, not about this directory. An operator who
 * connected AD to sync a read-only roster had, the moment anyone moved that
 * tenant to `AUTOMATIC`, also granted standing authority to disable accounts
 * in their forest — without ever being asked a question about this
 * connection. A tenant with two directories connected answers that question
 * once and enrols both.
 *
 * This is not hypothetical. The AD leaver path performed a real unattended
 * disable on 2026-09-24 (#2749).
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHY AD NEEDS THE FLAG EVEN THOUGH ITS CREDENTIAL LAYER *CAN* SEPARATE
 * ═══════════════════════════════════════════════════════════════════
 *
 * Entra's argument for the flag is that its credential cannot make the
 * separation at all: `User.ReadWrite.All` and `Directory.ReadWrite.All` are
 * both on this repo's own consent list and both cover create AND disable, so
 * any grant sufficient to create is sufficient to disable.
 *
 * AD is genuinely different here, and saying so is the honest version. An OU
 * ACE is per-right: `dsacls` can grant WRITE PROPERTY on
 * `userAccountControl` without granting CREATE CHILD for user objects, so an
 * administrator CAN express the separation in the directory itself.
 *
 * The flag is still the only place the product can state it, for two reasons:
 *
 *   1. THE PRODUCT DOES NOT REQUIRE A SEPARATE WRITE BIND. `writeBindDN` is
 *      optional and falls back to the READ bind (`writer.ts`), so the common
 *      deployment — one service account, provisioned for reading — performs
 *      writes as an account chosen for reading, whose ACEs nobody picked with
 *      writes in mind. Whatever separation the directory could express, this
 *      connection did not ask anyone to express it.
 *
 *   2. AN ACE IS NOT A RECORD OF CONSENT. A delegation that happens to permit
 *      a disable is evidence about what AD will allow, not about what the
 *      customer agreed this product may do. Inferring the second from the
 *      first is the accidental-consent failure the sibling flags
 *      (`entra-id/write-direction`, `hris/write-back`) each exist to avoid.
 *
 * So the direction of the argument differs from Entra's and the conclusion
 * does not: the per-connection flag is where consent is stated.
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHY THE JOINER FIELD IS NOT ON THE CONNECTION FORM
 * ═══════════════════════════════════════════════════════════════════
 *
 * `AD_JOINER_WRITES_FIELD` is spelled here and read here, and is DELIBERATELY
 * absent from `ActiveDirectoryProvider.configSchema.configFields` — the same
 * shape Entra's joiner field has, reached by a slightly different route.
 *
 * Entra's joiner has no create verb at all. AD's does: `provisioner.ts` is
 * real, and `LIVE_PROVISIONER_PROVIDERS` is `['active-directory']` alone. What
 * holds it is `JOINER_MAX_MODE = 'DRY_RUN'`, a SOURCE constant — so an AD
 * create cannot execute today, and the day it can is a reviewed diff.
 *
 * That is exactly why the box stays off the form. If it were declared now,
 * operators could tick it now, against a capability that authorises nothing
 * now — and the diff that lifts the clamp would land on connections whose
 * boxes are ALREADY TICKED. A grant collected before the capability exists is
 * not a grant to that capability.
 *
 * Gating the provisioner on an undeclared field therefore refuses the joiner
 * direction for every connection. That is FAIL-CLOSED BACKSTOP, not a
 * behaviour change: `resolveDirectoryProvisioner` builds a live provisioner
 * only at `AUTOMATIC`, and an AUTOMATIC joiner pass is refused at the
 * `JOINER_MAX_MODE` clamp before the factory is reached. The arm is
 * unreachable today in both directions, and it is gated now so that lifting
 * the clamp does not also, silently, grant create authority.
 *
 * @module integrations/providers/active-directory/write-direction
 */
import type { IdentityDirection } from '@/lib/identity/write-ladder';
import { WRITES_NOT_ENABLED_PHRASE } from '../write-refusal';

/**
 * The leaver's opt-in.
 *
 * Spelled the same as Entra's deliberately. `CONFIG_FIELD_RULES` and
 * `configJson` are both keyed per provider, so there is no collision, and an
 * operator who administers both directories should not have to learn that
 * "allow offboarding writes" is called two different things depending on
 * which connection they are looking at.
 *
 * Unlike Entra's, this field has NO legacy: no AD connection has ever stored
 * it. Every existing connection therefore reads as NOT consented and stops
 * writing until an operator ticks the box — which is the point, and is the
 * one operator action this change requires.
 */
export const AD_LEAVER_WRITES_FIELD = 'writesEnabled';

/**
 * The joiner's opt-in, spelled ONCE. Not on the form — see the module
 * docblock.
 *
 * When it is declared, three places must agree about this string: the
 * provider's `configSchema`, `CONFIG_FIELD_RULES` in `config-schema.ts` (an
 * undeclared key is rejected outright by `validateProviderConfig`), and this
 * reader. Two of the three are code and import it from here.
 */
export const AD_JOINER_WRITES_FIELD = 'joinerWritesEnabled';

/** The field each direction is consented through. Never shared, by construction. */
export const AD_WRITE_FLAG_FIELD: Readonly<Record<IdentityDirection, string>> = {
    leaver: AD_LEAVER_WRITES_FIELD,
    joiner: AD_JOINER_WRITES_FIELD,
};

/**
 * The delegated right named in operator-facing copy.
 *
 * The NARROW one, on purpose. `writer.ts` already learned this lesson the
 * expensive way in `describeAccessDenied`: when a refusal does not name the
 * exact right, the cheapest-looking fix is escalating the service account to
 * Domain Admin.
 */
export const LEAST_PRIVILEGE_WRITE_RIGHT =
    'Write Property on userAccountControl, delegated on the OU holding these accounts';

/** Just the flags, so a caller can hand over a merged connection bag unwidened. */
export interface AdWriteFlags {
    readonly writesEnabled?: unknown;
    readonly joinerWritesEnabled?: unknown;
}

/**
 * The stored value for one direction.
 *
 * A `switch` rather than `config[FIELD[direction]]`, and that is not style: a
 * dynamic key is one typo — or one future direction added to the record
 * without a branch here — away from reading the OTHER direction's flag, which
 * is the single failure this module exists to make impossible. The `never` arm
 * makes a third direction a compile error rather than a silent alias.
 */
function storedWriteFlag(config: AdWriteFlags, direction: IdentityDirection): unknown {
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
 * STRICT `=== true`, for the reason the sibling providers are strict:
 * `configJson` is written from an admin form whose controls all produce
 * strings, so the string `'true'` reaching this comparison would mean a
 * checkbox that ticks, saves and reloads ticked while the capability stays
 * off. `coerceDeclaredBooleans` converts exactly the two spellings the form
 * emits for a key the provider declares boolean, so strictness costs nothing
 * for a value that came from the form — and `describeStoredWriteFlag` exists
 * for the value that did not.
 *
 * Reads ONE field. A `true` in the other direction's field is not consulted
 * and cannot contribute.
 */
export function readAdDirectionWritesEnabled(
    config: AdWriteFlags,
    direction: IdentityDirection,
): boolean {
    return storedWriteFlag(config, direction) === true;
}

/**
 * What an operator should DO about a stored value that merely looks
 * affirmative — and it differs per direction, because only one of the two
 * fields is on the connection form.
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
 * The trailing half of the refusal, when the STORED VALUE is the reason rather
 * than the absence of one.
 *
 * Empty for a plainly absent opt-in, where the base message already says
 * everything. The extra sentence is earned only by a value an operator would
 * reasonably read as an opt-in, because that is the case where repeating "turn
 * it on" describes something they have already done.
 */
export function describeStoredAdWriteFlag(direction: IdentityDirection, value: unknown): string {
    if (value === undefined || value === null || value === false) return '';
    const field = AD_WRITE_FLAG_FIELD[direction];
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
            'Turn on "Allow offboarding writes" on the connection, and make sure the bind account ' +
            `it writes as holds ${LEAST_PRIVILEGE_WRITE_RIGHT}. If no dedicated write bind is ` +
            'configured, that is the READ bind — check which account you are actually granting.',
    },
    joiner: {
        act: 'CREATE an account',
        instruction:
            `There is no switch for this direction on the connection yet: ${AD_JOINER_WRITES_FIELD} ` +
            'is deliberately undeclared while JOINER_MAX_MODE is DRY_RUN, because a box ticked for a ' +
            'capability that authorises nothing today would already be ticked on the day the clamp ' +
            'lifts. Until then this direction refuses for every connection.',
    },
};

/**
 * The refusal for one direction, or null when this connection consented to it.
 *
 * Pure and exported so the sentence can be asserted directly and so a caller
 * can explain the refusal BEFORE acting rather than after.
 *
 * The message NAMES THE DIRECTION and says the other is a SEPARATE grant —
 * otherwise the natural reading of a leaver-shaped success is that writes,
 * plural and undifferentiated, are on.
 *
 * `WRITES_NOT_ENABLED_PHRASE` is present in every arm, because both the writer
 * and provisioner factories classify on it to tell a deliberate opt-out from a
 * broken config.
 */
export function adDirectionWriteRefusal(
    config: AdWriteFlags,
    direction: IdentityDirection,
): string | null {
    if (readAdDirectionWritesEnabled(config, direction)) return null;
    const copy = DIRECTION_COPY[direction];
    const other: IdentityDirection = direction === 'leaver' ? 'joiner' : 'leaver';
    return (
        `Active Directory writer refused: this connection is ${WRITES_NOT_ENABLED_PHRASE} in the ` +
        `${direction} direction (${copy.act}). ${copy.instruction} The ${other} direction is a ` +
        `separate opt-in (${AD_WRITE_FLAG_FIELD[other]}) and neither grants the other — a grant to ` +
        'disable is not a grant to create.' +
        describeStoredAdWriteFlag(direction, storedWriteFlag(config, direction))
    );
}
