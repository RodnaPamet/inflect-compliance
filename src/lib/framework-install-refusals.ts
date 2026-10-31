/**
 * The named refusals a framework pack preview or install can get (#4731).
 *
 * Each travels in `error.details.reason`, beside an English `error.message`.
 * The install wizard words a known reason from
 * `frameworks.install.refused.<reason>`, so the person reads the refusal in
 * their own language rather than the server's English sentence.
 *
 * Client-safe: no server imports, so the wizard can read the reasons.
 */

export const FRAMEWORK_INSTALL_REFUSALS = [
    /** A pack key names no pack in the catalogue. */
    'PACK_NOT_FOUND',
    /** A preview or install of a multi-pack framework named no pack. */
    'NO_PACK_CHOSEN',
    /** The choice mixed in a pack of a different framework. */
    'PACK_OF_OTHER_FRAMEWORK',
] as const;

export type FrameworkInstallRefusal = (typeof FRAMEWORK_INSTALL_REFUSALS)[number];

const KNOWN: ReadonlySet<string> = new Set<string>(FRAMEWORK_INSTALL_REFUSALS);

/** The named reason in a parsed API error body, or null when it names none of these. */
export function frameworkInstallRefusal(body: unknown): FrameworkInstallRefusal | null {
    const reason = (body as { error?: { details?: { reason?: unknown } } } | null)?.error
        ?.details?.reason;
    return typeof reason === 'string' && KNOWN.has(reason) ? (reason as FrameworkInstallRefusal) : null;
}
