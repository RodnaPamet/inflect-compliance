/**
 * No provider may declare a credential in `configFields`.
 *
 * ## Nothing is broken today — that is the point
 *
 * Every configurable provider currently puts its credential in `secretFields`,
 * and the storage path for those is sound: `usecases/integrations.ts` does
 * `secretEncrypted = encryptField(JSON.stringify(input.secrets))`, decrypts on
 * read, and the admin UI keeps a separate masked section for them.
 *
 * The exposure is structural and it belongs to the NEXT provider. `configJson`
 * is plain, unencrypted JSON, and the admin form's `FieldType` union is
 * `'string' | 'number' | 'boolean' | 'select' | 'textarea'` — there is no
 * secret or password variant. So a credential declared in `configFields` would
 * be stored in the clear AND rendered as a visible text input, and nothing
 * anywhere would fail. No type error, no test, no review signal beyond someone
 * noticing the word "token" in the wrong array.
 *
 * A guard is the right shape for that: the mistake is cheap to make, invisible
 * once made, and expensive to discover.
 *
 * ## Why the allowlist is by exact key, not by pattern
 *
 * Some legitimately-public fields match a credential-shaped word — a key ID, a
 * client ID, a tenant ID. Those are identifiers, not secrets. Allowing them by
 * exact `provider.field` rather than by loosening the pattern keeps the
 * decision per-field and written down, instead of widening the hole for
 * everything that happens to share a substring.
 */
import '@/app-layer/integrations/bootstrap';
import { registry } from '@/app-layer/integrations/registry';

/**
 * Words that mean "this value authenticates you". Deliberately broad — a false
 * positive costs one allowlist line with a reason; a false negative ships a
 * credential in plaintext.
 */
const CREDENTIAL_WORD = /token|secret|password|key|credential|serviceaccount|passphrase|privatekey/i;

/**
 * `provider.field` pairs that match the pattern but are NOT secrets. Each needs
 * a reason, and the reason has to say why the value is safe in the clear.
 */
const PUBLIC_FIELD_ALLOWLIST: Record<string, string> = {
    // (empty today — every credential-shaped config field is a real secret and
    // lives in secretFields. An entry here is a claim that a value is public.)
};

describe('integration credential placement', () => {
    const providers = registry.listProviders();

    it('sanity — the registry is populated', () => {
        // A guard over an empty list passes vacuously, which is the failure
        // mode this whole file exists to prevent.
        expect(providers.length).toBeGreaterThan(5);
    });

    it('no credential-shaped key appears in configFields', () => {
        const offenders: string[] = [];

        for (const p of providers) {
            const configFields = p.configSchema?.configFields ?? [];
            for (const f of configFields) {
                const pair = `${p.id}.${f.key}`;
                if (!CREDENTIAL_WORD.test(f.key)) continue;
                if (PUBLIC_FIELD_ALLOWLIST[pair]) continue;
                offenders.push(
                    `${pair} — credential-shaped key in configFields (stored UNENCRYPTED in configJson, rendered as a visible input)`,
                );
            }
        }

        expect({ offenders }).toEqual({ offenders: [] });
    });

    it('every configurable provider that needs a credential declares one in secretFields', () => {
        // The inverse check. A provider with config but no secrets is either
        // credential-free (fine — the internal check providers) or has put its
        // credential somewhere else (not fine). This catches the case where a
        // secret field is DELETED rather than misplaced.
        const suspicious: string[] = [];

        for (const p of providers) {
            const secretKeys = (p.configSchema?.secretFields ?? []).map((f) => f.key);
            const configKeys = (p.configSchema?.configFields ?? []).map((f) => f.key);
            // A provider claiming a live credential probe must have a
            // credential to probe with.
            if (p.liveValidation && secretKeys.length === 0 && configKeys.length > 0) {
                suspicious.push(`${p.id} — liveValidation:true but no secretFields`);
            }
        }

        expect({ suspicious }).toEqual({ suspicious: [] });
    });

    it('every allowlist entry still exists and carries a reason', () => {
        for (const [pair, reason] of Object.entries(PUBLIC_FIELD_ALLOWLIST)) {
            const [providerId, fieldKey] = pair.split('.');
            const p = providers.find((x) => x.id === providerId);
            expect(p).toBeDefined();
            expect((p?.configSchema?.configFields ?? []).some((f) => f.key === fieldKey)).toBe(true);
            expect(reason.length).toBeGreaterThan(20);
        }
    });
});

/**
 * #3431 — every registered provider answers whether its response MAPPING has met
 * a live instance.
 *
 * SHARES THIS FILE DELIBERATELY. `tests/guards/epic-named-ratchets...` ratchets
 * the guard-file COUNT downward — the repo is retiring guard files, and adding
 * one to carry four assertions would push that count up. This file already
 * enumerates `registry.listProviders()`, which is the population the census
 * needs, so the assertions live beside it rather than in a file of their own.
 *
 * `tsc` already forces the DECLARATION — the field is required on
 * `IntegrationProvider`. What it cannot say is whether the answer is meaningful.
 */
describe('provider mapping verification is declared and meaningful', () => {
    const providers = registry.listProviders();
    /** Providers with no external contract at all — they must SAY so, not be null. */
    const INTERNAL = ['personnel', 'device', 'training'];

    it('the registry is non-trivial, so an empty scan cannot pass', () => {
        expect(providers.length).toBeGreaterThanOrEqual(10);
    });

    it('every provider answers, as a string or an explicit null', () => {
        // The one that caught `aws-posture`, which the sweep's grep missed
        // because it lives one directory ABOVE `providers/`. The registry is the
        // population, not the folder.
        for (const p of providers) {
            const v = (p as { mappingVerifiedBy?: unknown }).mappingVerifiedBy;
            expect(v === null || typeof v === 'string').toBe(true);
        }
    });

    it('a stated verification cites something chaseable, not a bare claim', () => {
        for (const p of providers) {
            const v = (p as { mappingVerifiedBy?: string | null }).mappingVerifiedBy;
            if (typeof v !== 'string' || INTERNAL.includes(p.id)) continue;
            expect(v).toMatch(/#\d+|\b20\d{2}-\d{2}-\d{2}\b/);
        }
    });

    it('the internal providers say they have no external contract', () => {
        // Not `null`: "nothing to verify" and "nothing recorded" are different
        // answers, and `null` is the second.
        for (const id of INTERNAL) {
            const p = providers.find((x) => x.id === id);
            if (!p) continue;
            const v = (p as { mappingVerifiedBy?: string | null }).mappingVerifiedBy;
            expect(v).toMatch(/no external contract/i);
        }
    });

    it('reports how many providers have no recorded live mapping run', () => {
        const unrecorded = providers
            .filter((p) => (p as { mappingVerifiedBy?: string | null }).mappingVerifiedBy === null)
            .map((p) => p.id);
        // REPORTED, not ratcheted. Driving this down needs a vendor tenant most
        // of these do not have, and a gate that cannot go green gets disabled.
        // eslint-disable-next-line no-console
        console.log(
            `#3431 — ${unrecorded.length}/${providers.length} providers have no recorded `
                + `live mapping run: ${unrecorded.join(', ') || 'none'}`,
        );
        expect(Array.isArray(unrecorded)).toBe(true);
    });
});
