/**
 * The Active Directory per-connection write opt-in — #2841.
 *
 * WHY THIS FILE EXISTS SEPARATELY from `active-directory-writer.test.ts`:
 * that file's fixtures all CONSENT, because every test in it is about what a
 * consented write does. A gate is only worth anything if something fails when
 * it is removed, and the tests that prove that have to be the ones NOT holding
 * the opt-in. The issue this closes made the point precisely: the Entra gate is
 * trustworthy because mutating `readDirectionWritesEnabled` to return true
 * reddens nine tests, and AD had no equivalent rail to mutate.
 *
 * MUTATION PROOF — MEASURED, not asserted. Each mutation below was applied,
 * the three AD suites re-run, and the file restored byte-for-byte. The
 * population is those three files: this one, `active-directory-writer` and
 * `active-directory-provisioner`.
 *
 *   BASELINE                                                   0 red / 155 total
 *   `readAdDirectionWritesEnabled` → `return true`            15 red
 *   `adDirectionWriteRefusal` → `return null`                 14 red
 *   strict `=== true` → `Boolean(...)` (truthiness)            6 red
 *   `storedWriteFlag` joiner arm → `config.writesEnabled`     25 red
 *   the writer's `if (writesRefusal) throw` deleted            9 red
 *   the provisioner's `if (writesRefusal) throw` deleted       2 red
 *   the writer asks for `'joiner'` instead of `'leaver'`     107 red
 *
 * THE TOTAL STAYED 155 IN EVERY RUN, and that number is here on purpose: a
 * mutation that made a suite fail to LOAD would contribute zero tests and
 * report as a pass. A red count alone cannot tell those apart.
 *
 * The thin one is the provisioner's throw at 2. That is proportionate rather
 * than an oversight — the joiner arm is unreachable in production twice over
 * (undeclared field, `JOINER_MAX_MODE`), so it is a backstop for the day the
 * clamp lifts, and there is not much legitimate behaviour to assert around it
 * yet. Named here so a later reader does not mistake 2 for thoroughness.
 */
import { createActiveDirectoryWriter } from '@/app-layer/integrations/providers/active-directory/writer';
import { createActiveDirectoryProvisioner } from '@/app-layer/integrations/providers/active-directory/provisioner';
import {
    AD_JOINER_WRITES_FIELD,
    AD_LEAVER_WRITES_FIELD,
    AD_WRITE_FLAG_FIELD,
    adDirectionWriteRefusal,
    describeStoredAdWriteFlag,
    readAdDirectionWritesEnabled,
} from '@/app-layer/integrations/providers/active-directory/write-direction';
import {
    WRITES_NOT_ENABLED_PHRASE,
    isWritesNotEnabledRefusal,
} from '@/app-layer/integrations/providers/write-refusal';
import { ActiveDirectoryProvider } from '@/app-layer/integrations/providers/active-directory';
import { CONFIG_FIELD_RULES } from '@/app-layer/integrations/config-schema';

/** Enough of a connection to get PAST everything except the gate. */
const BASE = {
    url: 'ldaps://dc.corp.example.com:636',
    baseDN: 'DC=corp,DC=example,DC=com',
    bindDN: 'CN=svc-inflect,OU=Service,DC=corp,DC=example,DC=com',
    bindPassword: 'read-only-pw',
};

/** A provider that would build a client, if anything ever asked it to. */
const fakeProvider = {
    makeClient: async () => {
        throw new Error('no test here should reach the network');
    },
} as never;

const makeWriter = (over: Record<string, unknown> = {}) =>
    createActiveDirectoryWriter({ connection: { ...BASE, ...over }, provider: fakeProvider });

const makeProvisioner = (over: Record<string, unknown> = {}) =>
    createActiveDirectoryProvisioner({ connection: { ...BASE, ...over }, provider: fakeProvider });

describe('AD leaver writes — the gate the issue says was missing', () => {
    it('REFUSES to construct a writer for a connection that never opted in', () => {
        // The whole finding in one assertion. Before #2841 this call returned a
        // live writer, and the only thing standing between a read-only AD
        // connection and a disable was the tenant-level identityLeaverMode.
        expect(() => makeWriter()).toThrow(/not enabled for directory writes/i);
    });

    it('constructs once the connection opts in', () => {
        // The positive control. Without it, a gate that refused EVERYTHING —
        // a typo'd field name, say — would pass every other test in this file.
        expect(() => makeWriter({ writesEnabled: true })).not.toThrow();
    });

    it('names the direction, the act, and the delegated right — not "writes are off"', () => {
        const detail = (() => {
            try {
                makeWriter();
                return '';
            } catch (err) {
                return err instanceof Error ? err.message : String(err);
            }
        })();
        expect(detail).toContain('leaver');
        expect(detail).toContain('DISABLE an account');
        // The narrow right, spelled out. `writer.ts`'s own describeAccessDenied
        // learned this the expensive way: a refusal that does not name the
        // exact delegation invites escalation to Domain Admin.
        expect(detail).toContain('userAccountControl');
        expect(detail).not.toMatch(/domain admin/i);
    });

    it('is classified as a deliberate opt-out, not a broken config', () => {
        // The cross-module pin. `identity-writer-factory` and
        // `identity-provisioner-factory` both classify on this phrase; if the AD
        // refusal drifts out of it, a deliberate operator state starts reaching
        // operators as an unexplained WRITER_REFUSED.
        const detail = adDirectionWriteRefusal({}, 'leaver') ?? '';
        expect(detail).toContain(WRITES_NOT_ENABLED_PHRASE);
        expect(isWritesNotEnabledRefusal(detail)).toBe(true);
    });
});

