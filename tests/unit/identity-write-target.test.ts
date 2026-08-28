/**
 * Where a directory write may land — decided per ACCOUNT, from an observed
 * signal, never from configuration.
 *
 * ═══ THE FAILURE THIS PREVENTS IS A SUCCESSFUL-LOOKING WRITE ═══
 *
 * Disabling a directory-synced account through Graph is ACCEPTED by the API and
 * then reverted by the next Azure AD Connect cycle. The leaver reports done and
 * the account re-enables itself, with an audit trail saying the offboarding
 * succeeded. That is worse than an outright failure, which is why every
 * ambiguous case below refuses.
 */
import {
    resolveWriteTarget,
    OBSERVATION_FRESHNESS_MS,
} from '@/app-layer/usecases/identity-write-target';

describe('a cloud-mastered account may be written in the cloud directory', () => {
    it('allows an Entra account observed as NOT synced from on-prem', () => {
        expect(resolveWriteTarget({ provider: 'entra-id', onPremisesSyncEnabled: false })).toEqual({
            allowed: true,
            basis: 'NOT_ON_PREM_SYNCED',
        });
    });

    it('allows Okta and Google the same way', () => {
        expect(resolveWriteTarget({ provider: 'okta', onPremisesSyncEnabled: false }).allowed).toBe(true);
        expect(
            resolveWriteTarget({ provider: 'google-workspace', onPremisesSyncEnabled: false }).allowed,
        ).toBe(true);
    });
});

describe('a directory-synced account is refused and retargeted', () => {
    it('refuses the cloud write when onPremisesSyncEnabled is true', () => {
        const r = resolveWriteTarget({ provider: 'entra-id', onPremisesSyncEnabled: true });
        expect(r.allowed).toBe(false);
        expect(r.allowed === false && r.reason).toMatch(/mastered on-premises/i);
    });

    it('names WHERE the write should go instead', () => {
        // A refusal that does not say what to do next just becomes a stuck
        // offboarding somebody has to reverse-engineer.
        const r = resolveWriteTarget({ provider: 'entra-id', onPremisesSyncEnabled: true });
        expect(r.allowed === false && r.retargetTo).toBe('active-directory');
    });

    it('the reason states the consequence, not just the rule', () => {
        // The operator reading this needs to know that the alternative is not
        // "it fails" but "it silently un-does itself".
        const r = resolveWriteTarget({ provider: 'entra-id', onPremisesSyncEnabled: true });
        expect(r.allowed === false && r.reason).toMatch(/revert|re-enable/i);
    });
});

describe('an OBSERVED null is cloud-only, and writable', () => {
    // The bug this closes, measured on the first real Entra tenant: 10 of 10
    // accounts came back NULL from a fully-consented sync that reached PASSED,
    // so every candidate was refused REFUSED_TARGET and the leaver path was
    // permanently inert for cloud-only directories.
    //
    // Graph's contract: `true` when the object is synced from an on-premises
    // AD, and "otherwise the user isn't being synced and can be managed in
    // Microsoft Entra ID". A null from a directory that WAS asked is that
    // "otherwise" — an answer, not a gap.
    it('allows an Entra account the directory answered null for', () => {
        expect(
            resolveWriteTarget({
                provider: 'entra-id',
                onPremisesSyncEnabled: null,
                onPremStateObservedAt: new Date(),
            }),
        ).toEqual({ allowed: true, basis: 'CLOUD_ONLY_OBSERVED' });
    });

    it('an observed TRUE is still refused — observation does not override the answer', () => {
        // The flag says "we asked", not "go ahead". A synced account stays
        // refused and retargeted no matter how confidently it was observed.
        const r = resolveWriteTarget({
            provider: 'entra-id',
            onPremisesSyncEnabled: true,
            onPremStateObservedAt: new Date(),
        });
        expect(r.allowed).toBe(false);
        expect(r.allowed === false && r.retargetTo).toBe('active-directory');
    });

    it('an observation from a provider whose null means something ELSE is still refused', () => {
        // The narrowing that keeps this fix from widening past its evidence. A
        // provider author could reasonably set `onPremStateObservedAt` — their API
        // WAS asked — without their null meaning "not synced from on-premises".
        // The flag says we asked; only a verified contract says what the answer
        // means. If this ever starts allowing, the allow has outrun the evidence.
        for (const provider of ['okta', 'google-workspace']) {
            expect(
                resolveWriteTarget({
                    provider,
                    onPremisesSyncEnabled: null,
                    onPremStateObservedAt: new Date(),
                }).allowed,
            ).toBe(false);
        }
    });

    it('providers that CANNOT answer are unaffected — they set no observation', () => {
        // Okta and Google Workspace hardcode null because they genuinely do not
        // know. If this ever starts allowing them, the fix has widened past the
        // case it was written for.
        for (const provider of ['okta', 'google-workspace']) {
            expect(
                resolveWriteTarget({ provider, onPremisesSyncEnabled: null }).allowed,
            ).toBe(false);
        }
    });
});

