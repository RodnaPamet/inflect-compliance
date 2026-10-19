/**
 * THE LANGSMITH SOURCE — the `runtime` kind (#3738, owner decisions 2026-10-19).
 *
 * A customer that runs its agents under LangSmith has, in LangSmith, the one
 * inventory that knows which agents RAN and which tools they CALLED. This
 * reads it, read-only, and reports two kinds of agent:
 *
 *   • DEPLOYMENTS, WHEN THE ESTATE OPTS IN. `GET /v2/deployments` (the
 *     LangSmith Deployment control plane), paged by offset, and only with
 *     `readDeployments: true` (owner decision 2026-10-19: off by default,
 *     because that listing carries each deployment's secrets). A deployment is
 *     an agent server by existence, so every one listed is reported, as
 *     `langsmith:deployment:<id>`, whether or not it ran in the window. Its
 *     tools are those its tracing project (`tracer_session_id`) recorded.
 *   • TRACING PROJECTS. `GET /api/v1/sessions`, paged by offset, experiments
 *     excluded (`reference_free=true`). A project that no deployment writes to
 *     is reported, as `langsmith:project:<id>`, when it recorded at least one
 *     TOOL call in the window: a loop that calls tools is an agent, and a
 *     project that only ever called a model is counted in `rows` and reported
 *     as nothing — the same rule as an untagged vault item.
 *
 * TOOL USAGE IS AN AGGREGATE, NEVER A RUN. The projects listing is asked for its
 * stats over the window, filtered to tool runs (`stats_filter`), with run
 * facets: `run_count` is the tool calls the project recorded, and the facets
 * keyed `name` are those calls by tool name. No run is ever fetched — not
 * `GET /api/v1/runs/{id}`, not `POST /api/v1/runs/query` — so no run input,
 * output or trace crosses the wire. `scanner-surface.ts` declares this
 * source's three paths as its whole surface and the tests hold the request log
 * to it.
 *
 * WHAT THE REPORT CAN AND CANNOT CARRY. A tool is reported with `server` set to
 * the project its calls were traced in (`langsmith://<host>/projects/<id>`:
 * LangSmith does not record which server, if any, served a tool),
 * `manifestHash: null` and `pinned: false` (LangSmith records no definition,
 * so nothing the scanner saw pins one), and `readOnlyHint: null` (none is
 * declared; the contract counts that as a write). The call COUNT has a member
 * in `inflect-agent-harness/2` (`calls`, with `windowDays`) that a follow-up of
 * #3738 fills; until then the source holds it on the observation and the
 * scanner's log reports the total. A tool name that is not a plain identifier
 * — a run name can be set at call time, and so can carry content — is
 * reported as a digest (`tool-sha256:<16 hex>`), never verbatim.
 *
 * COMPLETENESS IS PROVEN, NOT ASSUMED. Each project's stats must account for
 * every tool call they count: the `name` facets must sum to `run_count`, or
 * the facets were cut short and the read is PAGINATION_TORN rather than a
 * partial tool list reported as the whole. Stats that are absent, a facet that
 * is not a count, a page that is not the listing, a page cut short and a
 * project seen twice across offsets (the listing shifted under the reader) are
 * PAGINATION_TORN too. A rejected or expired key is AUTH_FAILED and a refused
 * host UNREACHABLE, by the shared wire.
 *
 * WHAT IS NEVER KEPT. The two listings return more than this reads. A
 * deployment carries its `secrets` and its source configuration; a project
 * carries a description, `extra` metadata and facets over run tags and run
 * metadata. Each page is parsed and then only the members named below are
 * read: ids, the deployment's tracing project, and the project's tool-run
 * count and `name` facets. The rest never reaches an observation, the report
 * or a log line, and the tests hold that with marker strings in every one of
 * those members.
 *
 * NO LINK TO THE REGISTER, AND NO OWNER. A deployment's name or metadata could
 * say which register agent it is; that is a label in the estate being scanned,
 * so it is not read (see `source.ts`). LangSmith records no accountable owner
 * for a project or a deployment, so `owner` is null.
 *
 * HOSTS. The US or EU cloud API host, fixed here, or the customer's own
 * self-hosted LangSmith, which `customer-host.ts` checks when the configuration
 * is read and re-resolves before every request — against the estate's private
 * range allowlist, if it names one, inside which metadata, loopback and
 * link-local stay refused. Every request is https, on the configured origin,
 * with redirects refused; no next link is server-supplied, because both
 * listings page by offset and the source builds every page's URL itself.
 *
 * The endpoint paths and the facet shape are declared once, below. The paths
 * and every query parameter are in LangSmith's published OpenAPI documents;
 * the members of one run facet (`key`, `value`, `n`) are not documented there,
 * and are the one assumption a live workspace has to confirm — which is why a
 * facet that does not read as a count stops the read rather than being skipped.
 */
