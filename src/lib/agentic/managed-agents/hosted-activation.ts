/**
 * WHETHER INFLECT'S OWN ANTHROPIC ORGANISATION MAY HOST MANAGED AGENTS RUNS
 * (Step 6b of `docs/claude-managed-agents-design.md`, shape MA-C1).
 *
 * A LEAF MODULE, on purpose, as `lib/legacy-access/adjudication-mode.ts` is for
 * `TYPESAFE_SUBPROCESSOR_ACTIVE`: it imports nothing, so the settings page, the
 * engine setting and the clean-up can ask "is hosting active?" without loading
 * the engine, the SDK or the environment module.
 *
 * Hosting is a SUB-PROCESSOR CHANGE (Anthropic (g) in `docs/sub-processors.md`):
 * every opted-in tenant's instructions and read-tool output would be stored, in
 * the US and without Zero Data Retention, by Inflect's own sub-processor. Under
 * `docs/sub-processor-change-policy.md` no tenant's data may reach that
 * processing until 30 days after customers were notified (the Step 6a notice
 * went out on 2026-11-24; its window closes on 2026-12-24) and no objection is
 * sustained.
 */

/**
 * `false`, and it stays false until Step 6c. Setting it `true` IS the
 * sub-processor activation: a reviewed one-line diff, in a commit of its own,
 * naming the Step 6a pull request and the date the notice window closed. It is
 * never an environment variable or a tenant setting, because neither is a
 * reviewed decision about the deployment's DPA.
 *
 * While it is false, `inflectHostedWorkspace` (`./workspace.ts`) returns before
 * it reads Inflect's workspace id or key, so no input resolves the hosted
 * workspace and no client is ever built with Inflect's key.
 * `tests/guards/hosted-managed-agents-activation.test.ts` reads that function's
 * source for the order.
 *
 * Tests reach the `true` branch only through `jest.mock` of THIS module (a
 * module seam): production has no `jest`, and nothing in `src/` writes it.
 */
export const HOSTED_MANAGED_AGENTS_ACTIVE = false;
