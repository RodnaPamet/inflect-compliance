/**
 * Agent recertification (step 3a, #3674) — the hashes. SERVER ONLY.
 *
 * Apart from `agent-recertification.ts` because that module is reachable from
 * a client component (`RuleBuilderModal` → the workflow registry → the pack
 * workflow → `planAgentReviewPacks`), and these need `node:crypto`. Importing
 * it there broke `next build`; a bare `crypto` would have compiled only by
 * bundling a browser polyfill into the processes page.
 *
 * Moving the hash out of the plan changes nothing it means. The pack's hash
 * was always over the sections the server stores, and the server computes it
 * now as it writes them; whether the plan follows from the recorded read is a
 * separate check, `checkedPlan`, which re-derives the plan and refuses a
 * recorded one that differs (`PACK_PLAN_MISMATCH`).
 *
 * Import this from the usecase layer only. A workflow step, or anything else
 * the registry reaches, must not —
 * `tests/guards/client-reachable-modules-import-no-node-builtins.test.ts`
 * fails if it does.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '@/lib/canonical-json';

import { agentCampaignEvidenceBytes, type AgentCampaignEvidence } from './agent-recertification';

/** `sha256:<hex>` over the canonical JSON of a value — a pack's content hash. */
export function sha256Of(value: unknown): string {
    return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

/**
 * The closing evidence's content hash: hex SHA-256 of exactly the bytes
 * stored, so it equals the stored file's `sha256` and anybody holding the file
 * can check it.
 */
export function agentCampaignEvidenceHash(doc: AgentCampaignEvidence): string {
    return createHash('sha256').update(agentCampaignEvidenceBytes(doc), 'utf8').digest('hex');
}
