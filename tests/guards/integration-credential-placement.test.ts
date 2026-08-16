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