describe('an observation has to be RECENT, not merely present', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const NOW = new Date('2026-08-28T12:00:00Z');
    const at = (ms: number) => new Date(NOW.getTime() - ms);

    it('a stale answer refuses with its OWN basis, not "never observed"', () => {
        // The two have opposite remedies. "Never observed" clears itself at the
        // next sync; a stale row usually cannot, because the usual cause is a
        // connection that was soft-disabled — its rows freeze while a surviving
        // connection's provider-scoped link reconcile keeps their links fresh.
        const r = resolveWriteTarget({
            provider: 'entra-id',
            onPremisesSyncEnabled: null,
            onPremStateObservedAt: at(30 * DAY),
            now: NOW,
        });
        expect(r.allowed).toBe(false);
        expect(r.basis).toBe('OBSERVATION_STALE');
        expect(r.allowed === false && r.reason).toMatch(/re-enable it, or remove the accounts/i);
    });

    it('gates the observed-FALSE branch too, not only the null one', () => {
        // The branch the first version of this fix skipped. Graph documents
        // `false` as "previously synced, since removed from sync scope" — the
        // value most likely to have flipped back to on-prem-mastered since, so
        // exempting it aimed the age bound away from the case it most needed.
        const stale = resolveWriteTarget({
            provider: 'entra-id',
            onPremisesSyncEnabled: false,
            onPremStateObservedAt: at(30 * DAY),
            now: NOW,
        });
        expect(stale.allowed).toBe(false);
        expect(stale.basis).toBe('OBSERVATION_STALE');

        // Control: the same value, observed recently, still writes.
        const fresh = resolveWriteTarget({
            provider: 'entra-id',
            onPremisesSyncEnabled: false,
            onPremStateObservedAt: at(1 * DAY),
            now: NOW,
        });
        expect(fresh.allowed).toBe(true);
        expect(fresh.basis).toBe('NOT_ON_PREM_SYNCED');
    });

    it('tolerates clock skew but refuses a stamp that cannot BE skew', () => {
        // Unbounded future would let a forward-skewed worker freeze a row as
        // permanently fresh — defeating the bound in the one failure mode it
        // exists to catch.
        const skew = resolveWriteTarget({
            provider: 'entra-id',
            onPremisesSyncEnabled: null,
            onPremStateObservedAt: new Date(NOW.getTime() + 5 * 60 * 1000),
            now: NOW,
        });
        expect(skew.allowed).toBe(true);

        const impossible = resolveWriteTarget({
            provider: 'entra-id',
            onPremisesSyncEnabled: null,
            onPremStateObservedAt: new Date(NOW.getTime() + 30 * DAY),
            now: NOW,
        });
        expect(impossible.allowed).toBe(false);
        expect(impossible.basis).toBe('OBSERVATION_STALE');
    });

    it('unparseable and absent both fail CLOSED', () => {
        for (const bad of ['not-a-date', null, undefined]) {
            const r = resolveWriteTarget({
                provider: 'entra-id',
                onPremisesSyncEnabled: null,
                onPremStateObservedAt: bad as never,
                now: NOW,
            });
            expect(r.allowed).toBe(false);
        }
    });

    it('an Invalid DATE OBJECT refuses without throwing', () => {
        // NOT the same path as the string 'not-a-date' above, and that is the
        // whole point. `describeObservedAt` branches on `instanceof Date`: a
        // string goes through `Date.parse`, a Date through `getTime()`. Only
        // this case reaches the second branch holding NaN, and only this case
        // reaches the refusal FORMATTER with a value it cannot render.
        //
        // Simplify that formatter to `if (value instanceof Date) return
        // value.toISOString()` and the rail throws RangeError instead of
        // returning a verdict — one malformed row becomes an aborted candidate
        // with an unhandled error. Every other test in this file stays green.
        const r = resolveWriteTarget({
            provider: 'entra-id',
            onPremisesSyncEnabled: null,
            onPremStateObservedAt: new Date('nonsense'),
            now: NOW,
        });
        expect(r.allowed).toBe(false);
        expect(r.basis).toBe('OBSERVATION_STALE');
        expect(r.allowed === false && r.reason).toMatch(/unreadable timestamp/i);
    });

    it('the bound is INCLUSIVE at its edge', () => {
        // `>=` versus `>` at the comparison is invisible to every other test
        // here, and the constant governs two rails — `LINK_FRESHNESS_MS` is an
        // alias of it, so the same off-by-one would move the candidate query's
        // floor too.
        const exactlyAtBound = resolveWriteTarget({
            provider: 'entra-id',
            onPremisesSyncEnabled: null,
            onPremStateObservedAt: new Date(NOW.getTime() - OBSERVATION_FRESHNESS_MS),
            now: NOW,
        });
        expect(exactlyAtBound.allowed).toBe(true);

        const oneMsPast = resolveWriteTarget({
            provider: 'entra-id',
            onPremisesSyncEnabled: null,
            onPremStateObservedAt: new Date(NOW.getTime() - OBSERVATION_FRESHNESS_MS - 1),
            now: NOW,
        });
        expect(oneMsPast.allowed).toBe(false);
        expect(oneMsPast.basis).toBe('OBSERVATION_STALE');
    });

    it('accepts an ISO STRING, in both directions', () => {
        // The field is declared `Date | string | null`, and the string arm is
        // exercised above only in the FAILING direction. Replace `Date.parse`
        // with `NaN` and this file stays green without this case — every string
        // would simply fail closed, which the existing test already expects.
        //
        // No caller passes a string today (`identity-disable-account.ts` types
        // it `Date | null`), so this pins the declared contract rather than a
        // live path. That is deliberate: the contract is what a future caller
        // will rely on.
        const fresh = resolveWriteTarget({
            provider: 'entra-id',
            onPremisesSyncEnabled: null,
            onPremStateObservedAt: new Date(NOW.getTime() - 1 * DAY).toISOString(),
            now: NOW,
        });
        expect(fresh.allowed).toBe(true);
        expect(fresh.basis).toBe('CLOUD_ONLY_OBSERVED');

        const old = new Date(NOW.getTime() - 30 * DAY).toISOString();
        const stale = resolveWriteTarget({
            provider: 'entra-id',
            onPremisesSyncEnabled: null,
            onPremStateObservedAt: old,
            now: NOW,
        });
        expect(stale.allowed).toBe(false);
        // The string is echoed back, so the operator sees WHEN, not just that
        // it was too old.
        expect(stale.allowed === false && stale.reason).toContain(old);
    });
});

