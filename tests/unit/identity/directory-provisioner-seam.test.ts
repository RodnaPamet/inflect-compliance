/**
 * #2674 — the joiner's seam refuses to let "cannot tell" read as "free".
 *
 * The seam exists because a joiner and a leaver want OPPOSITE things from
 * an absent account. `DirectoryWriter.readState` throws
 * `definitivelyNotApplied` when the last enumeration did not see an
 * account — correct for a leaver, where absence is an anomaly. For a
 * joiner absence is the SUCCESS case, so a joiner reaching through that
 * seam would raise a provider error for every legitimate candidate.
 *
 * What these tests actually protect is narrower and more important than
 * "the interface exists": **the snapshot arm must never answer `free`.**
 *
 * It holds rows from a past enumeration. Create-time uniqueness is
 * enforced on namespaces this product persists nowhere — Entra's
 * `userPrincipalName` / `mailNickname` / `proxyAddresses`, Active
 * Directory's `sAMAccountName`. So "the roster has no row for this
 * address" and "this address is claimable" are different statements, and
 * the first does not imply the second.
 *
 * The plausible future edit is someone noticing that `unknown` blocks
 * every plan and "fixing" it by returning `free` when the roster has no
 * match. That would turn *we did not look* into *we looked and it is
 * available*, and the create that followed is the one owner decision 1
 * forbids — an account whose address diverges from the one the leaver
 * path could later disable. These tests are what makes that edit loud.
 */
import {
    createSnapshotProvisioner,
    type DirectoryProvisioner,
    type IdentifierProbe,
} from '@/app-layer/integrations/identity-provisioner';

const ENTRA_NAMESPACES = ['userPrincipalName', 'mailNickname', 'proxyAddresses'] as const;

describe('#2674 — the DirectoryProvisioner seam', () => {
    describe('the snapshot arm answers UNKNOWN, never FREE', () => {
        it('returns unknown for an identifier the roster has never seen', async () => {
            const p = createSnapshotProvisioner('entra-id', ENTRA_NAMESPACES);
            const probe = await p.probeIdentifier('nobody.here@example.test');

            // The load-bearing assertion of this file.
            expect(probe.kind).toBe('unknown');
            expect(probe.kind).not.toBe('free');
        });

        it('returns unknown for EVERY identifier, including an obviously absurd one', async () => {
            // A denominator rather than one example: if some inputs came back
            // free, this arm would be answering a question it cannot answer,
            // and one lucky sample would hide it.
            const p = createSnapshotProvisioner('entra-id', ENTRA_NAMESPACES);
            const candidates = [
                'a@b.test',
                'first.last@example.test',
                '',
                'not-an-address',
                'MiXeD.CaSe@Example.TEST',
            ];

            const kinds = await Promise.all(
                candidates.map(async (c) => (await p.probeIdentifier(c)).kind),
            );

            expect(kinds).toEqual(candidates.map(() => 'unknown'));
        });

        it('names the namespaces it could NOT consult, non-empty', async () => {
            const p = createSnapshotProvisioner('entra-id', ENTRA_NAMESPACES);
            const probe = await p.probeIdentifier('x@example.test');
            if (probe.kind !== 'unknown') throw new Error('expected unknown');

            // An `unknown` naming nothing would be indistinguishable from a
            // `free` nobody checked — the reader could not tell which
            // question went unanswered.
            expect(probe.namespacesUnavailable.length).toBeGreaterThan(0);
            expect([...probe.namespacesUnavailable]).toEqual([...ENTRA_NAMESPACES]);
        });

        it('says WHY in a way that names the distinction, not just "unavailable"', async () => {
            const p = createSnapshotProvisioner('entra-id', ENTRA_NAMESPACES);
            const probe = await p.probeIdentifier('x@example.test');
            if (probe.kind !== 'unknown') throw new Error('expected unknown');

            // An operator reading a seven-day artefact needs to know the plan
            // did not check, rather than inferring it from a blank.
            expect(probe.detail).toMatch(/userPrincipalName/);
            expect(probe.detail).toMatch(/UNKNOWN rather/i);
        });
    });

    describe('the type makes the three outcomes distinguishable', () => {
        it('a free answer carries the namespaces it DID consult', () => {
            // Exercised through the type rather than the snapshot arm, which
            // by design never produces this shape. A live arm (#2608) will.
            const free: IdentifierProbe = {
                kind: 'free',
                namespacesChecked: ['userPrincipalName'],
            };
            if (free.kind !== 'free') throw new Error('unreachable');
            expect(free.namespacesChecked).toEqual(['userPrincipalName']);
        });

        it('a taken answer names the namespace that held it', () => {
            const taken: IdentifierProbe = {
                kind: 'taken',
                namespace: 'sAMAccountName',
                externalUserId: 'S-1-5-21',
                detail: 'held',
            };
            if (taken.kind !== 'taken') throw new Error('unreachable');
            expect(taken.namespace).toBe('sAMAccountName');
        });
    });

    describe('the seam declares what a create collides in', () => {
        it('carries the collision namespaces the provider enforces', () => {
            const p: DirectoryProvisioner = createSnapshotProvisioner('entra-id', ENTRA_NAMESPACES);
            // Declared by the provisioner because only the provider knows
            // them; read by the caller because only the caller reports them.
            expect([...p.collisionNamespaces]).toEqual([...ENTRA_NAMESPACES]);
            expect(p.provider).toBe('entra-id');
        });

        it('an AD provisioner declares a DIFFERENT namespace set', () => {
            // The namespaces are not a constant of the seam — they are a fact
            // about the directory, and a seam that hard-coded Entra's would
            // silently under-report on AD.
            const ad = createSnapshotProvisioner('active-directory', ['sAMAccountName']);
            expect([...ad.collisionNamespaces]).toEqual(['sAMAccountName']);
        });
    });
});
