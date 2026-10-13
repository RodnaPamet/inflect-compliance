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
import * as fs from 'node:fs';
import * as path from 'node:path';
import '@/app-layer/integrations/bootstrap';
import { registry } from '@/app-layer/integrations/registry';
import { codeOf } from '../helpers/source-blocks';

/** Repo root, for the source sweeps below. */
const ROOT = path.resolve(__dirname, '../..');

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
 * #3458 — every Microsoft Graph request goes through `graphHeaders`.
 *
 * Node's `fetch` (undici) sends `Accept-Language: *` by default, and several
 * Graph backends parse that header as a .NET `CultureInfo`. `*` is not a
 * culture identifier, so those endpoints answer:
 *
 *     400 UnknownError  ->  CultureNotFoundException
 *                           "* is an invalid culture identifier."
 *
 * Measured live 2026-10-13: ten of ten PIM requests went 400 -> 200 on the
 * header alone, with a correctly-scoped token, on v1.0 and beta, bare and
 * filtered. Not every backend parses it — users, groups, access packages,
 * roleDefinitions and roleAssignments answer 200 either way — which is
 * exactly what makes it a tripwire rather than an outage: it waits for the
 * first call to an affected endpoint and presents as `UnknownError` on a
 * request that is correct in every visible respect.
 *
 * This is a HEADER guard rather than a style rule. The failure is invisible
 * to tsc, invisible to a code review that does not know the story, and
 * invisible to every existing test, because the endpoints we call today are
 * the ones that tolerate it.
 */