describe('unknown is refused — it is not the same as cloud-only', () => {
    it('refuses when the flag was never observed (no observation recorded)', () => {
        // The whole reason the column is nullable. A provider that could not
        // answer must not be read as having answered "no".
        const r = resolveWriteTarget({ provider: 'entra-id', onPremisesSyncEnabled: null });
        expect(r.allowed).toBe(false);
        expect(r.allowed === false && r.reason).toMatch(/never observed/i);
    });

    it('tells the operator how to make it known', () => {
        const r = resolveWriteTarget({ provider: 'entra-id', onPremisesSyncEnabled: null });
        expect(r.allowed === false && r.reason).toMatch(/run a successful directory sync/i);
    });

    it('does NOT retarget an unknown — we do not know where it lives', () => {
        // Retargeting to AD on an unknown would be the same guess in the other
        // direction.
        const r = resolveWriteTarget({ provider: 'entra-id', onPremisesSyncEnabled: null });
        expect(r.allowed === false && r.retargetTo).toBeUndefined();
    });
});

describe('the on-prem directory is always writable — it IS the authority', () => {
    it('allows active-directory regardless of the flag', () => {
        // A write here lands where the account is mastered, so nothing can
        // revert it. The flag is irrelevant, including when it is null.
        for (const flag of [true, false, null] as const) {
            expect(resolveWriteTarget({ provider: 'active-directory', onPremisesSyncEnabled: flag }).allowed).toBe(
                true,
            );
        }
    });
});

describe('an unrecognised provider is refused outright', () => {
    it('refuses a provider this platform does not disable accounts in', () => {
        const r = resolveWriteTarget({ provider: 'sharepoint', onPremisesSyncEnabled: false });
        expect(r.allowed).toBe(false);
        expect(r.allowed === false && r.reason).toMatch(/not a directory/i);
    });

    it('lists what IS supported, so the message is actionable', () => {
        const r = resolveWriteTarget({ provider: 'github', onPremisesSyncEnabled: false });
        expect(r.allowed === false && r.reason).toMatch(/active-directory/);
        expect(r.allowed === false && r.reason).toMatch(/entra-id/);
    });

    it('an unknown provider is refused even when it claims to be cloud-only', () => {
        // The provider allowlist is checked BEFORE the flag, so a made-up
        // provider cannot talk its way in by setting the flag conveniently.
        expect(resolveWriteTarget({ provider: 'made-up', onPremisesSyncEnabled: false }).allowed).toBe(false);
    });
});

