/**
 * aws-posture provider — AWS cloud-posture compliance evidence.
 *
 * Engine: Powerpipe + the Apache-2.0 `steampipe-mod-aws-compliance` mod, invoked
 * as an EXTERNAL CLI (`powerpipe benchmark run <benchmark> --output json`). We do
 * NOT port the mod's HCL/SQL or its embedded framework mappings — we consume its
 * JSON and apply an ORIGINAL thin control map (see aws-posture-control-map.ts).
 * Apache-2.0 permits redistribution/use of the CLI; the mod is credited in NOTICE
 * + the implementation note.
 *
 * SECURITY (read-only credentials):
 *   - Credentials are READ-ONLY AWS creds (access key or assume-role + external
 *     id), passed to the CLI via ENVIRONMENT variables, NEVER via argv (argv is
 *     visible in process listings). See `buildCredentialEnv`.
 *   - `scrubAwsCredentials` strips key/secret/session-token/ARN patterns AND the
 *     connection's own secret values from any captured stdout/stderr before it is
 *     surfaced or persisted.
 *   - The secret is never echoed in logs, errors, or results.
 */
import { execFile } from 'node:child_process';
import type {
    ScheduledCheckProvider,
    ConnectionConfigSchema,
    ConnectionValidationResult,
    CheckInput,
    CheckResult,
    EvidencePayload,
} from './types';

// ─── Pure helpers (unit-tested directly) ─────────────────────────────

/**
 * Aggregate status of a single Powerpipe control across its result rows.
 *
 * `unknown` is not a Powerpipe status — it is ours, and it means "this control
 * object carried no signal we could read". It exists so an UNREADABLE control
 * is distinguishable from a genuinely skipped one. Collapsing the two is what
 * made issue #2301 dangerous: a benchmark whose controls had all errored
 * aggregated to `{ok:0, alarm:0, skip:N, error:0}`, and a run with no alarms
 * and no errors is a PASS.
 */
export type PowerpipeControlStatus = 'ok' | 'alarm' | 'skip' | 'error' | 'unknown';

export interface PowerpipeControlResult {
    controlId: string;
    title: string;
    status: PowerpipeControlStatus;
    reason: string;
}

/**
 * ── The wire shape, and where each key comes from ─────────────────────
 *
 * `powerpipe benchmark run <id> --output json` does NOT marshal the Go structs.
 * It renders them through a text/template at
 * `internal/controldisplay/templates/json/output.tmpl`, so THAT file — not the
 * struct tags — is the authority for the key names below. (The struct tags
 * still decide the shape of each `summary` value, because the template emits
 * those with `toPrettyJson`.)
 *
 *   root      the template applies its group sub-template to the execution
 *             tree's root ResultGroup, so the top-level object IS a group:
 *             `{ group_id, title, description, tags, summary, groups, controls }`.
 *             `groups` is `[]` and `controls` is `null` when empty.
 *
 *   GROUP     `summary` is a `controlexecute.GroupSummary`, declared
 *   summary   `Status StatusSummary \`json:"status"\`` — so a group's counters
 *             ARE nested one level: `{ "status": { ok, alarm, … } }`.
 *
 *   CONTROL   `summary` is a `controlstatus.StatusSummary` DIRECTLY
 *   summary   (control_run.go: `Summary *controlstatus.StatusSummary
 *             \`json:"summary"\``), and that struct is FLAT — five int
 *             counters, `{ alarm, ok, info, skip, error }`, with no
 *             intervening `status` key.
 *
 * The two differ, and reading a control's summary as if it were a group's was
 * the defect: `summary.status` is undefined against real output, so every
 * control silently fell through to a row scan.
 *
 *   control   `{ summary, results, control_id, description, severity, tags,
 *             title, run_status, run_error }`. `results` is rendered from
 *             `ControlRun.Rows` and is `null` — not `[]` — when the control
 *             produced no rows. `run_status` is the template's numeric map of
 *             `dashboardtypes.RunStatus` (4 = complete, 8 = error); `run_error`
 *             is `ControlRun.RunErrorString`.
 *
 *   row       `{ reason, resource, status, dimensions }`.
 *
 * An errored control is `setError`'d upstream, which does `Summary.Error++`,
 * fills RunErrorString and moves RunStatus to "error" — so it arrives as
 * `{ summary: { …, error: 1 }, results: null, run_status: 8, run_error: "…" }`
 * and never as a merely empty control.
 */

