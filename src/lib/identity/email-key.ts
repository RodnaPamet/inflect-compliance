/**
 * The ONE normalisation rule for an identity address, and the reason it is a
 * module rather than a private helper.
 *
 * It was a private function in `usecases/identity-account-link.ts`, which is
 * correct for a matcher that is the only thing asking the question. The joiner
 * planner asks the same question — "is the address I intend the address this
 * directory already holds?" — and `docs/jml-joiner-design.md` names a private
 * second copy as the defect it must not ship:
 *
 *   > Normalise with the reconciler's own rule, not a second one … A private
 *   > normaliser here is how the collision check and the link matcher come to
 *   > disagree about the same address — and a disagreement between those two is
 *   > exactly the account the leaver can never disable.
 *
 * That failure is not hypothetical arithmetic. The reconciler joins
 * `Employee.workEmail` to `ConnectedIdentityAccount.email` through this rule; an
 * account created under an address the joiner considered free, but which the
 * matcher would fold onto a different key, is an account no `IdentityAccountLink`
 * ever covers — and the leaver acts only on linked accounts. The wrong answer
 * surfaces months later, on a termination, as access that was never removed.
 *
 * SERVER-FREE on purpose. The joiner planner is a pure decision module with no
 * prisma and no provider imports (that is what lets a DRY_RUN plan be computed
 * without a directory, a socket or a queue), so the shared rule cannot live in a
 * usecase that pulls the db context in behind it.
 *
 * @module lib/identity/email-key
 */

/**
 * Normalised join key. Directory casing and HR casing routinely disagree.
 *
 * Empty maps to `null` rather than `''` so an absent address cannot collide with
 * another absent address: `'' === ''` would match every emailless row to every
 * other one, which for a matcher is a wrong link and for the joiner's collision
 * read is a fabricated conflict.
 */
export function emailKey(raw: string | null | undefined): string | null {
    const v = String(raw ?? '').trim().toLowerCase();
    return v.length > 0 ? v : null;
}