describe('the verdict says WHICH rule produced it', () => {
    // The seven-day observation window's reader is deciding whether to grant
    // this thing unattended authority over their directory. `allowed: true` is
    // the same two words whether the account was observed cloud-only or whether
    // a rail was widened underneath them — #2144 widened one, moving a whole
    // population from REFUSED_TARGET to would-disable, and nothing in the report
    // said which rows rested on it.

    it('separates an observed cloud-only allow from an observed not-synced one', () => {
        // Both allow. Only one of them is the widened rule, and a report that
        // cannot tell them apart cannot show what #2144 changed.
        const cloudOnly = resolveWriteTarget({
            provider: 'entra-id',
            onPremisesSyncEnabled: null,
            onPremStateObservedAt: new Date(),
        });
        const notSynced = resolveWriteTarget({
            provider: 'entra-id',
            onPremisesSyncEnabled: false,
        });
        expect(cloudOnly.allowed).toBe(true);
        expect(notSynced.allowed).toBe(true);
        expect(cloudOnly.basis).toBe('CLOUD_ONLY_OBSERVED');
        expect(notSynced.basis).toBe('NOT_ON_PREM_SYNCED');
        expect(cloudOnly.basis).not.toBe(notSynced.basis);
    });

    it('labels the on-prem directory and the unsupported provider distinctly', () => {
        expect(
            resolveWriteTarget({ provider: 'active-directory', onPremisesSyncEnabled: null }).basis,
        ).toBe('ON_PREM_DIRECTORY');
        expect(
            resolveWriteTarget({ provider: 'sharepoint', onPremisesSyncEnabled: false }).basis,
        ).toBe('UNSUPPORTED_DIRECTORY');
    });

    it('labels a hybrid refusal ON_PREM_MASTERED', () => {
        expect(
            resolveWriteTarget({ provider: 'entra-id', onPremisesSyncEnabled: true }).basis,
        ).toBe('ON_PREM_MASTERED');
    });
});

describe('an UNOBSERVABLE account is not a NOT-YET-OBSERVED one', () => {
    // The pair #2144's no-backfill decision put on the same page at the same
    // time. Both refuse REFUSED_TARGET; the operator's response differs
    // completely — wait vs there is nothing to wait for — and until now both
    // carried the same sentence telling them to run a sync.

    it('an entra row nothing has looked at yet is NEVER_OBSERVED, and clears itself', () => {
        const r = resolveWriteTarget({ provider: 'entra-id', onPremisesSyncEnabled: null });
        expect(r.allowed).toBe(false);
        expect(r.basis).toBe('NEVER_OBSERVED');
        // The advice is followable: entra DOES answer, so a sync will stamp it.
        expect(r.allowed === false && r.reason).toMatch(/run a successful directory sync/i);
    });

    it('okta and google are PROVIDER_CANNOT_OBSERVE, and are told so', () => {
        for (const provider of ['okta', 'google-workspace']) {
            const r = resolveWriteTarget({ provider, onPremisesSyncEnabled: null });
            expect(r.allowed).toBe(false);
            expect(r.basis).toBe('PROVIDER_CANNOT_OBSERVE');
            // Positive: the message names the permanence.
            expect(r.allowed === false && r.reason).toMatch(/no sync to wait for/i);
            // Negative, paired with it: it does NOT repeat the entra advice,
            // which for these providers is an instruction nobody can carry out
            // — no sync will ever record a flag the directory does not have.
            expect(r.allowed === false && r.reason).not.toMatch(/run a successful directory sync/i);
        }
    });

    it('the two refusals are genuinely different strings, not one relabelled', () => {
        const entra = resolveWriteTarget({ provider: 'entra-id', onPremisesSyncEnabled: null });
        const okta = resolveWriteTarget({ provider: 'okta', onPremisesSyncEnabled: null });
        expect(entra.allowed === false && okta.allowed === false && entra.reason).not.toBe(
            okta.allowed === false ? okta.reason : '',
        );
        expect(entra.basis).not.toBe(okta.basis);
    });
});