/** A control's flat counter block — `controlstatus.StatusSummary`. */
interface RawStatusCounts {
    alarm?: number;
    ok?: number;
    info?: number;
    skip?: number;
    error?: number;
}
const COUNT_KEYS: ReadonlyArray<keyof RawStatusCounts> = ['alarm', 'ok', 'info', 'skip', 'error'];

/** `dashboardtypes.RunStatus` "error", as the JSON template numbers it. */
const RUN_STATUS_ERROR = 8;

interface RawControlResult { status?: string; reason?: string; resource?: string }
interface RawControl {
    control_id?: string;
    name?: string;
    title?: string;
    results?: RawControlResult[] | null;
    summary?: RawStatusCounts | null;
    run_status?: number;
    run_error?: string;
}
interface RawGroup { groups?: RawGroup[] | null; controls?: RawControl[] | null }

/** Extract the short check name from a Powerpipe control id
 *  (`aws_compliance.control.iam_root_user_mfa_enabled` → `iam_root_user_mfa_enabled`). */
export function shortControlName(controlId: string): string {
    const marker = '.control.';
    const i = controlId.indexOf(marker);
    if (i >= 0) return controlId.slice(i + marker.length);
    const parts = controlId.split('.');
    return parts[parts.length - 1] || controlId;
}

/** True when the value is a counter block — at least one countable key present. */
function isCountBlock(s: RawControl['summary']): s is RawStatusCounts {
    if (!s || typeof s !== 'object') return false;
    const rec = s as Record<string, unknown>;
    return COUNT_KEYS.some((k) => typeof rec[k] === 'number' && Number.isFinite(rec[k] as number));
}

