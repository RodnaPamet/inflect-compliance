/**
 * THE GITHUB ACTIONS SOURCE — `cicd` (#3784, owner decision 2026-10-19).
 *
 * A CI/CD pipeline is an agent-shaped principal: it runs unattended, it holds
 * credentials, and the credentials it holds reach production. Decision 10 put
 * GitHub Actions in the pilot with three such identities — the per-run
 * `GITHUB_TOKEN`, a GitHub App minted from a private key held as a secret, and
 * a model API key held as a secret — and this reads all three kinds, for every
 * configured repository, from what the repository itself declares:
 *
 *   • THE WORKFLOW FILES on the default branch, `.github/workflows/*.y{a,}ml`.
 *     Each one that holds a secret, or whose run token may write, or that
 *     reaches secrets in a way no file can be read for, is a principal. A
 *     read-only workflow that holds no secret is a row, not a principal: it can
 *     change nothing and carries nothing worth stealing.
 *   • THE REPOSITORY'S ACTIONS SECRETS, by name and `updated_at`. Never a value:
 *     GitHub's API has no read of one, and the token holds `Secrets: read`,
 *     which lists names. A secret no workflow references is reported unbound,
 *     so the ingest can raise ORPHAN_CREDENTIAL — but only when every file was
 *     read and none reaches secrets dynamically, because "referenced by no file
 *     I read" is evidence only when there is no file the reader could not read.
 *
 * WHAT COUNTS AS A REFERENCE. Only an expression: the inside of a `${{ … }}`
 * span, or the whole of an `if:` value (GitHub reads those as expressions
 * without the braces). A script that merely mentions `secrets.FOO` in its text
 * holds nothing, and is not credited with it. Property access is
 * case-insensitive in GitHub's expression language, and secret names are stored
 * upper-case, so references are compared upper-case.
 *
 * DYNAMIC ACCESS cannot be read for: a computed index (`secrets[matrix.key]`),
 * the whole context (`toJSON(secrets)`), or `secrets: inherit` on a call to a
 * workflow in ANOTHER repository, which hands that repository every secret
 * this one holds. Such a workflow is a principal whatever else it holds, its
 * `H2.credential_bound` is evidenced false, and no secret of the repository is
 * reported unbound. `secrets: inherit` on a call to a workflow in THIS
 * repository hides nothing: the callee's own file is read, and it is credited
 * with what it references.
 *
 * THE RUN TOKEN. Each job's `GITHUB_TOKEN` takes the job's `permissions:`, else
 * the workflow's, else the repository's default — which this reader does not
 * read (it would need Administration: read) and so never assumes is read-only.
 * A job whose scope is that default may write.
 *
 * READ-ONLY, by the wire (`ReadOnlyHttp` has one verb, GET) and by the token,
 * which holds Contents: read and Secrets: read and nothing else. The host is
 * fixed by kind; there is nothing in the configuration to type a host into.
 *
 * NOT READ here, and named so its absence is not mistaken for coverage:
 * organisation and environment secrets (a reference to one is reported, with
 * its age unknown), CODEOWNERS (so a principal's owner is null and the ingest
 * reads it as unowned), and GitHub Enterprise Server.
 */
import * as yaml from 'js-yaml';

import { MAX_AGENTS, MAX_CREDENTIALS_PER_AGENT, MAX_EVIDENCE_CHARS } from '@/lib/agentic/harness-contract';
import type { CriterionVerdict } from '@/lib/agentic/harness-ladder';

import { nextLinkFrom } from '../http';
import {
    ageInDays,
    readPages,
    sourceResult,
    SourceReadError,
    type HarnessSource,
    type Observation,
    type ObservedCredential,
    type SourceContext,
    type SourceRead,
} from '../source';

/** The one host this source sends its token to. */
export const GITHUB_API_ORIGIN = 'https://api.github.com';

/**
 * The endpoints this source may call, as templates: `{name}` is one path
 * segment. `scanner-surface.ts` declares them for the manifest hash, and the
 * tests hold every request to them.
 */
export const GITHUB_READ_PATHS = [
    '/repos/{owner}/{repo}',
    '/repos/{owner}/{repo}/contents/.github/workflows',
    '/repos/{owner}/{repo}/contents/.github/workflows/{file}',
    '/repos/{owner}/{repo}/actions/secrets',
] as const;

