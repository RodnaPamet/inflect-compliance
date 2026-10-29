/**
 * A scanner source's NAME, as the estate form offers it (#4474).
 *
 * The harness tab showed a source by its stable id — `entra-sp`, `okta-app`,
 * `gcp-sa` — while the estate form beside it already named the same sources
 * from `agents.harness.estates.form.kind.*`. One label per source, read from
 * that one place, so the two cannot drift. A kind this client does not know
 * (a newer scanner contract, read by an older container) is shown as stored
 * rather than as a missing translation key.
 */
import { SOURCE_KINDS } from '@/lib/agentic/harness-contract-rules';

const KNOWN: ReadonlySet<string> = new Set<string>(SOURCE_KINDS);

/** The `agents` translator, narrowed to the one call this needs. */
type AgentsTranslator = (key: string) => string;

export function sourceKindLabel(t: AgentsTranslator, kind: string): string {
    return KNOWN.has(kind) ? t(`harness.estates.form.kind.${kind}`) : kind;
}