import { createHash } from 'crypto';

import { looksLikeSecret } from '@/lib/agentic/harness-contract';

import {
    assertResolvesReachable,
    parsePrivateCidrAllowlist,
    resolveWithDns,
    type PrivateCidrAllowlist,
    type ResolveHost,
} from '../customer-host';
import type { ReadOnlyHttp } from '../http';
import {
    isPlainId,
    readPages,
    sourceResult,
    SourceReadError,
    type HarnessSource,
    type Observation,
    type ObservedToolUse,
    type SourceContext,
    type SourceRead,
} from '../source';

/** LangSmith's cloud API hosts by data region (owner decision 2026-10-19: US and EU). */
export const LANGSMITH_CLOUD_ORIGINS = {
    us: 'https://api.smith.langchain.com',
    eu: 'https://eu.api.smith.langchain.com',
} as const;
export type LangSmithCloud = keyof typeof LANGSMITH_CLOUD_ORIGINS;

/**
 * THE ENDPOINTS, in one table. The cloud serves the control plane on the API
 * host itself; a self-hosted LangSmith serves it under `/api-host`. A path
 * that proves wrong against a live workspace is corrected here, and only here:
 * `scanner-surface.ts` declares what this table holds.
 */
export const LANGSMITH_READ_PATHS = {
    cloud: { projects: '/api/v1/sessions', deployments: '/v2/deployments' },
    selfHosted: { projects: '/api/v1/sessions', deployments: '/api-host/v2/deployments' },
} as const;

/** The runs whose stats are asked for: tool calls, in LangSmith's filter grammar. */
export const LANGSMITH_TOOL_RUN_FILTER = 'eq(run_type, "tool")';
/** The run facet whose values are run names — for tool runs, tool names. Its members are `key`, `value` and `n`. */
export const LANGSMITH_NAME_FACET_KEY = 'name';
/** Items per page: the most either listing returns. */
export const LANGSMITH_PAGE_SIZE = 100;
export const LANGSMITH_DEFAULT_WINDOW_DAYS = 7;
export const LANGSMITH_MAX_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

export type LangSmithEndpoint =
    | { readonly cloud: LangSmithCloud }
    | {
          readonly selfHosted: string;
          /** Private ranges the self-hosted host may resolve into; metadata, loopback and link-local never. */
          readonly egressPrivateCidrAllowlist?: readonly string[];
      };

export interface LangSmithSourceOptions {
    readonly endpoint: LangSmithEndpoint;
    /** A read-scoped LangSmith API key, resolved from the environment by the caller. */
    readonly apiKey: string;
    /** The workspace to read (`X-Tenant-Id`); null for a key that is scoped to one workspace already. */
    readonly workspaceId: string | null;
    /** The bounded window the tool usage is summarised over, in days. */
    readonly windowDays: number;
    /** Whether the estate opted in to listing deployments (off by default: the listing carries their secrets). */
    readonly readDeployments: boolean;
    /** How a self-hosted host is re-resolved before each request. DNS unless a test passes its own. */
    readonly resolveHost?: ResolveHost;
}

const TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;

/**
 * A tool name as the report may carry it. A model calls a tool by an
 * identifier, so a real tool name is one; anything else — spaces, punctuation,
 * a secret's shape, past 128 characters — is a run name somebody set at call
 * time, which can carry content, and is reported by digest.
 */
export function reportableToolName(raw: string): string {
    if (TOOL_NAME.test(raw) && !looksLikeSecret(raw)) return raw;
    return `tool-sha256:${createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16)}`;
}

