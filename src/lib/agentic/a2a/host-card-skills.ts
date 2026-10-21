/**
 * WHAT THE HOST-CONSUMER CARD ADVERTISES (#3862).
 *
 * One A2A skill per workflow definition that carries `a2aSkill` — reviewed
 * public copy, written for a stranger. A definition without it is never
 * advertised, which makes absence the default and the safe one: reaching the
 * public card takes a reviewed diff, not a flag.
 *
 * ## This does not read the tenant, and that is the decision
 *
 * The list is IDENTICAL for every tenant. It is not the caller's grant —
 * `HostConsumer.workflowKeys` is, enforced per request from the row in
 * `startInboundRun` (`a2a-inbound.ts`). The owner decision and its reasoning
 * are on #3862: the card is public, unauthenticated and one per tenant, so a
 * card built from grants would have published the union across a tenant's
 * consumers, telling each one what the others may call.
 *
 * So a host may read a skill here and still be refused `WORKFLOW_NOT_ALLOWED`.
 * That is correct behaviour, not a misconfiguration.
 *
 * ## The id is the workflow key, never authored
 *
 * `A2aPublicSkillCopy` has no `id`; it is taken from `key` here. A host sends
 * the skill id back as `workflowKey`, so an authored id that drifted from the
 * key would put a skill on the card that no caller can invoke. Taking it from
 * the key makes that impossible rather than merely tested.
 */
import { listWorkflowDefinitions } from '../workflow-registry';
import type { A2aPublicSkill } from '../workflow-types';

/**
 * The advertised skills, in workflow-key order.
 *
 * Pure and deterministic: the card is signed over its canonical form, so these
 * bytes must not depend on registry insertion order. `buildInflectHostConsumerCard`
 * sorts again by id, which is the same ordering — sorting in both places is
 * deliberate, so neither function depends on the other having done it.
 */
export function advertisedA2aSkills(): readonly A2aPublicSkill[] {
    return listWorkflowDefinitions()
        .flatMap((def) => (def.a2aSkill ? [{ id: def.key, ...def.a2aSkill }] : []))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