describe('the opt-in is compared STRICTLY, because a form emits strings', () => {
    // Each of these ticks, saves and reloads looking ON if the comparison is
    // loosened. `coerceDeclaredBooleans` handles what the form emits; these are
    // the values that did not come from the form.
    it.each([['true'], ['yes'], ['on'], ['1'], [1], ['TRUE']])(
        'reads %p as NOT consented',
        (value) => {
            expect(readAdDirectionWritesEnabled({ writesEnabled: value }, 'leaver')).toBe(false);
            expect(() => makeWriter({ writesEnabled: value })).toThrow(
                /not enabled for directory writes/i,
            );
        },
    );

    it('explains an affirmative-LOOKING stored value instead of repeating the instruction', () => {
        const said = describeStoredAdWriteFlag('leaver', 'true');
        expect(said).toContain('rather than the boolean');
        expect(said).toContain('Re-save the connection');
        // A plainly absent opt-in earns no extra sentence — the base message
        // already says everything, and padding it trains operators to skim.
        expect(describeStoredAdWriteFlag('leaver', undefined)).toBe('');
        expect(describeStoredAdWriteFlag('leaver', false)).toBe('');
    });

    it('tells a non-affirmative stored value apart from an affirmative-looking one', () => {
        expect(describeStoredAdWriteFlag('leaver', 42)).toContain('which is not an opt-in');
    });
});

describe('the two directions are separate grants — neither implies the other', () => {
    it('a JOINER grant does not let the leaver writer construct', () => {
        expect(() => makeWriter({ joinerWritesEnabled: true })).toThrow(
            /not enabled for directory writes/i,
        );
    });

    it('a LEAVER grant does not let the provisioner construct', () => {
        // The asymmetry that matters most: every connection an operator ticks
        // for offboarding must NOT thereby gain the power to create accounts.
        expect(() => makeProvisioner({ writesEnabled: true })).toThrow(
            /not enabled for directory writes/i,
        );
    });

    it('each direction reads its OWN field and ignores the other', () => {
        expect(readAdDirectionWritesEnabled({ writesEnabled: true }, 'leaver')).toBe(true);
        expect(readAdDirectionWritesEnabled({ writesEnabled: true }, 'joiner')).toBe(false);
        expect(readAdDirectionWritesEnabled({ joinerWritesEnabled: true }, 'joiner')).toBe(true);
        expect(readAdDirectionWritesEnabled({ joinerWritesEnabled: true }, 'leaver')).toBe(false);
    });

    it('the refusal points at the OTHER direction by field name', () => {
        expect(adDirectionWriteRefusal({}, 'leaver')).toContain(AD_JOINER_WRITES_FIELD);
        expect(adDirectionWriteRefusal({}, 'joiner')).toContain(AD_LEAVER_WRITES_FIELD);
        expect(AD_WRITE_FLAG_FIELD.leaver).not.toBe(AD_WRITE_FLAG_FIELD.joiner);
    });
});

describe('the joiner field stays OFF the connection form, and that is pinned', () => {
    const schema = new ActiveDirectoryProvider().configSchema;
    const keys = [
        ...schema.configFields.map((f) => f.key),
        ...(schema.secretFields ?? []).map((f) => f.key),
    ];

    it('declares the LEAVER opt-in as a boolean the operator can see', () => {
        const field = schema.configFields.find((f) => f.key === AD_LEAVER_WRITES_FIELD);
        expect(field).toBeDefined();
        expect(field?.type).toBe('boolean');
        // Off by default. A required field would make an operator answer it to
        // save a read-only connection at all.
        expect(field?.required).toBeFalsy();
    });

    it('does NOT declare the joiner opt-in — JOINER_MAX_MODE is still DRY_RUN', () => {
        // Pinned so that declaring it is a reviewed diff rather than a
        // copy-paste. A box ticked for a capability that authorises nothing
        // today would already be ticked on the day the clamp lifts.
        expect(keys).not.toContain(AD_JOINER_WRITES_FIELD);
    });

    it('the leaver field agrees across all three places that must agree', () => {
        // The provider form, the validator, and the reader. An undeclared key is
        // rejected outright by validateProviderConfig, so a disagreement here
        // means an operator ticks a box whose value can never be saved.
        expect(keys).toContain(AD_LEAVER_WRITES_FIELD);
        expect(Object.keys(CONFIG_FIELD_RULES['active-directory'])).toContain(
            AD_LEAVER_WRITES_FIELD,
        );
        expect(readAdDirectionWritesEnabled({ writesEnabled: true }, 'leaver')).toBe(true);
    });

    it('the validator does NOT accept the joiner key, so it cannot be stored from the form', () => {
        expect(Object.keys(CONFIG_FIELD_RULES['active-directory'])).not.toContain(
            AD_JOINER_WRITES_FIELD,
        );
    });
});

describe('the provisioner refuses for every connection today', () => {
    it('refuses even a fully configured one, because the joiner field is undeclared', () => {
        expect(() => makeProvisioner()).toThrow(/not enabled for directory writes/i);
    });

    it('says WHY there is no switch rather than telling the operator to find one', () => {
        const detail = adDirectionWriteRefusal({}, 'joiner') ?? '';
        expect(detail).toContain('CREATE an account');
        expect(detail).toContain('DRY_RUN');
        expect(detail).not.toContain('Turn on "Allow offboarding writes"');
    });

    it('constructs if the key is set directly — the gate is the field, not a hardcoded no', () => {
        // The positive control for this arm. Without it, `return false` in the
        // reader would satisfy every other test in this describe block, and the
        // day the clamp lifts the joiner would be dead rather than gated.
        expect(() => makeProvisioner({ joinerWritesEnabled: true })).not.toThrow();
    });
});