function isCount(v: unknown): v is number {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** The only members of a project this source reads. */
interface LsProject {
    id?: unknown;
    reference_dataset_id?: unknown;
    run_count?: unknown;
    run_facets?: unknown;
}

/** The only members of a deployment this source reads. */
interface LsDeployment {
    id?: unknown;
    tracer_session_id?: unknown;
}

interface LsFacet {
    key?: unknown;
    value?: unknown;
    n?: unknown;
}

/**
 * A project's tool calls in the window, by reportable tool name — or null when
 * its stats cannot vouch for them: no count, a `name` facet that is not a
 * count, or facets that account for fewer or more calls than the count.
 */
export function toolUsageOf(project: Pick<LsProject, 'run_count' | 'run_facets'>): Map<string, number> | null {
    if (!isCount(project.run_count)) return null;
    const usage = new Map<string, number>();
    if (project.run_count === 0) return usage;
    if (!Array.isArray(project.run_facets)) return null;
    let accounted = 0;
    for (const facet of project.run_facets as LsFacet[]) {
        if (facet === null || typeof facet !== 'object' || facet.key !== LANGSMITH_NAME_FACET_KEY) continue;
        if (typeof facet.value !== 'string' || facet.value === '' || !isCount(facet.n)) return null;
        accounted += facet.n;
        if (facet.n === 0) continue;
        const name = reportableToolName(facet.value);
        usage.set(name, (usage.get(name) ?? 0) + facet.n);
    }
    return accounted === project.run_count ? usage : null;
}

/** The query that asks for every non-experiment project with its tool-run stats since `since`. */
function projectsQuery(since: string, offset: number): string {
    const params: [string, string][] = [
        ['reference_free', 'true'],
        ['include_stats', 'true'],
        ['facets', 'true'],
        ['stats_start_time', since],
        ['stats_filter', LANGSMITH_TOOL_RUN_FILTER],
        ['stats_select', 'run_count'],
        ['stats_select', 'run_facets'],
        // Oldest-created last: a project created mid-read pushes the rest down
        // a place, and the repeat that causes is caught as a torn listing.
        ['sort_by', 'start_time'],
        ['sort_by_desc', 'true'],
        ['limit', String(LANGSMITH_PAGE_SIZE)],
        ['offset', String(offset)],
    ];
    // `%20`, never the `+` of form encoding: the filter grammar has spaces.
    return params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

/** A GET-only reader that re-resolves the host before every request it makes. */
function guarded(http: ReadOnlyHttp, resolve: ResolveHost, allowlist: PrivateCidrAllowlist): ReadOnlyHttp {
    return {
        async getJson(url, o) {
            await assertResolvesReachable(new URL(url).hostname, resolve, allowlist);
            return http.getJson(url, o);
        },
    };
}

export function langSmithSource(opts: LangSmithSourceOptions): HarnessSource {
    const selfHosted = 'selfHosted' in opts.endpoint;
    const origin = 'selfHosted' in opts.endpoint
        ? new URL(opts.endpoint.selfHosted).origin
        : LANGSMITH_CLOUD_ORIGINS[opts.endpoint.cloud];
    const host = new URL(origin).host;
    const paths = selfHosted ? LANGSMITH_READ_PATHS.selfHosted : LANGSMITH_READ_PATHS.cloud;
    const headers: Record<string, string> = { 'X-Api-Key': opts.apiKey };
    if (opts.workspaceId !== null) headers['X-Tenant-Id'] = opts.workspaceId;
    const resolve = opts.resolveHost ?? resolveWithDns;
    // An entry that does not parse admits nothing: the configuration refuses
    // one, and here it fails closed rather than widening anything.
    const allowlist: PrivateCidrAllowlist =
        'selfHosted' in opts.endpoint
            ? parsePrivateCidrAllowlist(opts.endpoint.egressPrivateCidrAllowlist ?? []) ?? []
            : [];

    return {
        kind: 'runtime',
        product: 'langsmith',
        async read(ctx: SourceContext): Promise<SourceRead> {
            const http = selfHosted ? guarded(ctx.http, resolve, allowlist) : ctx.http;
            const since = new Date(ctx.asOf.getTime() - opts.windowDays * DAY_MS).toISOString();
            const deployments: { id: string; projectId: string | null }[] = [];
            const usage = new Map<string, Map<string, number>>();
            let rows = 0;

            const toolsOf = (projectId: string | null): ObservedToolUse[] =>
                [...(projectId === null ? [] : usage.get(projectId) ?? new Map<string, number>())]
                    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                    .map(([name, calls]) => ({
                        tool: {
                            server: `langsmith://${host}/projects/${projectId}`,
                            name,
                            manifestHash: null,
                            pinned: false,
                            readOnlyHint: null,
                        },
                        calls,
                    }));

            // What was read is real, on a read that stopped as on one that did not.
            const observations = (): Observation[] => {
                const claimed = new Set(deployments.map((d) => d.projectId).filter((p): p is string => p !== null));
                const out: Observation[] = deployments.map((d) => ({
                    discoveredId: `langsmith:deployment:${d.id}`,
                    owner: null,
                    credentials: [],
                    verdicts: [],
                    tools: toolsOf(d.projectId),
                }));
                for (const [projectId, tools] of usage) {
                    if (claimed.has(projectId) || tools.size === 0) continue;
                    out.push({
                        discoveredId: `langsmith:project:${projectId}`,
                        owner: null,
                        credentials: [],
                        verdicts: [],
                        tools: toolsOf(projectId),
                    });
                }
                return out;
            };

            try {
                // Deployments FIRST: a project is reported as itself only once
                // the scanner knows no deployment writes to it, so a read that
                // stops part-way never reports a deployment's project as an
                // agent of its own.
                if (opts.readDeployments) {
                    const seen = new Set<string>();
                    let at = 0;
                    const url = (offset: number) => `${origin}${paths.deployments}?limit=${LANGSMITH_PAGE_SIZE}&offset=${offset}`;
                    const parse = (body: unknown) => {
                        if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
                        const { resources, offset } = body as { resources?: unknown; offset?: unknown };
                        if (!Array.isArray(resources) || resources.length > LANGSMITH_PAGE_SIZE) return null;
                        if (resources.length < LANGSMITH_PAGE_SIZE) return { items: resources, next: null };
                        // A full page: the next starts where the server says, which must be further on.
                        if (!isCount(offset) || offset <= at) return null;
                        at = offset;
                        return { items: resources, next: url(at) };
                    };
                    for await (const page of readPages(http, url(0), { origin, headers, parse })) {
                        for (const item of page as (LsDeployment | null)[]) {
                            rows += 1;
                            const id = item?.id;
                            if (!isPlainId(id)) throw new SourceReadError('PAGINATION_TORN', 'a deployment had no usable id');
                            if (seen.has(id)) throw new SourceReadError('PAGINATION_TORN', 'a deployment was listed twice');
                            seen.add(id);
                            const project = item?.tracer_session_id ?? null;
                            if (project !== null && !isPlainId(project)) {
                                throw new SourceReadError('PAGINATION_TORN', 'a deployment named an unusable tracing project');
                            }
                            deployments.push({ id, projectId: project });
                        }
                    }
                }

                const seen = new Set<string>();
                let offset = 0;
                const url = (at: number) => `${origin}${paths.projects}?${projectsQuery(since, at)}`;
                const parse = (body: unknown) => {
                    if (!Array.isArray(body) || body.length > LANGSMITH_PAGE_SIZE) return null;
                    offset += body.length;
                    return { items: body, next: body.length === LANGSMITH_PAGE_SIZE ? url(offset) : null };
                };
                for await (const page of readPages(http, url(0), { origin, headers, parse })) {
                    for (const item of page as (LsProject | null)[]) {
                        rows += 1;
                        const id = item?.id;
                        if (item === null || !isPlainId(id)) throw new SourceReadError('PAGINATION_TORN', 'a project had no usable id');
                        if (seen.has(id)) throw new SourceReadError('PAGINATION_TORN', 'a project was listed twice');
                        seen.add(id);
                        // An experiment is an evaluation against a dataset, not a running agent.
                        if (item.reference_dataset_id !== undefined && item.reference_dataset_id !== null) continue;
                        const tools = toolUsageOf(item);
                        if (tools === null) {
                            throw new SourceReadError('PAGINATION_TORN', 'a project\'s stats did not account for its tool calls');
                        }
                        usage.set(id, tools);
                    }
                }
                return sourceResult('runtime', rows, observations(), null);
            } catch (err) {
                return sourceResult('runtime', rows, observations(), err);
            }
        },
    };
}
