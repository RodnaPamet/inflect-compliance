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
import { throwIfPostureCredentialFailure } from './posture-credential-classification';

// ─── Pure helpers (unit-tested directly) ─────────────────────────────

/** Aggregate status of a single Powerpipe control across its result rows. */
export type PowerpipeControlStatus = 'ok' | 'alarm' | 'skip' | 'error';

export interface PowerpipeControlResult {
    controlId: string;
    title: string;
    status: PowerpipeControlStatus;
    reason: string;
}

interface RawControlResult { status?: string; reason?: string; resource?: string }
interface RawControl {
    control_id?: string;
    name?: string;
    title?: string;
    results?: RawControlResult[];
    summary?: { status?: Record<string, number> };
}
interface RawGroup { groups?: RawGroup[]; controls?: RawControl[] }

/** Extract the short check name from a Powerpipe control id
 *  (`aws_compliance.control.iam_root_user_mfa_enabled` → `iam_root_user_mfa_enabled`). */
export function shortControlName(controlId: string): string {
    const marker = '.control.';
    const i = controlId.indexOf(marker);
    if (i >= 0) return controlId.slice(i + marker.length);
    const parts = controlId.split('.');
    return parts[parts.length - 1] || controlId;
}

function aggregateStatus(c: RawControl): PowerpipeControlStatus {
    const s = c.summary?.status;
    if (s) {
        if ((s.alarm ?? 0) > 0) return 'alarm';
        if ((s.error ?? 0) > 0) return 'error';
        if ((s.ok ?? 0) > 0) return 'ok';
        return 'skip';
    }
    const rows = c.results ?? [];
    if (rows.some((r) => r.status === 'alarm')) return 'alarm';
    if (rows.some((r) => r.status === 'error')) return 'error';
    if (rows.some((r) => r.status === 'ok')) return 'ok';
    return 'skip';
}

/**
 * Parse `powerpipe benchmark run --output json` into a flat per-control list.
 * Walks the nested group tree. PURE — no I/O.
 */
export function parsePowerpipeBenchmarkJson(raw: unknown): PowerpipeControlResult[] {
    const out: PowerpipeControlResult[] = [];
    const seen = new Set<string>();
    const walk = (node: RawGroup | undefined): void => {
        if (!node) return;
        for (const c of node.controls ?? []) {
            const id = c.control_id ?? c.name;
            if (!id) continue;
            const shortId = shortControlName(id);
            if (seen.has(shortId)) continue;
            seen.add(shortId);
            const status = aggregateStatus(c);
            const firstReason = (c.results ?? []).find((r) => r.status === status)?.reason;
            out.push({ controlId: shortId, title: c.title ?? shortId, status, reason: firstReason ?? '' });
        }
        for (const g of node.groups ?? []) walk(g);
    };
    // Powerpipe wraps the benchmark either at the root or under `.groups`.
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
    counts: { ok: number; alarm: number; skip: number; error: number; total: number };
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
    const counts = { ok: 0, alarm: 0, skip: 0, error: 0, total: controls.length };
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

/** One CLI invocation's outcome. `missing` means the binary was not on PATH. */
export interface AwsCliResult {
    ok: boolean;
    stdout: string;
    stderr: string;
    code: number | null;
    missing: boolean;
}

/**
 * Test seam — inject a runner instead of shelling out, exactly as the Azure and
 * GCP posture providers already do. Without it there is no way to exercise
 * `runCheck`'s credential classification, and an untestable branch on the path
 * that raises a customer-visible banner is not one to ship.
 */
export type AwsCliRunner = (
    file: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    secrets: AwsPostureSecrets,
) => Promise<AwsCliResult>;

function runCli(
    file: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    secrets: AwsPostureSecrets,
): Promise<AwsCliResult> {
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

    /** Test seam — the CLI runner, injectable (mirrors Azure/GCP). */
    private readonly exec: AwsCliRunner;
    constructor(deps: { exec?: AwsCliRunner } = {}) {
        this.exec = deps.exec ?? runCli;
    }

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
        const res = await this.exec('aws', ['sts', 'get-caller-identity', '--output', 'json'], env, s);
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
        const res = await this.exec('powerpipe', ['benchmark', 'run', benchmark, '--output', 'json'], env, secrets);
        if (res.missing) {
            return { status: 'ERROR', summary: 'Powerpipe CLI not installed on the collector host.', details: { benchmark }, durationMs: Date.now() - start, errorMessage: 'powerpipe not installed — see docs/aws-posture-connector.md' };
        }
        // H2 — fail CLOSED on a non-zero collector exit (revoked credential /
        // network error) rather than parsing empty stdout into a false PASS.
        if (!res.ok) {
            // "revoked credential / network error" names two outcomes that were
            // reported as one. The collector's `catch` marks the connection
            // credential-revoked, and returning here meant it never ran — so a
            // revoked key looked exactly like a blip and the banner was
            // unreachable. Classify the (already-scrubbed) stderr FIRST: an
            // unambiguous authentication code throws, and everything else —
            // network, permissions, a broken host — stays an ordinary ERROR.
            // Deliberately the full stderr, not the 300-char excerpt below: the
            // excerpt is what the ledger shows a human, and truncating the
            // evidence before classifying it would drop verdicts at random.
            throwIfPostureCredentialFailure(res.stderr, benchmark);
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
        const status: CheckResult['status'] = summary.counts.alarm > 0 ? 'FAILED' : summary.counts.error > 0 ? 'ERROR' : 'PASSED';
        return {
            status,
            summary: `${benchmark}: ${summary.counts.ok} ok / ${summary.counts.alarm} alarm / ${summary.counts.skip} skip of ${summary.counts.total}`,
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