/** One counter, treating a non-number or a negative as zero. */
function counter(s: RawStatusCounts, key: keyof RawStatusCounts): number {
    const v = s[key];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Status from the control's flat counters, or `null` for "said nothing".
 *
 * A GROUP-shaped `{ status: { … } }` reaches this with no countable key at the
 * top level, so it yields `null` and the control ends up `unknown` — LOUD, not
 * silently benign. That is deliberate: it is the shape this parser used to
 * expect, and if a future Powerpipe moved to it we want a failed check rather
 * than a rediscovery of #2301.
 */
function statusFromCounts(s: RawControl['summary']): PowerpipeControlStatus | null {
    if (!isCountBlock(s)) return null;
    if (counter(s, 'alarm') > 0) return 'alarm';
    if (counter(s, 'error') > 0) return 'error';
    // `StatusSummary.PassedCount()` upstream is Ok + Info — `info` passes.
    if (counter(s, 'ok') + counter(s, 'info') > 0) return 'ok';
    if (counter(s, 'skip') > 0) return 'skip';
    return null; // every counter zero — no observation either way
}

/** Status from the control's rows, or `null` when the rows say nothing. */
function statusFromRows(rows: RawControl['results']): PowerpipeControlStatus | null {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const has = (want: string) => rows.some((r) => r && r.status === want);
    if (has('alarm')) return 'alarm';
    if (has('error')) return 'error';
    if (has('ok') || has('info')) return 'ok';
    if (has('skip')) return 'skip';
    return null; // rows carrying only statuses we do not recognise
}

/** An errored ControlRun: `run_error` filled, RunStatus moved to "error". */
function hasRunError(c: RawControl): boolean {
    return (
        (typeof c.run_error === 'string' && c.run_error.trim().length > 0) ||
        c.run_status === RUN_STATUS_ERROR
    );
}

function aggregateStatus(c: RawControl): PowerpipeControlStatus {
    const fromCounts = statusFromCounts(c.summary);
    if (fromCounts) return fromCounts;

    const fromRows = statusFromRows(c.results);
    if (fromRows) return fromRows;

    if (hasRunError(c)) return 'error';

    // A well-formed counter block that is all zeroes is a control that ran and
    // matched no resources — an empty population, which IS a genuine skip.
    // Reaching here WITHOUT one means nothing in the object was legible.
    return isCountBlock(c.summary) ? 'skip' : 'unknown';
}

/** The row reason to surface, falling back to the run error for a broken control. */
function reasonFor(c: RawControl, status: PowerpipeControlStatus): string {
    const rows = Array.isArray(c.results) ? c.results : [];
    const matches = (r: RawControlResult) =>
        status === 'ok' ? r.status === 'ok' || r.status === 'info' : r.status === status;
    const rowReason = rows.find((r) => r && matches(r))?.reason;
    if (rowReason) return rowReason;
    // An errored control has no rows at all; its message is the run error.
    if (status === 'error' && typeof c.run_error === 'string') return c.run_error;
    return '';
}

/**
 * Parse `powerpipe benchmark run --output json` into a flat per-control list.
 * Walks the nested group tree. PURE — no I/O.
 */
export function parsePowerpipeBenchmarkJson(raw: unknown): PowerpipeControlResult[] {
    const out: PowerpipeControlResult[] = [];
    const seen = new Set<string>();
    const walk = (node: RawGroup | undefined | null): void => {
        if (!node || typeof node !== 'object') return;
        const controls = Array.isArray(node.controls) ? node.controls : [];
        for (const c of controls) {
            if (!c || typeof c !== 'object') continue;
            const id = c.control_id ?? c.name;
            if (!id) continue;
            const shortId = shortControlName(id);
            if (seen.has(shortId)) continue;
            seen.add(shortId);
            const status = aggregateStatus(c);
            out.push({ controlId: shortId, title: c.title ?? shortId, status, reason: reasonFor(c, status) });
        }
        const groups = Array.isArray(node.groups) ? node.groups : [];
        for (const g of groups) walk(g);
    };
    // The root object is itself a group, so the walk starts there.
    walk(raw as RawGroup);
    return out;
}

const AWS_CREDENTIAL_PATTERNS: RegExp[] = [
    /AKIA[0-9A-Z]{16}/g,            // long-term access key id
    /ASIA[0-9A-Z]{16}/g,            // temporary access key id
    /\b[A-Za-z0-9/+=]{40}\b/g,      // secret access key (40-char)
    /(aws_session_token|AWS_SESSION_TOKEN)["'\s:=]+[A-Za-z0-9/+=]{20,}/gi,
    /arn:aws[a-z-]*:iam::\d{12}:[A-Za-z0-9/_+=,.@-]+/g, // role/user ARNs (account id)
];

/**
 * Redact AWS credential material from text before it is logged/persisted.
 * Also redacts the exact secret values from this connection when provided.
 */
export function scrubAwsCredentials(text: string, secretValues: string[] = []): string {
    let out = text ?? '';
    for (const secret of secretValues) {
        if (secret && secret.length >= 8) {
            out = out.split(secret).join('[REDACTED]');
        }
    }
    for (const re of AWS_CREDENTIAL_PATTERNS) out = out.replace(re, '[REDACTED]');
    return out;
}

export interface BenchmarkSummary {
    benchmark: string;
    counts: { ok: number; alarm: number; skip: number; error: number; unknown: number; total: number };
    controls: Array<{ id: string; status: PowerpipeControlStatus }>;
    truncated: boolean;
}

/** Hard cap on the serialized resultJson (no raw resource dumps). */
export const RESULT_JSON_MAX_BYTES = 32 * 1024;

/**
 * Build a BOUNDED result summary: counts + a per-control status array only (no
 * resources, no reasons), truncating the per-control list if the serialized
 * payload would exceed RESULT_JSON_MAX_BYTES.
 */
export function summariseBenchmark(
    benchmark: string,
    controls: PowerpipeControlResult[],
): BenchmarkSummary {
    const counts = { ok: 0, alarm: 0, skip: 0, error: 0, unknown: 0, total: controls.length };
    for (const c of controls) counts[c.status] += 1;
    let list = controls.map((c) => ({ id: c.controlId, status: c.status }));
    let truncated = false;
    // Trim the per-control list until it fits the cap.
    while (list.length > 0 && Buffer.byteLength(JSON.stringify({ benchmark, counts, controls: list })) > RESULT_JSON_MAX_BYTES) {
        list = list.slice(0, Math.floor(list.length * 0.9));
        truncated = true;
    }
    return { benchmark, counts, controls: list, truncated };
}

// ─── CLI invocation ──────────────────────────────────────────────────

export interface AwsPostureSecrets {
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    roleArn?: string;
    externalId?: string;
}
export interface AwsPostureConfig {
    benchmark?: string; // e.g. 'aws_compliance.benchmark.soc_2'
    region?: string;
    accountId?: string;
}

/** Env for the CLI child — creds via env, NEVER argv. */
export function buildCredentialEnv(secrets: AwsPostureSecrets, config: AwsPostureConfig): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (secrets.accessKeyId) env.AWS_ACCESS_KEY_ID = secrets.accessKeyId;
    if (secrets.secretAccessKey) env.AWS_SECRET_ACCESS_KEY = secrets.secretAccessKey;
    if (secrets.sessionToken) env.AWS_SESSION_TOKEN = secrets.sessionToken;
    if (config.region) env.AWS_REGION = config.region;
    // Assume-role config travels via env too (a Steampipe aws connection or an
    // AWS_ROLE_ARN/AWS_EXTERNAL_ID the wrapper reads) — never on the command line.
    if (secrets.roleArn) env.AWS_ROLE_ARN = secrets.roleArn;
    if (secrets.externalId) env.AWS_EXTERNAL_ID = secrets.externalId;
    return env;
}

function secretValues(s: AwsPostureSecrets): string[] {
    return [s.accessKeyId, s.secretAccessKey, s.sessionToken, s.externalId].filter((v): v is string => !!v);
}

function runCli(
    file: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    secrets: AwsPostureSecrets,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null; missing: boolean }> {
    const redact = secretValues(secrets);
    return new Promise((resolve) => {
        execFile(file, args, { env, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 }, (err, stdout, stderr) => {
            const so = scrubAwsCredentials(String(stdout ?? ''), redact);
            const se = scrubAwsCredentials(String(stderr ?? ''), redact);
            if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
                resolve({ ok: false, stdout: so, stderr: se, code: null, missing: true });
                return;
            }
            resolve({ ok: !err, stdout: so, stderr: se, code: err ? ((err as { code?: number }).code ?? 1) : 0, missing: false });
        });
    });
}

