/**
 * THE MANAGED AGENTS SWITCH — `AGENT_MANAGED_AGENTS` (Step 5a of
 * docs/claude-managed-agents-design.md).
 *
 * OPT-IN. With it unset the `anthropic-workspace` provider is not registered
 * (`integrations/bootstrap.ts`), so no connection to a customer's Anthropic
 * workspace can be saved or tested, and the integrations page, which offers the
 * card only for a provider the server lists, shows none. Exactly `'1'` and
 * `'true'` (case-insensitive, trimmed) turn it on; anything else, a typo
 * included, leaves it off. One parser for every agent switch: `flueEnvEnabled`.
 *
 * Read at registration, which happens once per process. Changing it takes a
 * restart, as every other registry decision does.
 */
import { env } from '@/env';
import { flueEnvEnabled } from './agent-driver';

export function managedAgentsEnabled(raw: string | null | undefined = env.AGENT_MANAGED_AGENTS): boolean {
    return flueEnvEnabled(raw);
}
