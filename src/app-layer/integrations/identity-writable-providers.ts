/**
 * WHICH directories this product can write to — the name of the set, with none
 * of the machinery that writes to them.
 *
 * ═══ WHY THIS IS ITS OWN FILE ═══
 *
 * It used to live in `identity-writer-factory.ts`, which is the right home for
 * the SEAM and the wrong one for the LIST. The factory imports both provider
 * writers at module scope, the Active Directory provider's index pulls in
 * `webhook-safety`, and that imports `undici` — so anything wanting to know
 * "is `okta` a directory we can write to?" had to load two directory-writer
 * implementations and a HTTP dispatcher to find out.
 *
 * That is a real cost rather than a tidiness one. A Next route that validates a
 * provider name against this set is in the request path; dragging the writers
 * into its module graph means every deploy of that route ships them, and in a
 * Jest environment the undici import fails outright (`ReferenceError: File is
 * not defined`), which is how the split was discovered. The alternative — a
 * second hard-coded copy of the list at the route — is the drift this repo
 * spends most of its guards preventing: the set that VALIDATES and the set that
 * RESOLVES A WRITER would be free to disagree, and the failure mode is a 202
 * for a directory nothing can write to.
 *
 * `identity-writer-factory` re-exports all three symbols, so every existing
 * importer is unchanged and there is still exactly one definition.
 *
 * ADDING A PROVIDER HERE IS NOT ENOUGH. The name only resolves once
 * `createWriterForConnection` has a branch that builds a writer for it, and
 * `tests/guards/identity-log-identifier-scrub.test.ts` additionally requires
 * the new writer's log lines to go through `redactDirectoryIdentifiers`. A name
 * added here alone becomes a provider the API accepts and the factory refuses
 * — which is strictly worse than refusing at the edge.
 *
 * @module integrations/identity-writable-providers
 */

/** The providers this product can write to. Nothing else resolves. */
export const WRITABLE_IDENTITY_PROVIDERS = ['entra-id', 'active-directory'] as const;
export type WritableIdentityProvider = (typeof WRITABLE_IDENTITY_PROVIDERS)[number];

export function isWritableIdentityProvider(p: string): p is WritableIdentityProvider {
    return (WRITABLE_IDENTITY_PROVIDERS as readonly string[]).includes(p);
}