/** `owner/repo` as GitHub allows each half. */
export const GITHUB_REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

/** One workflow file, decoded. GitHub runs far smaller; a larger one is not read whole. */
export const MAX_WORKFLOW_BYTES = 512 * 1024;
/** GitHub's contents API lists at most this many entries of a directory, silently. */
export const GITHUB_DIRECTORY_LISTING_CAP = 1_000;
/** Alias nodes per workflow. GitHub accepts anchors; a file that needs more is not a workflow. */
export const MAX_WORKFLOW_ALIASES = 1_000;
/** Nesting levels per workflow, js-yaml's own default, stated so it cannot move under the reader. */
export const MAX_WORKFLOW_DEPTH = 100;

/** The token every job receives. Referenced as `secrets.GITHUB_TOKEN`, and not a repository secret. */
const RUN_TOKEN = 'GITHUB_TOKEN';

export interface GitHubActionsSourceOptions {
    /** `owner/repo`, each matching `GITHUB_REPOSITORY`. */
    readonly repositories: readonly string[];
    /** A fine-grained token holding Contents: read and Secrets: read, resolved by the caller. */
    readonly token: string;
}

type Access = 'read' | 'write' | 'none';

/** A token scope as a workflow declares it, or its absence. */
export type TokenScope =
    | { readonly kind: 'map'; readonly scopes: Readonly<Record<string, Access>> }
    | { readonly kind: 'read-all' }
    | { readonly kind: 'write-all' }
    | { readonly kind: 'repository-default' };

/** What one workflow file says about the credentials it holds. Pure: no request. */
export interface WorkflowAnalysis {
    /** Secret names it references, upper-case, `GITHUB_TOKEN` excluded. */
    readonly secrets: readonly string[];
    /** Whether it reaches secrets in a way the file cannot be read for. */
    readonly dynamicSecrets: boolean;
    /** Each job's effective token scope, by job id, in file order. */
    readonly jobs: readonly { readonly id: string; readonly scope: TokenScope }[];
}

export class UnparseableWorkflow extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnparseableWorkflow';
    }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const ACCESS: ReadonlySet<string> = new Set(['read', 'write', 'none']);

function scopeOf(value: unknown, where: string): TokenScope {
    if (value === 'read-all') return { kind: 'read-all' };
    if (value === 'write-all') return { kind: 'write-all' };
    if (isRecord(value)) {
        const scopes: Record<string, Access> = {};
        for (const [scope, access] of Object.entries(value)) {
            if (typeof access !== 'string' || !ACCESS.has(access)) {
                throw new UnparseableWorkflow(`${where}: a permission that is not read, write or none`);
            }
            scopes[scope] = access as Access;
        }
        return { kind: 'map', scopes };
    }
    throw new UnparseableWorkflow(`${where}: a permissions value that is not a map, read-all or write-all`);
}

/** Strip GitHub expression string literals (`'…'`, with `''` as the escape) so their text is not read as code. */
function withoutStringLiterals(expr: string): string {
    return expr.replace(/'(?:[^']|'')*'/g, "''");
}

/**
 * The secrets one expression references, and whether it reaches the context
 * dynamically. Indexing by a literal is a reference; any other appearance of
 * the bare `secrets` context — a computed index, `toJSON(secrets)` — is dynamic.
 * A property NAMED `secrets` of some other object (`inputs.secrets`) is neither.
 */
export function secretsInExpression(expr: string): { readonly names: readonly string[]; readonly dynamic: boolean } {
    const names: string[] = [];
    const literalIndex = /(?<![\w.-])secrets\s*\[\s*'((?:[^']|'')*)'\s*\]/gi;
    let rest = expr.replace(literalIndex, (_m, name: string) => {
        names.push(name.replace(/''/g, "'"));
        return ' ';
    });
    rest = withoutStringLiterals(rest);
    rest = rest.replace(/(?<![\w.-])secrets\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/gi, (_m, name: string) => {
        names.push(name);
        return ' ';
    });
    return { names: names.map((n) => n.toUpperCase()), dynamic: /(?<![\w.-])secrets\b/i.test(rest) };
}

/** Every expression a string carries: its `${{ … }}` spans, or the whole of an `if:` value. */
function expressionsIn(value: string, isCondition: boolean): string[] {
    const spans = [...value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]);
    if (spans.length > 0 || !isCondition) return spans;
    return [value];
}