// ─── Provider ────────────────────────────────────────────────────────

export class AwsPostureProvider implements ScheduledCheckProvider {
    readonly id = 'aws-posture';
    readonly displayName = 'AWS Cloud Posture';
    readonly description =
        'AWS configuration-compliance evidence via the Powerpipe steampipe-mod-aws-compliance benchmark (read-only).';
    readonly supportedChecks = ['soc2', 'cis'];
    // P2 — validateConnection shells `aws sts get-caller-identity` (real probe).
    readonly liveValidation = true;
    readonly setupGuide =
        'Runs Powerpipe + the AWS CLI on the collector host — both must be installed there, with `aws configure` set to a read-only role. Pick the benchmark (SOC 2 or CIS) to select which Powerpipe checks run. Test connection performs a live `aws sts get-caller-identity`.';

    readonly configSchema: ConnectionConfigSchema = {
        configFields: [
            { key: 'benchmark', label: 'Benchmark', type: 'select', required: true, options: ['soc2', 'cis'], description: 'Powerpipe benchmark to run' },
            { key: 'region', label: 'Primary AWS region', type: 'string', required: false, placeholder: 'eu-west-1' },
            { key: 'accountId', label: 'AWS account id', type: 'string', required: false, placeholder: '123456789012' },
        ],
        secretFields: [
            { key: 'roleArn', label: 'Read-only role ARN', type: 'string', required: false, placeholder: 'arn:aws:iam::…:role/InflectPostureReadOnly', description: 'Preferred: an assume-role ARN with a read-only policy' },
            { key: 'externalId', label: 'External ID', type: 'string', required: false, description: 'External id for the assume-role trust policy' },
            { key: 'accessKeyId', label: 'Access key id', type: 'string', required: false, description: 'Alternative to role: a read-only access key' },
            { key: 'secretAccessKey', label: 'Secret access key', type: 'string', required: false },
            { key: 'sessionToken', label: 'Session token', type: 'string', required: false },
        ],
    };

    /** Map the configJson `benchmark` shorthand to the Powerpipe benchmark id. */
    static benchmarkId(shorthand: string | undefined): string {
        switch ((shorthand ?? 'soc2').toLowerCase()) {
            case 'cis': return 'aws_compliance.benchmark.cis_v300';
            case 'soc2':
            default: return 'aws_compliance.benchmark.soc_2';
        }
    }

