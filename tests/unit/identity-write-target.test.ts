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
import { resolveWriteTarget } from '@/app-layer/usecases/identity-write-target';

describe('a cloud-mastered account may be written in the cloud directory', () => {
    it('allows an Entra account observed as NOT synced from on-prem', () => {
        expect(resolveWriteTarget({ provider: 'entra-id', onPremisesSyncEnabled: false })).toEqual({
            allowed: true,
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

describe('unknown is refused — it is not the same as cloud-only', () => {
    it('refuses when the flag was never observed', () => {
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