/**
 * Analyse one workflow file. Throws `UnparseableWorkflow` for anything the
 * reader cannot resolve — not YAML, not a workflow, a permissions value it does
 * not know — rather than reading a part of it and calling that the whole.
 */
export function analyseWorkflow(text: string): WorkflowAnalysis {
    let doc: unknown;
    try {
        doc = yaml.load(text, { maxAliases: MAX_WORKFLOW_ALIASES, maxDepth: MAX_WORKFLOW_DEPTH });
    } catch {
        throw new UnparseableWorkflow('not a single YAML document the reader can load');
    }
    if (!isRecord(doc) || !isRecord(doc.jobs) || Object.keys(doc.jobs).length === 0) {
        throw new UnparseableWorkflow('not a workflow: no jobs mapping');
    }

    const secrets = new Set<string>();
    let dynamic = false;
    const seen = new Set<unknown>();
    const visit = (node: unknown, key: string | null): void => {
        if (typeof node === 'string') {
            for (const expr of expressionsIn(node, key === 'if')) {
                const found = secretsInExpression(expr);
                for (const n of found.names) if (n !== RUN_TOKEN) secrets.add(n);
                dynamic ||= found.dynamic;
            }
            return;
        }
        // An alias is the same object reached twice: read it once.
        if (node === null || typeof node !== 'object' || seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node)) {
            for (const item of node) visit(item, null);
            return;
        }
        for (const [k, v] of Object.entries(node)) visit(v, k);
    };
    visit(doc, null);

    const top = doc.permissions === undefined ? null : scopeOf(doc.permissions, 'permissions');
    const jobs = Object.entries(doc.jobs).map(([id, job]) => {
        if (!isRecord(job)) throw new UnparseableWorkflow(`jobs.${id}: not a mapping`);
        // Every secret, handed to a workflow in another repository.
        if (job.secrets === 'inherit' && !(typeof job.uses === 'string' && job.uses.startsWith('./'))) dynamic = true;
        const own = job.permissions === undefined ? null : scopeOf(job.permissions, `jobs.${id}.permissions`);
        return { id, scope: own ?? top ?? ({ kind: 'repository-default' } as const) };
    });

    return { secrets: [...secrets].sort(), dynamicSecrets: dynamic, jobs };
}

/** Whether a scope may write anything. The repository default is never assumed read-only. */
function mayWrite(scope: TokenScope): boolean {
    if (scope.kind === 'map') return Object.values(scope.scopes).includes('write');
    return scope.kind !== 'read-all';
}

/** Whether a scope may mint an OIDC token, the identity a workflow federates into a cloud with. */
function mayMintOidc(scope: TokenScope): boolean {
    return scope.kind === 'write-all' || (scope.kind === 'map' && scope.scopes['id-token'] === 'write');
}

interface RepoSecret {
    readonly name: string;
    readonly updatedAt: Date | null;
}