    async validateConnection(
        config: Record<string, unknown>,
        secrets: Record<string, unknown>,
    ): Promise<ConnectionValidationResult> {
        const s = secrets as AwsPostureSecrets;
        if (!s.roleArn && !(s.accessKeyId && s.secretAccessKey)) {
            return { valid: false, error: 'Provide a read-only role ARN or an access-key pair.' };
        }
        const env = buildCredentialEnv(s, config as AwsPostureConfig);
        // Cheap read-only identity check. `aws` CLI absence is not a hard fail at
        // config time — surface a soft warning so the connection can still save.
        const res = await runCli('aws', ['sts', 'get-caller-identity', '--output', 'json'], env, s);
        if (res.missing) {
            return { valid: false, error: 'AWS CLI not available on the collector host — install aws-cli + powerpipe (see docs/aws-posture-connector.md).' };
        }
        if (!res.ok) {
            return { valid: false, error: `AWS credential check failed: ${res.stderr.slice(0, 300) || 'sts:GetCallerIdentity denied'}` };
        }
        return { valid: true };
    }

    async runCheck(input: CheckInput): Promise<CheckResult> {
        const start = Date.now();
        const cfg = input.connectionConfig as AwsPostureConfig & AwsPostureSecrets;
        const secrets: AwsPostureSecrets = {
            accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey,
            sessionToken: cfg.sessionToken, roleArn: cfg.roleArn, externalId: cfg.externalId,
        };
        const benchmark = AwsPostureProvider.benchmarkId(cfg.benchmark ?? input.parsed.checkType);
        const env = buildCredentialEnv(secrets, cfg);
        const res = await runCli('powerpipe', ['benchmark', 'run', benchmark, '--output', 'json'], env, secrets);
        if (res.missing) {
            return { status: 'ERROR', summary: 'Powerpipe CLI not installed on the collector host.', details: { benchmark }, durationMs: Date.now() - start, errorMessage: 'powerpipe not installed — see docs/aws-posture-connector.md' };
        }
        // H2 — fail CLOSED on a non-zero collector exit (revoked credential /
        // network error) rather than parsing empty stdout into a false PASS.
        if (!res.ok) {
            return { status: 'ERROR', summary: 'Powerpipe collector exited non-zero.', details: { benchmark }, durationMs: Date.now() - start, errorMessage: `collector error; stderr: ${res.stderr.slice(0, 300)}` };
        }
        let controls: PowerpipeControlResult[] = [];
        try {
            controls = parsePowerpipeBenchmarkJson(JSON.parse(res.stdout || '{}'));
        } catch {
            return { status: 'ERROR', summary: 'Failed to parse Powerpipe JSON output.', details: { benchmark }, durationMs: Date.now() - start, errorMessage: `parse error; stderr: ${res.stderr.slice(0, 300)}` };
        }
        const summary = summariseBenchmark(benchmark, controls);
        // H2 — zero parsed controls is insufficient data, not a pass.
        if (summary.counts.total === 0) {
            return { status: 'ERROR', summary: `${benchmark}: no controls parsed (insufficient data).`, details: summary as unknown as Record<string, unknown>, durationMs: Date.now() - start, errorMessage: 'collector returned zero controls' };
        }
        // An illegible control is not a passing one: `unknown` joins `error` in
        // the ERROR arm so a run we could not read never reports compliant.
        const status: CheckResult['status'] =
            summary.counts.alarm > 0 ? 'FAILED'
            : summary.counts.error > 0 || summary.counts.unknown > 0 ? 'ERROR'
            : 'PASSED';
        return {
            status,
            summary: `${benchmark}: ${summary.counts.ok} ok / ${summary.counts.alarm} alarm / ${summary.counts.error} error / ${summary.counts.skip} skip / ${summary.counts.unknown} unknown of ${summary.counts.total}`,
            details: summary as unknown as Record<string, unknown>,
            durationMs: Date.now() - start,
        };
    }

    mapResultToEvidence(input: CheckInput, result: CheckResult): EvidencePayload | null {
        // H2 — no evidence for a broken run (ERROR) or an empty population
        // (NOT_APPLICABLE); passing evidence must reflect a real observation.
        if (result.status === 'ERROR' || result.status === 'NOT_APPLICABLE') return null;
        return {
            title: `AWS posture — ${input.parsed.checkType}`,
            content: result.summary,
            type: 'CONFIGURATION',
            category: `aws-posture:${input.parsed.checkType}`,
        };
    }
}
