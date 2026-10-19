/**
 * THE SOURCE INTERFACE — one shape every reader of an estate implements.
 *
 * A source reads one kind of inventory (`okta-app`, `vault`, …) and returns
 * what it saw of each principal plus how far it got. It never throws for a
 * read that went wrong: it returns `INCOMPLETE` with a named reason, and the
 * scan runner turns an unexpected throw into the same thing. A source that
 * could not be read is reported, never omitted (contract, Sources).
 *
 * What a source may NOT do, by construction rather than by convention:
 *
 *   • Issue anything but a GET to the inventory it reads. It is handed a
 *     `ReadOnlyHttp`, whose only verb is `getJson`; there is no method
 *     parameter to pass. An OAuth token exchange is the one POST a source may
 *     make, through `oauth.ts`, to its identity provider and nowhere else.
 *   • Decide that the agent it found is registered. `registeredAgentId` is not
 *     a member of `Observation`: linking a principal to the register is the
 *     register's own source, never a label in the estate being scanned, which
 *     an estate administrator could write to hide a shadow agent.
 *   • Carry a credential value. An observation names a credential by a
 *     `scheme://locator` reference, and the runner refuses to sign a report in
 *     which any string has a secret's shape.
 */
import type { CriterionVerdict } from '@/lib/agentic/harness-ladder';
import type {
    HarnessReportAgent,
    INCOMPLETE_REASONS_V2,
    SOURCE_KINDS_V2,
} from '@/lib/agentic/harness-contract';

import type { ReadOnlyHttp, TokenExchange } from './http';

/** The scanner speaks `inflect-agent-harness/2`, so its kinds and reasons are `/2`'s. */
export type SourceKind = (typeof SOURCE_KINDS_V2)[number];
export type IncompleteReason = (typeof INCOMPLETE_REASONS_V2)[number];

export type ObservedCredential = HarnessReportAgent['credentials'][number];
export type ObservedOwner = NonNullable<HarnessReportAgent['owner']>;

/** What one source saw of one principal. Merged across sources by `discoveredId`. */
export interface Observation {
    readonly discoveredId: string;
    readonly owner: ObservedOwner | null;
    readonly credentials: readonly ObservedCredential[];
    /** Only verdicts the source holds evidence for; unanswered counts as no. */
    readonly verdicts: readonly CriterionVerdict[];
}

/** How far one source got, and what it saw on the way. */
export interface SourceRead {
    readonly kind: SourceKind;
    readonly status: 'COMPLETE' | 'INCOMPLETE';
    /** Present exactly when `status` is INCOMPLETE. */
    readonly reason?: IncompleteReason;
    /** Rows read from the inventory, whether or not each became an observation. */
    readonly rows: number;
    /** Principals seen, including on a read that stopped early: what WAS read is real. */
    readonly observations: readonly Observation[];
    /**
     * Credential references this source saw bound to NO principal (`/2`'s
     * `unboundCredentials[]`). A source that reports every credential against
     * the principal it belongs to — Okta's and Key Vault's both do — sees none
     * and leaves this out. The ingest acts on it only when the read was
     * COMPLETE, so a source that stopped early may still list what it saw.
     */
    readonly unboundCredentials?: readonly string[];
}

export interface SourceContext {
    /** The moment the scan describes. Ages are measured from it. */
    readonly asOf: Date;
    /** GET only. The one verb a source has against the inventory it reads. */
    readonly http: ReadOnlyHttp;
    /** The OAuth client-credentials exchange, for a source whose API takes a bearer token. */
    readonly tokens: TokenExchange;
}

/** Most pages one source follows. A listing longer than this is reported, not read forever. */
export const MAX_PAGES_PER_SOURCE = 1_000;

/**
 * Follow a paged listing from `first`, yielding each page's items. Every link
 * stays on `origin` (`getJson` refuses one that leaves it), a link seen twice
 * is a loop and so PAGINATION_TORN, and a page that is not the listing's shape
 * is PAGINATION_TORN too — never an empty page silently skipped.
 */
export async function* readPages(
    http: ReadOnlyHttp,
    first: string,
    opts: {
        readonly origin: string;
        readonly headers: Readonly<Record<string, string>>;
        /** The page's items and the next URL, or null when the page is not the listing's shape. */
        readonly parse: (body: unknown, headers: Headers) => { items: readonly unknown[]; next: string | null } | null;
    },
): AsyncGenerator<readonly unknown[]> {
    const seen = new Set<string>();
    let url: string | null = first;
    let pages = 0;
    while (url !== null) {
        if (seen.has(url)) throw new SourceReadError('PAGINATION_TORN', 'the listing linked back to a page it had served');
        if (pages >= MAX_PAGES_PER_SOURCE) throw new SourceReadError('BYTE_CAP', 'the listing ran past the page cap');
        seen.add(url);
        pages += 1;
        const { body, headers } = await http.getJson(url, { origin: opts.origin, headers: opts.headers });
        const page = opts.parse(body, headers);
        if (page === null) throw new SourceReadError('PAGINATION_TORN', 'a page was not the listing it should be');
        yield page.items;
        url = page.next;
    }
}

export interface HarnessSource {
    readonly kind: SourceKind;
    /** The product behind the kind, e.g. `okta` or `azure-key-vault`. Not reported. */
    readonly product: string;
    read(ctx: SourceContext): Promise<SourceRead>;
}

/** A source read that stopped, with the contract's reason. */
export class SourceReadError extends Error {
    constructor(
        readonly reason: IncompleteReason,
        message: string,
    ) {
        super(message);
        this.name = 'SourceReadError';
    }
}

/**
 * A source's result from what it collected and how it stopped. `stoppedBy` is
 * null for a read that reached the end. Anything other than a
 * `SourceReadError` is a fault in the reader rather than in the estate, and is
 * still reported as INCOMPLETE — UNREACHABLE, the reason that claims least —
 * because a source the scanner failed to read is a source it did not read.
 */
export function sourceResult(
    kind: SourceKind,
    rows: number,
    observations: readonly Observation[],
    stoppedBy: unknown,
): SourceRead {
    if (stoppedBy === null) return { kind, status: 'COMPLETE', rows, observations };
    const reason: IncompleteReason = stoppedBy instanceof SourceReadError ? stoppedBy.reason : 'UNREACHABLE';
    return { kind, status: 'INCOMPLETE', reason, rows, observations };
}

/** An identifier a source hands back, as it may appear inside a discovered id or a locator. */
export function isPlainId(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9._~-]{1,128}$/.test(value);
}

/** Whole days from `from` to `asOf`, never negative; null when `from` is absent or unparseable. */
export function ageInDays(from: Date | null, asOf: Date): number | null {
    if (from === null || Number.isNaN(from.getTime())) return null;
    return Math.max(0, Math.floor((asOf.getTime() - from.getTime()) / 86_400_000));
}