function dateOrNull(v: unknown): Date | null {
    if (typeof v !== 'string') return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;
const WORKFLOW_FILE = /\.ya?ml$/i;

/** A file name as it may stand inside an id or a locator: encoded, so it carries no whitespace or slash. */
function encodedName(name: string): string {
    return encodeURIComponent(name);
}

function evidence(at: string, anchor: string): string {
    return `${at}#${anchor}`.slice(0, MAX_EVIDENCE_CHARS);
}

/**
 * The principal one workflow is, or null when it is a row only: it holds no
 * secret, reaches none dynamically, and no job's token may write.
 */
export function workflowObservation(
    repo: string,
    fileName: string,
    analysis: WorkflowAnalysis,
    repoSecrets: ReadonlyMap<string, RepoSecret>,
    asOf: Date,
): Observation | null {
    const writes = analysis.jobs.some((j) => mayWrite(j.scope));
    if (analysis.secrets.length === 0 && !analysis.dynamicSecrets && !writes) return null;

    const file = `.github/workflows/${encodedName(fileName)}`;
    const at = `github-actions:${repo}/${file}`;
    const credentials: ObservedCredential[] = [
        // Minted for each job and expiring with it: bound to the run, and bounded by no person.
        { ref: `github-token://github.com/${repo}/${file}`, ageDays: 0, expires: true, boundToAgent: true, grant: 'app-only' },
    ];
    if (analysis.jobs.some((j) => mayMintOidc(j.scope))) {
        credentials.push({ ref: `github-oidc://github.com/${repo}/${file}`, ageDays: 0, expires: true, boundToAgent: true, grant: 'app-only' });
    }
    for (const name of analysis.secrets) {
        const listed = repoSecrets.get(name);
        credentials.push({
            ref: `github-secret://github.com/${repo}/${name}`,
            // Age since it was last set: what a rotation resets. Unknown for a
            // secret this repository's listing does not hold (an organisation's
            // or an environment's).
            ageDays: listed ? ageInDays(listed.updatedAt, asOf) : null,
            expires: null,
            // Every workflow in the repository can read a repository secret: it
            // is the repository's, not this workflow's.
            boundToAgent: false,
            grant: 'unknown',
        });
    }
    if (credentials.length > MAX_CREDENTIALS_PER_AGENT) {
        throw new SourceReadError('BYTE_CAP', 'a workflow held more credentials than one agent may carry');
    }

    const verdicts: CriterionVerdict[] = [];
    if (analysis.secrets.length > 0 || analysis.dynamicSecrets) {
        verdicts.push({
            criterion: 'H2.credential_bound',
            met: false,
            evidence: evidence(at, analysis.secrets.length > 0 ? `secrets.${analysis.secrets[0]}` : 'secrets'),
        });
    } else {
        // Its only credentials are the run's own, minted for this workflow.
        verdicts.push(
            { criterion: 'H2.credential_bound', met: true, evidence: evidence(at, RUN_TOKEN) },
            { criterion: 'H2.grant_kind_declared', met: true, evidence: evidence(at, RUN_TOKEN) },
        );
    }
    const unlisted = analysis.jobs.find((j) => j.scope.kind !== 'map');
    verdicts.push(
        unlisted === undefined
            ? { criterion: 'H2.tools_allowlisted', met: true, evidence: evidence(at, 'permissions') }
            : { criterion: 'H2.tools_allowlisted', met: false, evidence: evidence(at, `jobs.${unlisted.id}.permissions`) },
    );

    return { discoveredId: `github:workflow:${repo}/${encodedName(fileName)}`, owner: null, credentials, verdicts };
}

interface ContentsEntry {
    type?: unknown;
    name?: unknown;
}

interface ContentsFile {
    type?: unknown;
    encoding?: unknown;
    content?: unknown;
}

/**
 * The secrets listing's pages, `{ total_count, secrets }` with the next link in
 * the `Link` header, and the count every page declared. A count that changes
 * between pages is a listing that changed under the read.
 */
function secretsListing(): {
    readonly parse: (body: unknown, headers: Headers) => { items: readonly unknown[]; next: string | null } | null;
    readonly total: () => number | null;
} {
    let total: number | null = null;
    return {
        parse(body, headers) {
            if (!isRecord(body) || !Array.isArray(body.secrets) || typeof body.total_count !== 'number') return null;
            if (total !== null && total !== body.total_count) {
                throw new SourceReadError('PAGINATION_TORN', 'the secret count changed while it was read');
            }
            total = body.total_count;
            return { items: body.secrets, next: nextLinkFrom(headers.get('link')) };
        },
        total: () => total,
    };
}

export function githubActionsSource(opts: GitHubActionsSourceOptions): HarnessSource {
    const headers = {
        Authorization: `Bearer ${opts.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'inflect-agent-harness-scanner',
    };
    const origin = GITHUB_API_ORIGIN;

    return {
        kind: 'cicd',
        product: 'github-actions',
        async read(ctx: SourceContext): Promise<SourceRead> {
            const observations: Observation[] = [];
            const unbound: string[] = [];
            let rows = 0;
            let unparseable = false;

            try {
                for (const repo of opts.repositories) {
                    if (!GITHUB_REPOSITORY.test(repo)) throw new SourceReadError('UNPARSEABLE', 'a repository that is not owner/repo');
                    const base = `${origin}/repos/${repo}`;

                    // Readable at all? GitHub answers a repository the token cannot
                    // see with 404, which is UNREACHABLE here — never zero workflows.
                    const { body: meta } = await ctx.http.getJson(base, { origin, headers });
                    if (!isRecord(meta) || typeof meta.full_name !== 'string') {
                        throw new SourceReadError('PAGINATION_TORN', 'the repository was not the shape GitHub answers');
                    }

                    // The workflow directory on the default branch. Absent is zero
                    // workflows; the repository answered above, so it is not a token
                    // that cannot see it.
                    const dir = await ctx.http.getJson(`${base}/contents/.github/workflows`, { origin, headers, absentOk: true });
                    let files: string[] = [];
                    if (!dir.absent) {
                        if (!Array.isArray(dir.body)) throw new SourceReadError('PAGINATION_TORN', 'the workflow directory was not a listing');
                        if (dir.body.length >= GITHUB_DIRECTORY_LISTING_CAP) {
                            throw new SourceReadError('BYTE_CAP', 'the workflow directory reached the listing cap, so it may be truncated');
                        }
                        files = (dir.body as ContentsEntry[])
                            .filter((e) => e?.type === 'file' && typeof e.name === 'string' && WORKFLOW_FILE.test(e.name))
                            .map((e) => e.name as string)
                            .sort();
                    }

                    const analyses: { name: string; analysis: WorkflowAnalysis }[] = [];
                    let repoParsed = true;
                    for (const name of files) {
                        rows += 1;
                        const { body } = await ctx.http.getJson(`${base}/contents/.github/workflows/${encodedName(name)}`, { origin, headers });
                        const file = body as ContentsFile | null;
                        if (!isRecord(file) || file.type !== 'file') throw new SourceReadError('PAGINATION_TORN', 'a workflow was not a file');
                        // GitHub serves a file over 1 MB with no content: too large to read whole.
                        if (file.encoding !== 'base64' || typeof file.content !== 'string') {
                            throw new SourceReadError('BYTE_CAP', 'a workflow file too large to be served whole');
                        }
                        const bytes = Buffer.from(file.content, 'base64');
                        if (bytes.byteLength > MAX_WORKFLOW_BYTES) throw new SourceReadError('BYTE_CAP', 'a workflow file over the cap');
                        try {
                            analyses.push({ name, analysis: analyseWorkflow(bytes.toString('utf8')) });
                        } catch (err) {
                            if (!(err instanceof UnparseableWorkflow)) throw err;
                            unparseable = true;
                            repoParsed = false;
                        }
                    }

                    const repoSecrets = new Map<string, RepoSecret>();
                    const listing = secretsListing();
                    for await (const page of readPages(ctx.http, `${base}/actions/secrets?per_page=100`, { origin, headers, parse: listing.parse })) {
                        for (const item of page) {
                            rows += 1;
                            const name = isRecord(item) && typeof item.name === 'string' && SECRET_NAME.test(item.name) ? item.name.toUpperCase() : null;
                            if (name === null || repoSecrets.has(name)) throw new SourceReadError('PAGINATION_TORN', 'a secret had no usable name, or one seen twice');
                            repoSecrets.set(name, { name, updatedAt: dateOrNull((item as { updated_at?: unknown }).updated_at) });
                        }
                    }
                    // Every secret the listing counted, read: a short listing is
                    // one whose missing secrets would read as unreferenced.
                    if (listing.total() !== repoSecrets.size) {
                        throw new SourceReadError('PAGINATION_TORN', 'the secret listing held a different number of secrets than it counted');
                    }

                    for (const { name, analysis } of analyses) {
                        const o = workflowObservation(repo, name, analysis, repoSecrets, ctx.asOf);
                        if (o === null) continue;
                        if (observations.length >= MAX_AGENTS) throw new SourceReadError('BYTE_CAP', 'more principals than one report may carry');
                        observations.push(o);
                    }

                    // Unbound only on positive evidence: every file read and
                    // parsed, and none reaching secrets the reader cannot see.
                    if (repoParsed && !analyses.some((a) => a.analysis.dynamicSecrets)) {
                        const referenced = new Set(analyses.flatMap((a) => a.analysis.secrets));
                        for (const name of [...repoSecrets.keys()].sort()) {
                            if (!referenced.has(name)) unbound.push(`github-secret://github.com/${repo}/${name}`);
                        }
                    }
                }
                const result = sourceResult('cicd', rows, observations, unparseable ? new SourceReadError('UNPARSEABLE', 'a workflow file could not be resolved') : null);
                return { ...result, unboundCredentials: unbound };
            } catch (err) {
                return { ...sourceResult('cicd', rows, observations, err), unboundCredentials: unbound };
            }
        },
    };
}