describe('#3458 — Graph requests carry a real Accept-Language', () => {
    const SRC = path.join(ROOT, 'src');

    /** Every .ts under src/, so a new caller cannot be added outside the sweep. */
    const srcFiles = (): string[] => {
        const out: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) walk(full);
                else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(full);
            }
        };
        walk(SRC);
        return out;
    };

    const HELPER = 'src/lib/http/graph-headers.ts';

    it('the helper exists and sends a real culture, not a wildcard', () => {
        // MASKED AT THE READ SEAM — Class A. The helper's own docblock quotes
        // the wildcard (`* is an invalid culture identifier`) and the header
        // name repeatedly; an unmasked read would let that prose answer the
        // questions below about the CODE.
        const src = codeOf(fs.readFileSync(path.join(ROOT, HELPER), 'utf8'));
        const m = src.match(/GRAPH_ACCEPT_LANGUAGE = '([^']+)'/);
        expect(m).not.toBeNull();
        const value = (m as RegExpMatchArray)[1];
        // The defect is that `*` is not a culture identifier. A wildcard or an
        // empty value here reintroduces it verbatim.
        expect(value).not.toBe('*');
        expect(value).not.toBe('');
        expect(value).toMatch(/^[a-z]{2}(-[A-Z]{2})?$/);
        expect(src).toMatch(/'Accept-Language': GRAPH_ACCEPT_LANGUAGE/);
    });

    it('no file builds a Graph Authorization header inline', () => {
        const offenders: string[] = [];
        for (const f of srcFiles()) {
            if (f.endsWith('graph-headers.ts')) continue;
            const code = codeOf(fs.readFileSync(f, 'utf8'));
            if (!/graph\.microsoft\.com\/(v1\.0|beta)/.test(code)) continue;
            // A Graph caller that writes its own bearer header is a caller that
            // can omit the language header.
            if (/Authorization:\s*`Bearer /.test(code)) offenders.push(path.relative(ROOT, f));
        }
        expect(offenders).toEqual([]);
    });

    it('every Graph-calling file imports the helper', () => {
        const missing: string[] = [];
        let callers = 0;
        for (const f of srcFiles()) {
            if (f.endsWith('graph-headers.ts')) continue;
            const code = codeOf(fs.readFileSync(f, 'utf8'));
            // An API BASE, not merely the host. The host also appears as OAuth
            // SCOPE strings — `https://graph.microsoft.com/Sites.Read.All` in
            // sharepoint/token.ts, which fetches login.microsoftonline.com and
            // never Graph — plus a placeholder in config-schema.ts and an
            // allowlist in http-resilience.ts. The first version of this guard
            // matched the bare host and reported token.ts as an offender.
            // The base match alone is the predicate. An earlier version also
            // required a `fetch(`-shaped call, which dropped
            // sharepoint/client.ts — it issues Graph requests through
            // `BaseIntegrationClient.request`, so the sweep silently excluded
            // the integration with the most write surface in the product. The
            // two files that merely NAME the host (a comment in
            // config-schema.ts, an allowlist entry in http-resilience.ts) carry
            // no `/v1.0` or `/beta`, so the base check already excludes them.
            if (!/graph\.microsoft\.com\/(v1\.0|beta)/.test(code)) continue;
            callers++;
            if (!code.includes('graph-headers')) missing.push(path.relative(ROOT, f));
        }
        // Positive control: an empty sweep would pass the assertion below
        // vacuously, and this guard is only worth anything over a real set.
        expect(callers).toBeGreaterThanOrEqual(7);
        expect(missing).toEqual([]);
        // eslint-disable-next-line no-console
        console.log(`#3458 — ${callers} Graph-calling files, all via graphHeaders`);
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

/**
 * #3432 — the census above enumerates ONE of two registries.
 *
 * `IntegrationProvider` classes (`readonly id`) are one population.
 * `integrationRegistry` client+mapper BUNDLES are another. `github` and
 * `servicenow` are in both; **`sharepoint` is in the bundles only** — so
 * #3431's census could not see the integration with the most write surface in
 * the product (six Graph writes against one or two for every other writer),
 * and the census read as coverage while that one sat outside it by
 * construction.
 *
 * #3432 proposed deciding first whether SharePoint "should be a provider",
 * on the grounds that the alternative was a guard enumerating "a registry plus
 * a hand-maintained list". That premise was wrong, and checking it is what
 * made this fixable now: `integrationRegistry` is a real registry, enumerable
 * at runtime exactly like the other. (The issue also reported
 * `grep -c sharepoint bootstrap.ts -> 0`; it is 3 — the bundle is registered
 * at `bootstrap.ts:124`.) So the census covers the UNION, and whether
 * SharePoint should additionally become a provider stays a product question
 * this no longer blocks on.
 *
 * The field is OPTIONAL on a bundle on purpose: a bundle whose name is also a
 * provider answers through the provider, and requiring both would be two
 * copies of one predicate. Required here only for bundles with no provider of
 * the same name.
 */
describe('#3432 — the mapping census covers BOTH registries', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { integrationRegistry: bundleRegistry } = require('@/app-layer/integrations/registry');
    const bundles = (): Array<{ name: string; mappingVerifiedBy?: string | null }> =>
        bundleRegistry.listBundles();
    const providerIds = () => new Set(registry.listProviders().map((p) => p.id));

    it('both registries are populated, so an empty scan cannot pass either', () => {
        expect(bundles().length).toBeGreaterThanOrEqual(3);
        expect(providerIds().size).toBeGreaterThanOrEqual(15);
    });

    it('sharepoint is in the bundle registry and NOT in the provider registry', () => {
        // The specific fact #3432 is about. If SharePoint later registers as a
        // provider this reddens, which is the moment to simplify this block.
        const names = bundles().map((b) => b.name);
        expect(names).toContain('sharepoint');
        expect([...providerIds()]).not.toContain('sharepoint');
    });

    it('every bundle with no provider of the same name declares mappingVerifiedBy', () => {
        const ids = providerIds();
        const orphans = bundles().filter((b) => !ids.has(b.name));
        // Positive control: if the orphan set were empty this would pass
        // vacuously, and the whole point is that it is not empty today.
        expect(orphans.map((b) => b.name)).toEqual(['sharepoint']);
        const undeclared = orphans
            .filter((b) => b.mappingVerifiedBy === undefined)
            .map((b) => b.name);
        expect(undeclared).toEqual([]);
    });

    it('publishes the UNION, so the denominator is the whole write surface', () => {
        const ids = providerIds();
        const orphans = bundles().filter((b) => !ids.has(b.name));
        const unionSize = ids.size + orphans.length;
        const unrecorded = [
            ...registry
                .listProviders()
                .filter((p) => (p as { mappingVerifiedBy?: string | null }).mappingVerifiedBy === null)
                .map((p) => p.id),
            ...orphans.filter((b) => b.mappingVerifiedBy === null).map((b) => b.name),
        ];
        // eslint-disable-next-line no-console
        console.log(
            `#3432 — union census: ${unrecorded.length}/${unionSize} integrations have no `
                + `recorded live mapping run (${ids.size} providers + ${orphans.length} bundle-only): `
                + `${unrecorded.join(', ') || 'none'}`,
        );
        expect(unionSize).toBeGreaterThan(registry.listProviders().length);
    });
});
