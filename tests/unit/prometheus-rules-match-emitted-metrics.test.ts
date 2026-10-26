/**
 * The observability stack's Prometheus rules and Grafana panels select only
 * series the stack actually exports.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Every rule in `infra/observability/prometheus/rules/` and every panel in
 * `infra/observability/grafana/dashboards/` passed `promtool check rules` and
 * loaded into Grafana while several of them could never return a sample:
 *
 *   · `job:job_execution:failure_ratio5m` filtered `status="error"`. The app
 *     labels a job execution `job.status` = `success|failure`, so the label in
 *     Prometheus is `job_status` and `JobFailureRateHigh` could not fire.
 *   · The queue-depth rule and `JobQueueDepthGrowing` read `job_queue_depth`
 *     `by (queue)`. The gauge is unit `1`, which the collector's exporter
 *     names `job_queue_depth_ratio`, and its labels are `queue_name` and
 *     `queue_state` — no series and no label matched. Under the right name
 *     it would still be empty: nothing outside tests calls
 *     `startQueueDepthReporting`, the only place the gauge is registered.
 *   · `CollectorDroppingData` and two stack-health panels read
 *     `otelcol_processor_dropped_*`, which collector 0.123.0 does not emit.
 *   · The DAU/MAU panels read `business_tenant_active_{daily,monthly}`; both
 *     gauges are unit `1` too, so they are `…_ratio`.
 *   · A panel read `aws_rds_replica_lag_average`; there is no RDS.
 *   · `PrometheusDiskFillingUp` read `node_filesystem_*` from a node_exporter
 *     the stack does not run.
 *   · Every `runbook_url` pointed at a placeholder host.
 *
 * A syntax check cannot see any of that: an unknown metric is valid PromQL.
 * So this test derives what the stack exports and holds every selector to it.
 *
 * WHERE THE EXPORTED NAMES COME FROM
 * ──────────────────────────────────
 *   1. The app's instruments are READ FROM SOURCE — every `create<Kind>(name,
 *      { unit })` under `src/`, and the attribute keys of every `.add()`,
 *      `.record()` and gauge `.observe()` that records into it. Renaming an
 *      instrument or an attribute in `metrics.ts` changes what this test
 *      derives, so a rule left behind fails here. An instrument counts as
 *      emitted only if the function that records it is called from `src/` or
 *      `scripts/` (one hop — see `isCalled`).
 *   2. The names go through the collector's Prometheus exporter, whose
 *      translation is reproduced below from the source of the pinned image
 *      (`normalize_name.go`, `normalize_unit.go`, `normalize_label.go` in
 *      opentelemetry-collector-contrib `pkg/translator/prometheus` v0.123.0;
 *      the `pkg.translator.prometheus.NormalizeName` gate is beta, so ON):
 *        - dotted name → tokens joined by `_`;
 *        - unit appended (`ms` → `milliseconds`, `By` → `bytes`; `1` and a
 *          `{annotation}` add nothing) unless the name already has it;
 *        - a monotonic sum (Counter) gets `_total`;
 *        - a GAUGE whose unit is `1` gets `_ratio`;
 *        - a histogram exports `_bucket` (with `le`), `_sum` and `_count`.
 *      Attribute keys become labels with every non-alphanumeric rune → `_`.
 *   3. `resource_to_telemetry_conversion` copies resource attributes onto
 *      every series (the app's `resourceFromAttributes`, the collector's
 *      `resource` processor, and the `system` detector's defaults); the
 *      exporter's own `job` arrives as `exported_job` because the scrape
 *      does not honour labels; Prometheus adds `job`, `instance` and the
 *      scrape job's static labels.
 *   4. Series the repository does not declare — the collector's own
 *      telemetry and Prometheus's — come from `externalSeries()`, read from
 *      the same pinned versions.
 *
 * The first test pins the assumptions those rules stand on (image tags,
 * exporter options). Bumping the collector image fails it ON PURPOSE: the
 * translation changed shape more than once upstream, and whoever bumps it
 * re-reads the source and updates this file.
 *
 * Templating is out of scope: no panel here uses a Grafana variable inside
 * a query. If one does, `lex` throws on the `$` and names the query, so the
 * suite fails rather than skipping it.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import * as yaml from 'js-yaml';

import { REPO_ROOT, repoRelativeFiles } from '../helpers/repo-files';

const OBS = 'infra/observability';
const COMPOSE = `${OBS}/docker-compose.observability.yml`;
const COLLECTOR_CONFIG = `${OBS}/otel-collector/config.yaml`;
const PROMETHEUS_CONFIG = `${OBS}/prometheus/prometheus.yml`;
const RULES_PREFIX = `${OBS}/prometheus/rules/`;
const DASHBOARDS_PREFIX = `${OBS}/grafana/dashboards/`;
const INSTRUMENTATION = 'src/lib/observability/instrumentation.ts';

/** The images whose source the translation and `externalSeries()` were read from. */
const PINNED_COLLECTOR_IMAGE = 'otel/opentelemetry-collector-contrib:0.123.0';
const PINNED_PROMETHEUS_IMAGE = 'prom/prometheus:v3.3.0';

/** Where a `runbook_url` may point: this repository's own docs, on GitHub. */
const RUNBOOK_URL_PREFIX = 'https://github.com/RodnaPamet/inflect-compliance/blob/main/';

const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const files = repoRelativeFiles();

// ═══════════════════════════════════════════════════════════════════════
// Value sets — a label's values are either a closed set we can enumerate
// from source, or open.
// ═══════════════════════════════════════════════════════════════════════

type ValueSet = { readonly open: true } | { readonly open: false; readonly values: ReadonlySet<string> };
const OPEN: ValueSet = { open: true };
const closed = (...values: string[]): ValueSet => ({ open: false, values: new Set(values) });

function unionValues(a: ValueSet | undefined, b: ValueSet): ValueSet {
    if (a === undefined) return b;
    if (a.open || b.open) return OPEN;
    return { open: false, values: new Set([...a.values, ...b.values]) };
}

type LabelMap = Map<string, ValueSet>;

function mergeLabels(into: LabelMap, from: LabelMap): void {
    for (const [k, v] of from) into.set(k, unionValues(into.get(k), v));
}

// ═══════════════════════════════════════════════════════════════════════
// The collector's translation (contrib pkg/translator/prometheus v0.123.0)
// ═══════════════════════════════════════════════════════════════════════

type Kind = 'counter' | 'updowncounter' | 'histogram' | 'gauge';

const UNIT_MAP: Record<string, string> = {
    d: 'days', h: 'hours', min: 'minutes', s: 'seconds', ms: 'milliseconds',
    us: 'microseconds', ns: 'nanoseconds',
    By: 'bytes', KiBy: 'kibibytes', MiBy: 'mebibytes', GiBy: 'gibibytes', TiBy: 'tibibytes',
    KBy: 'kilobytes', MBy: 'megabytes', GBy: 'gigabytes', TBy: 'terabytes',
    m: 'meters', V: 'volts', A: 'amperes', J: 'joules', W: 'watts', g: 'grams',
    Cel: 'celsius', Hz: 'hertz', '1': '', '%': 'percent',
};
const PER_UNIT_MAP: Record<string, string> = {
    s: 'second', m: 'minute', h: 'hour', d: 'day', w: 'week', mo: 'month', y: 'year',
};

const tokensOf = (s: string): string[] => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** `normalizeName` — the exporter's metric name for one OTel instrument. */
function prometheusName(name: string, kind: Kind, unit: string): string {
    let tokens = tokensOf(name);
    const slash = unit.indexOf('/');
    const mainOtel = (slash < 0 ? unit : unit.slice(0, slash)).trim();
    const perOtel = slash < 0 ? '' : unit.slice(slash + 1).trim();
    const mainUnit =
        mainOtel !== '' && !/[{}]/.test(mainOtel) ? tokensOf(UNIT_MAP[mainOtel] ?? mainOtel).join('_') : '';
    const perUnit =
        perOtel !== '' && !/[{}]/.test(perOtel) ? tokensOf(PER_UNIT_MAP[perOtel] ?? perOtel).join('_') : '';
    if (mainUnit !== '' && !tokens.includes(mainUnit)) tokens.push(mainUnit);
    if (perUnit !== '' && !tokens.includes(perUnit)) tokens.push('per', perUnit);
    if (kind === 'counter') tokens = [...tokens.filter((t) => t !== 'total'), 'total'];
    if (kind === 'gauge' && unit === '1') tokens = [...tokens.filter((t) => t !== 'ratio'), 'ratio'];
    const joined = tokens.join('_');
    return /^\d/.test(joined) ? `_${joined}` : joined;
}

/** `NormalizeLabel` — an attribute key as a Prometheus label. */
function prometheusLabel(key: string): string {
    const label = key.replace(/[^\p{L}\p{N}]/gu, '_');
    if (/^\d/.test(label)) return `key_${label}`;
    if (label.startsWith('_') && !label.startsWith('__')) return `key${label}`;
    return label;
}

// ═══════════════════════════════════════════════════════════════════════
// Reading the app's instruments from source
// ═══════════════════════════════════════════════════════════════════════

const CREATE_KIND: Record<string, Kind> = {
    createCounter: 'counter',
    createObservableCounter: 'counter',
    createUpDownCounter: 'updowncounter',
    createObservableUpDownCounter: 'updowncounter',
    createHistogram: 'histogram',
    createGauge: 'gauge',
    createObservableGauge: 'gauge',
};
const CREATE_CALL = /\.create(?:Observable)?(?:Counter|UpDownCounter|Histogram|Gauge)\s*\(/;

interface Instrument {
    readonly name: string;
    readonly kind: Kind;
    readonly unit: string;
    readonly declaredIn: string;
    readonly attributes: LabelMap;
    sites: number;
    readonly unresolvedSites: string[];
    /** The outermost named function around each recording site — what has to be called for it to run. */
    readonly recordedFrom: Set<string>;
}

const parsed = new Map<string, ts.SourceFile>();
function sourceOf(rel: string): ts.SourceFile {
    let sf = parsed.get(rel);
    if (!sf) {
        sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        parsed.set(rel, sf);
    }
    return sf;
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
    visit(node);
    node.forEachChild((child) => walk(child, visit));
}

const where = (node: ts.Node): string => {
    const sf = node.getSourceFile();
    return `${sf.fileName}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
};

/** The declaration an identifier refers to, by walking out through its scopes. */
function declarationOf(id: ts.Identifier): ts.VariableDeclaration | ts.ParameterDeclaration | ts.BindingElement | undefined {
    const name = id.text;
    const bindsName = (n: ts.BindingName): ts.Identifier | ts.BindingElement | undefined => {
        if (ts.isIdentifier(n)) return n.text === name ? n : undefined;
        for (const el of n.elements) {
            if (ts.isOmittedExpression(el)) continue;
            if (ts.isIdentifier(el.name) && el.name.text === name) return el;
            const inner = bindsName(el.name);
            if (inner) return inner;
        }
        return undefined;
    };
    const fromList = (list: ts.VariableDeclarationList) => {
        for (const d of list.declarations) {
            const hit = bindsName(d.name);
            if (hit) return ts.isBindingElement(hit) ? hit : d;
        }
        return undefined;
    };
    for (let node: ts.Node | undefined = id.parent; node; node = node.parent) {
        if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
            for (const st of node.statements) {
                if (ts.isVariableStatement(st)) {
                    const hit = fromList(st.declarationList);
                    if (hit) return hit;
                }
            }
        }
        if ((ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isForStatement(node)) && node.initializer && ts.isVariableDeclarationList(node.initializer)) {
            const hit = fromList(node.initializer);
            if (hit) return hit;
        }
        if (ts.isFunctionLike(node)) {
            for (const p of node.parameters) {
                if (bindsName(p.name)) return p;
            }
        }
    }
    return undefined;
}

/** The values an attribute-value expression can take, when they are spelled out in source. */
function valuesOf(expr: ts.Expression, depth = 0): ValueSet {
    if (depth > 8) return OPEN;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return closed(expr.text);
    if (ts.isNumericLiteral(expr)) return closed(String(Number(expr.text)));
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) {
        return valuesOf(expr.expression, depth + 1);
    }
    if (ts.isConditionalExpression(expr)) {
        return unionValues(valuesOf(expr.whenTrue, depth + 1), valuesOf(expr.whenFalse, depth + 1));
    }
    if (ts.isArrayLiteralExpression(expr)) {
        let acc: ValueSet | undefined;
        for (const el of expr.elements) acc = unionValues(acc, ts.isSpreadElement(el) ? OPEN : valuesOf(el, depth + 1));
        return acc ?? OPEN;
    }
    if (ts.isIdentifier(expr)) {
        const decl = declarationOf(expr);
        if (decl && ts.isVariableDeclaration(decl)) {
            const list = decl.parent;
            // `for (const state of STATES)` — the loop variable takes the iterable's values.
            if (ts.isVariableDeclarationList(list) && ts.isForOfStatement(list.parent) && list.parent.initializer === list) {
                return valuesOf(list.parent.expression, depth + 1);
            }
            if (ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0 && decl.initializer) {
                return valuesOf(decl.initializer, depth + 1);
            }
        }
    }
    return OPEN;
}

/** A string an expression evaluates to, when it is spelled out (`X ?? 'literal'` included). */
function stringOf(expr: ts.Expression | undefined, depth = 0): string | undefined {
    if (!expr || depth > 8) return undefined;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
    if (ts.isParenthesizedExpression(expr)) return stringOf(expr.expression, depth + 1);
    if (ts.isBinaryExpression(expr) && (expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || expr.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
        return stringOf(expr.right, depth + 1) ?? stringOf(expr.left, depth + 1);
    }
    if (ts.isIdentifier(expr)) {
        const decl = declarationOf(expr);
        if (decl && ts.isVariableDeclaration(decl)) return stringOf(decl.initializer, depth + 1);
    }
    return undefined;
}

/** The attribute keys (and their values) an attributes argument carries; `false` if it cannot be read. */
function attributesOf(expr: ts.Expression | undefined, out: LabelMap, depth = 0): boolean {
    if (expr === undefined) return true;
    if (depth > 8) return false;
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) {
        return attributesOf(expr.expression, out, depth + 1);
    }
    if (ts.isIdentifier(expr)) {
        const decl = declarationOf(expr);
        return decl !== undefined && ts.isVariableDeclaration(decl) && decl.initializer !== undefined
            ? attributesOf(decl.initializer, out, depth + 1)
            : false;
    }
    if (!ts.isObjectLiteralExpression(expr)) return false;
    let ok = true;
    for (const prop of expr.properties) {
        if (ts.isPropertyAssignment(prop)) {
            const key = ts.isComputedPropertyName(prop.name)
                ? stringOf(prop.name.expression)
                : ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) || ts.isNumericLiteral(prop.name)
                  ? prop.name.text
                  : undefined;
            if (key === undefined) {
                ok = false;
                continue;
            }
            out.set(key, unionValues(out.get(key), valuesOf(prop.initializer)));
        } else if (ts.isShorthandPropertyAssignment(prop)) {
            out.set(prop.name.text, unionValues(out.get(prop.name.text), valuesOf(prop.name)));
        } else if (ts.isSpreadAssignment(prop)) {
            ok = attributesOf(prop.expression, out, depth + 1) && ok;
        } else {
            ok = false;
        }
    }
    return ok;
}

const enclosingFunction = (node: ts.Node): ts.SignatureDeclaration | undefined => {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) if (ts.isFunctionLike(n)) return n;
    return undefined;
};
const functionName = (fn: ts.SignatureDeclaration | undefined): string | undefined => {
    if (!fn) return undefined;
    if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
    if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
    return undefined;
};
/** The outermost named function a node sits in; `undefined` at module top level. */
const outermostFunctionName = (node: ts.Node): string | undefined => {
    let name: string | undefined;
    for (let fn = enclosingFunction(node); fn; fn = enclosingFunction(fn)) name = functionName(fn) ?? name;
    return name;
};

interface Catalogue {
    readonly instruments: Map<string, Instrument>;
    /** `create<Kind>(…)` calls whose name is neither a literal nor a wrapper parameter. */
    readonly unresolvedDeclarations: string[];
    /** per file: how many `create<Kind>(…)` calls it holds, and how many were resolved. */
    readonly declarationCounts: Map<string, { calls: number; resolved: number }>;
}

function readInstruments(): Catalogue {
    const instruments = new Map<string, Instrument>();
    const unresolvedDeclarations: string[] = [];
    const declarationCounts = new Map<string, { calls: number; resolved: number }>();

    // instrument ← function that returns it (`getRequestCount()`), ← variable it is held in,
    // ← wrapper `counter(name, …)` whose name parameter it is created from.
    const byGetter = new Map<string, Instrument[]>();
    const byDeclaration = new Map<ts.Node, Instrument>();
    const wrappers = new Map<string, { paramIndex: number; kind: Kind; unit: string }>();

    const instrument = (name: string, kind: Kind, unit: string, declaredIn: string): Instrument => {
        let inst = instruments.get(name);
        if (!inst) {
            inst = { name, kind, unit, declaredIn, attributes: new Map(), sites: 0, unresolvedSites: [], recordedFrom: new Set() };
            instruments.set(name, inst);
        }
        return inst;
    };

    const srcFiles = files.filter((f) => f.startsWith('src/') && /\.tsx?$/.test(f) && !f.endsWith('.d.ts'));
    const texts = new Map(srcFiles.map((f) => [f, read(f)] as const));
    const declaring = srcFiles.filter((f) => CREATE_CALL.test(texts.get(f) ?? ''));

    for (const rel of declaring) {
        const counts = { calls: 0, resolved: 0 };
        declarationCounts.set(rel, counts);
        walk(sourceOf(rel), (node) => {
            if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
            const kind = CREATE_KIND[node.expression.name.text];
            if (kind === undefined) return;
            counts.calls++;
            const [nameArg, optsArg] = node.arguments;
            let unit = '';
            if (optsArg && ts.isObjectLiteralExpression(optsArg)) {
                for (const p of optsArg.properties) {
                    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'unit') unit = stringOf(p.initializer) ?? '';
                }
            }
            const fn = enclosingFunction(node);
            if (nameArg && ts.isIdentifier(nameArg) && fn) {
                const paramIndex = fn.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === nameArg.text);
                const wrapper = functionName(fn);
                if (paramIndex >= 0 && wrapper) {
                    wrappers.set(wrapper, { paramIndex, kind, unit });
                    counts.resolved++;
                    return;
                }
            }
            const name = nameArg && (ts.isStringLiteral(nameArg) || ts.isNoSubstitutionTemplateLiteral(nameArg)) ? nameArg.text : undefined;
            if (name === undefined) {
                unresolvedDeclarations.push(where(node));
                return;
            }
            counts.resolved++;
            const inst = instrument(name, kind, unit, rel);
            const getter = functionName(fn);
            if (getter) byGetter.set(getter, [...(byGetter.get(getter) ?? []), inst]);
            // `const gauge = meter.create…()` / `_x = meter.create…()` — key it by the variable's declaration.
            const parent = node.parent;
            if (ts.isVariableDeclaration(parent)) byDeclaration.set(parent, inst);
            if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(parent.left)) {
                const decl = declarationOf(parent.left);
                if (decl) byDeclaration.set(decl, inst);
            }
        });
    }

    const record = (inst: Instrument, attrs: ts.Expression | undefined, site: ts.Node) => {
        inst.sites++;
        inst.recordedFrom.add(outermostFunctionName(site) ?? '<module top level>');
        const labels: LabelMap = new Map();
        if (!attributesOf(attrs, labels)) inst.unresolvedSites.push(where(site));
        mergeLabels(inst.attributes, labels);
    };

    const handleNames = [...byGetter.keys(), ...wrappers.keys()];
    const recording = srcFiles.filter(
        (f) => declaring.includes(f) || handleNames.some((h) => (texts.get(f) ?? '').includes(`${h}(`)),
    );
    for (const rel of recording) {
        walk(sourceOf(rel), (node) => {
            if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
            const method = node.expression.name.text;
            const target = node.expression.expression;

            // gauge.addCallback((result) => { result.observe(v, attrs) })
            if (method === 'addCallback' && ts.isIdentifier(target)) {
                const decl = declarationOf(target);
                const inst = decl ? byDeclaration.get(decl) : undefined;
                const cb = node.arguments[0];
                if (!inst || !cb || !(ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) return;
                const resultParam = cb.parameters[0]?.name;
                if (!resultParam || !ts.isIdentifier(resultParam)) return;
                walk(cb.body, (inner) => {
                    if (
                        ts.isCallExpression(inner) &&
                        ts.isPropertyAccessExpression(inner.expression) &&
                        inner.expression.name.text === 'observe' &&
                        ts.isIdentifier(inner.expression.expression) &&
                        inner.expression.expression.text === resultParam.text
                    ) {
                        record(inst, inner.arguments[1], inner);
                    }
                });
                return;
            }

            if (method !== 'add' && method !== 'record') return;
            const attrs = node.arguments[1];
            if (ts.isIdentifier(target)) {
                const decl = declarationOf(target);
                const inst = decl ? byDeclaration.get(decl) : undefined;
                if (inst) record(inst, attrs, node);
                return;
            }
            if (ts.isCallExpression(target) && ts.isIdentifier(target.expression)) {
                const fnName = target.expression.text;
                const viaGetter = byGetter.get(fnName);
                if (viaGetter && viaGetter.length === 1 && target.arguments.length === 0) {
                    record(viaGetter[0], attrs, node);
                    return;
                }
                const wrapper = wrappers.get(fnName);
                const nameArg = wrapper ? target.arguments[wrapper.paramIndex] : undefined;
                if (wrapper && nameArg && (ts.isStringLiteral(nameArg) || ts.isNoSubstitutionTemplateLiteral(nameArg))) {
                    record(instrument(nameArg.text, wrapper.kind, wrapper.unit, rel), attrs, node);
                }
            }
        });
    }

    return { instruments, unresolvedDeclarations, declarationCounts };
}

// ═══════════════════════════════════════════════════════════════════════
// The stack's configuration
// ═══════════════════════════════════════════════════════════════════════

interface ScrapeJob {
    readonly job_name: string;
    readonly honor_labels?: boolean;
    readonly static_configs?: ReadonlyArray<{ targets?: string[]; labels?: Record<string, string> }>;
}
interface CollectorConfig {
    receivers: Record<string, unknown>;
    processors: Record<string, { detectors?: string[]; attributes?: Array<{ key: string; action: string }> }>;
    exporters: Record<string, {
        endpoint?: string;
        namespace?: string;
        add_metric_suffixes?: boolean;
        resource_to_telemetry_conversion?: { enabled?: boolean };
    }>;
    service: {
        telemetry?: { metrics?: { readers?: Array<{ pull?: { exporter?: { prometheus?: { port?: number } } } }> } };
        pipelines: Record<string, { processors?: string[]; exporters?: string[] }>;
    };
}

const compose = yaml.load(read(COMPOSE)) as { services: Record<string, { image?: string }> };
const collectorConfig = yaml.load(read(COLLECTOR_CONFIG)) as CollectorConfig;
const prometheusConfig = yaml.load(read(PROMETHEUS_CONFIG)) as { scrape_configs: ScrapeJob[] };

const scrapeJobs = prometheusConfig.scrape_configs;
const scrapeJobByPort = (port: number | string | undefined): ScrapeJob => {
    const job = scrapeJobs.find((j) => (j.static_configs ?? []).some((s) => (s.targets ?? []).some((t) => t.endsWith(`:${port}`))));
    if (!job) throw new Error(`no scrape job in ${PROMETHEUS_CONFIG} targets port ${port}`);
    return job;
};

/** `job`, `instance` and the static labels Prometheus attaches to everything one job scrapes. */
function targetLabels(job: ScrapeJob): LabelMap {
    const labels: LabelMap = new Map([['job', closed(job.job_name)], ['instance', OPEN]]);
    for (const s of job.static_configs ?? []) {
        for (const [k, v] of Object.entries(s.labels ?? {})) labels.set(k, unionValues(labels.get(k), closed(v)));
    }
    return labels;
}

/** The pipeline that carries the app's metrics into the Prometheus exporter. */
function appMetricsExporter(): { name: string; pipeline: { processors?: string[]; exporters?: string[] } } {
    for (const pipeline of Object.values(collectorConfig.service.pipelines)) {
        const name = (pipeline.exporters ?? []).find((e) => e === 'prometheus' || e.startsWith('prometheus/'));
        if (name) return { name, pipeline };
    }
    throw new Error(`${COLLECTOR_CONFIG}: no pipeline exports to a prometheus exporter`);
}

/** `system` detector attributes enabled by default in resourcedetectionprocessor v0.123.0. */
const DETECTOR_DEFAULT_ATTRIBUTES: Record<string, string[]> = {
    system: ['host.name', 'os.type'],
    // `env` reads OTEL_RESOURCE_ATTRIBUTES from the collector's environment; the
    // compose file sets none, so it adds nothing.
    env: [],
};

/** Resource attributes that reach every app series, through `resource_to_telemetry_conversion`. */
function resourceAttributes(): string[] {
    const keys = new Set<string>();
    // The app's own resource (instrumentation.ts → resourceFromAttributes({...})).
    let found = false;
    walk(sourceOf(INSTRUMENTATION), (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'resourceFromAttributes') {
            const attrs: LabelMap = new Map();
            if (!attributesOf(node.arguments[0], attrs)) throw new Error(`${where(node)}: resource attributes are not readable`);
            for (const k of attrs.keys()) keys.add(k);
            found = true;
        }
    });
    if (!found) throw new Error(`${INSTRUMENTATION}: no resourceFromAttributes({...}) call`);
    // The collector's processors on the metrics pipeline.
    for (const procName of appMetricsExporter().pipeline.processors ?? []) {
        const proc = collectorConfig.processors[procName] ?? {};
        const type = procName.split('/')[0];
        if (type === 'resource') {
            for (const a of proc.attributes ?? []) if (a.action === 'upsert' || a.action === 'insert') keys.add(a.key);
        }
        if (type === 'resourcedetection') {
            for (const d of proc.detectors ?? []) {
                const attrs = DETECTOR_DEFAULT_ATTRIBUTES[d];
                if (!attrs) throw new Error(`resourcedetection detector "${d}" — add its default attributes from the pinned collector's source`);
                attrs.forEach((a) => keys.add(a));
            }
        }
    }
    return [...keys];
}

// ═══════════════════════════════════════════════════════════════════════
// Series the stack exports that this repository does not declare
// ═══════════════════════════════════════════════════════════════════════

/**
 * Read from the pinned versions' source:
 *  - collector self-telemetry: the generated telemetry of exporterhelper,
 *    receiverhelper, processorhelper and memorylimiterprocessor at v0.123.0
 *    (collector 0.123.0 has NO `otelcol_processor_dropped_*` series), exposed
 *    by go.opentelemetry.io/otel/exporters/prometheus v0.57.0, which appends
 *    `_total` to a counter and nothing for a `{spans}`-style unit;
 *  - Prometheus 3.3.0: the series it synthesises for every target, and its
 *    own TSDB head gauge.
 */
function externalSeries(): Map<string, SeriesInfo> {
    const out = new Map<string, SeriesInfo>();
    const add = (name: string, labels: string[], counterLike: boolean, job: ScrapeJob, source: string) => {
        const map = targetLabels(job);
        for (const l of labels) map.set(l, OPEN);
        out.set(name, { labels: map, counterLike, source });
    };
    const selfPort = collectorConfig.service.telemetry?.metrics?.readers?.[0]?.pull?.exporter?.prometheus?.port;
    const selfJob = scrapeJobByPort(selfPort);
    for (const s of ['spans', 'metric_points', 'log_records']) {
        add(`otelcol_exporter_sent_${s}_total`, ['exporter'], true, selfJob, 'collector self-telemetry');
        add(`otelcol_exporter_send_failed_${s}_total`, ['exporter'], true, selfJob, 'collector self-telemetry');
        add(`otelcol_exporter_enqueue_failed_${s}_total`, ['exporter'], true, selfJob, 'collector self-telemetry');
        add(`otelcol_receiver_accepted_${s}_total`, ['receiver', 'transport'], true, selfJob, 'collector self-telemetry');
        add(`otelcol_receiver_refused_${s}_total`, ['receiver', 'transport'], true, selfJob, 'collector self-telemetry');
        add(`otelcol_processor_accepted_${s}_total`, ['processor'], true, selfJob, 'collector self-telemetry (memory_limiter)');
        add(`otelcol_processor_refused_${s}_total`, ['processor'], true, selfJob, 'collector self-telemetry (memory_limiter)');
    }
    add('otelcol_processor_incoming_items_total', ['processor', 'otel_signal'], true, selfJob, 'collector self-telemetry');
    add('otelcol_processor_outgoing_items_total', ['processor', 'otel_signal'], true, selfJob, 'collector self-telemetry');

    const promJob = scrapeJobByPort(9090);
    add('prometheus_tsdb_head_series', [], false, promJob, 'Prometheus');

    // Synthesised by Prometheus for every scrape target.
    for (const name of ['up', 'scrape_duration_seconds', 'scrape_samples_scraped', 'scrape_samples_post_metric_relabeling', 'scrape_series_added']) {
        const labels: LabelMap = new Map();
        for (const job of scrapeJobs) mergeLabels(labels, targetLabels(job));
        out.set(name, { labels, counterLike: false, source: 'Prometheus (per target)' });
    }
    return out;
}

// ═══════════════════════════════════════════════════════════════════════
// The catalogue: every series name the stack exports, with its labels
// ═══════════════════════════════════════════════════════════════════════

interface SeriesInfo {
    readonly labels: LabelMap;
    readonly counterLike: boolean;
    readonly source: string;
    readonly instrument?: Instrument;
}

function buildCatalogue(cat: Catalogue): Map<string, SeriesInfo> {
    const exporter = collectorConfig.exporters[appMetricsExporter().name];
    const appJob = scrapeJobByPort(exporter.endpoint?.split(':').pop());
    const common: LabelMap = targetLabels(appJob);
    if (exporter.resource_to_telemetry_conversion?.enabled === true) {
        for (const k of resourceAttributes()) common.set(prometheusLabel(k), OPEN);
    }
    // The exporter sets `job` from service.name; an un-honoured scrape renames it.
    common.set(appJob.honor_labels === true ? 'job' : 'exported_job', OPEN);

    const out = externalSeries();
    for (const inst of cat.instruments.values()) {
        const base = prometheusName(inst.name, inst.kind, inst.unit);
        const labels: LabelMap = new Map(common);
        for (const [k, v] of inst.attributes) labels.set(prometheusLabel(k), v);
        const source = `${inst.name} (${inst.declaredIn})`;
        if (inst.kind === 'histogram') {
            out.set(`${base}_bucket`, { labels: new Map([...labels, ['le', OPEN]]), counterLike: true, source, instrument: inst });
            out.set(`${base}_sum`, { labels, counterLike: true, source, instrument: inst });
            out.set(`${base}_count`, { labels, counterLike: true, source, instrument: inst });
        } else {
            out.set(base, { labels, counterLike: inst.kind === 'counter', source, instrument: inst });
        }
    }
    return out;
}

// ═══════════════════════════════════════════════════════════════════════
// PromQL — just enough to find selectors, matchers and grouping labels
// ═══════════════════════════════════════════════════════════════════════

interface Tok { readonly t: 'id' | 'str' | 'num' | 'p'; readonly v: string }

function lex(src: string): Tok[] {
    const out: Tok[] = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (/\s/.test(c)) { i++; continue; }
        if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (c === '"' || c === "'" || c === '`') {
            let v = '';
            i++;
            while (i < src.length && src[i] !== c) {
                if (src[i] === '\\' && c !== '`') { v += src[i + 1]; i += 2; continue; }
                v += src[i++];
            }
            i++;
            out.push({ t: 'str', v });
            continue;
        }
        if (c === '[') { // range or subquery — nothing in it names a series
            while (i < src.length && src[i] !== ']') i++;
            i++;
            continue;
        }
        const num = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[a-zA-Z]*/.exec(src.slice(i));
        if (num) { out.push({ t: 'num', v: num[0] }); i += num[0].length; continue; }
        const id = /^[a-zA-Z_:][a-zA-Z0-9_:]*/.exec(src.slice(i));
        if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
        const op = /^(?:=~|!~|!=|==|>=|<=|[(){},=<>+\-*/%^@])/.exec(src.slice(i));
        if (!op) throw new Error(`cannot lex PromQL at "${src.slice(i, i + 20)}" in: ${src}`);
        out.push({ t: 'p', v: op[0] });
        i += op[0].length;
    }
    return out;
}

const AGGREGATIONS = new Set(['sum', 'min', 'max', 'avg', 'group', 'stddev', 'stdvar', 'count', 'count_values', 'bottomk', 'topk', 'quantile', 'limitk', 'limit_ratio']);
const GROUPING = new Set(['by', 'without', 'on', 'ignoring', 'group_left', 'group_right']);
const KEYWORDS = new Set(['and', 'or', 'unless', 'bool', 'offset', 'atan2', 'inf', 'nan', 'Inf', 'NaN']);
const COUNTER_FUNCTIONS = new Set(['rate', 'irate', 'increase', 'resets']);

interface Matcher { readonly label: string; readonly op: string; readonly value: string }
interface Selector { readonly name: string; readonly matchers: Matcher[]; readonly fn: string | null }
interface Query {
    readonly selectors: Selector[];
    readonly by: string[];
    readonly without: string[];
    /** every label named in by/without/on/ignoring/group_left/group_right */
    readonly grouping: string[];
    readonly aggregates: boolean;
    readonly functions: Set<string>;
}

function parsePromQL(expr: string): Query {
    const toks = lex(expr);
    const q: Query = { selectors: [], by: [], without: [], grouping: [], aggregates: false, functions: new Set() };
    let aggregates = false;
    for (let i = 0; i < toks.length; i++) {
        const tok = toks[i];
        const next = toks[i + 1];
        if (tok.t === 'p' && tok.v === '{') {
            const { matchers, end } = matchersFrom(toks, i);
            const nameMatcher = matchers.find((m) => m.label === '__name__' && m.op === '=');
            q.selectors.push({ name: nameMatcher?.value ?? '', matchers: matchers.filter((m) => m !== nameMatcher), fn: fnBefore(toks, i) });
            i = end;
            continue;
        }
        if (tok.t !== 'id') continue;
        if (GROUPING.has(tok.v)) {
            if (next?.v !== '(') continue;
            let j = i + 2;
            for (; j < toks.length && toks[j].v !== ')'; j++) {
                if (toks[j].t !== 'id') continue;
                q.grouping.push(toks[j].v);
                if (tok.v === 'by') q.by.push(toks[j].v);
                if (tok.v === 'without') q.without.push(toks[j].v);
            }
            i = j;
            continue;
        }
        if (AGGREGATIONS.has(tok.v)) { aggregates = true; continue; }
        if (next?.v === '(') { q.functions.add(tok.v); continue; }
        if (KEYWORDS.has(tok.v)) continue;
        let matchers: Matcher[] = [];
        if (next?.v === '{') {
            const r = matchersFrom(toks, i + 1);
            matchers = r.matchers;
            q.selectors.push({ name: tok.v, matchers, fn: fnBefore(toks, i) });
            i = r.end;
            continue;
        }
        q.selectors.push({ name: tok.v, matchers, fn: fnBefore(toks, i) });
    }
    return { ...q, aggregates };
}

const fnBefore = (toks: Tok[], i: number): string | null =>
    toks[i - 1]?.v === '(' && toks[i - 2]?.t === 'id' ? toks[i - 2].v : null;

function matchersFrom(toks: Tok[], open: number): { matchers: Matcher[]; end: number } {
    const matchers: Matcher[] = [];
    let j = open + 1;
    while (j < toks.length && toks[j].v !== '}') {
        if (toks[j].t === 'id' && toks[j + 1]?.t === 'p' && toks[j + 2]?.t === 'str') {
            matchers.push({ label: toks[j].v, op: toks[j + 1].v, value: toks[j + 2].v });
            j += 3;
            continue;
        }
        j++;
    }
    return { matchers, end: j };
}

// ═══════════════════════════════════════════════════════════════════════
// The rules and panels under test
// ═══════════════════════════════════════════════════════════════════════

interface RuleYaml {
    groups: Array<{
        name: string;
        rules: Array<{ record?: string; alert?: string; expr: string; labels?: Record<string, string>; annotations?: Record<string, string> }>;
    }>;
}

interface QuerySite {
    readonly where: string;
    readonly expr: string;
    /** label names a template on this query renders — `$labels.x` / `{{x}}` */
    readonly templateLabels: string[];
    readonly record?: string;
    readonly runbookUrl?: string;
}

const ruleFiles = files.filter((f) => f.startsWith(RULES_PREFIX) && f.endsWith('.yml'));
const dashboardFiles = files.filter((f) => f.startsWith(DASHBOARDS_PREFIX) && f.endsWith('.json'));

function ruleSites(): QuerySite[] {
    const sites: QuerySite[] = [];
    for (const rel of ruleFiles) {
        const doc = yaml.load(read(rel)) as RuleYaml;
        for (const group of doc.groups) {
            for (const rule of group.rules) {
                const id = rule.record ?? rule.alert ?? '?';
                const text = Object.values(rule.annotations ?? {}).join('\n');
                const templateLabels = [...text.matchAll(/\$labels\.([A-Za-z_][A-Za-z0-9_]*)/g), ...text.matchAll(/\.Labels\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
                sites.push({
                    where: `${rel} › ${group.name} › ${id}`,
                    expr: rule.expr,
                    templateLabels,
                    record: rule.record,
                    runbookUrl: rule.annotations?.runbook_url,
                });
            }
        }
    }
    return sites;
}

function dashboardSites(): QuerySite[] {
    const sites: QuerySite[] = [];
    for (const rel of dashboardFiles) {
        const dash = JSON.parse(read(rel)) as { panels?: unknown[] };
        const visitPanel = (panel: { title?: string; targets?: Array<{ expr?: string; legendFormat?: string; refId?: string }>; panels?: unknown[] }) => {
            for (const t of panel.targets ?? []) {
                if (typeof t.expr !== 'string') continue;
                const templateLabels = [...(t.legendFormat ?? '').matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1]);
                sites.push({ where: `${rel} › "${panel.title ?? '?'}" › ${t.refId ?? '?'}`, expr: t.expr, templateLabels });
            }
            for (const child of panel.panels ?? []) visitPanel(child as typeof panel);
        };
        for (const panel of dash.panels ?? []) visitPanel(panel as Parameters<typeof visitPanel>[0]);
    }
    return sites;
}

// ═══════════════════════════════════════════════════════════════════════
// Evaluation
// ═══════════════════════════════════════════════════════════════════════

const instrumentCatalogue = readInstruments();
const catalogue = buildCatalogue(instrumentCatalogue);
const rules = ruleSites();
const panels = dashboardSites();
const allSites = [...rules, ...panels];

/**
 * Does anything in `src/` or `scripts/` call `fnName` — outside its own body?
 *
 * One hop, deliberately. A recorder that nothing calls is an instrument the
 * app never emits, however correct its name: `startQueueDepthReporting`
 * registers the `job.queue.depth` gauge and had no caller outside tests. This
 * does not prove the caller runs in production; it proves the instrument is
 * wired to something.
 */
const runtimeFiles = files.filter((f) => /^(src|scripts)\//.test(f) && /\.tsx?$/.test(f) && !f.endsWith('.d.ts'));
function isCalled(fnName: string): boolean {
    if (fnName === '<module top level>') return true;
    for (const rel of runtimeFiles) {
        if (!read(rel).includes(`${fnName}(`)) continue;
        let hit = false;
        walk(sourceOf(rel), (node) => {
            if (hit || !ts.isCallExpression(node)) return;
            const callee = node.expression;
            const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
            if (name !== fnName) return;
            for (let fn = enclosingFunction(node); fn; fn = enclosingFunction(fn)) if (functionName(fn) === fnName) return;
            hit = true;
        });
        if (hit) return true;
    }
    return false;
}

/** Union of the labels of every series a query selects; `undefined` if any selector is unknown. */
function selectedLabels(q: Query, known: Map<string, SeriesInfo>): LabelMap | undefined {
    const union: LabelMap = new Map();
    for (const s of q.selectors) {
        const info = known.get(s.name);
        if (!info) return undefined;
        mergeLabels(union, info.labels);
    }
    return union;
}

/** The labels a query's result carries. */
function outputLabels(q: Query, known: Map<string, SeriesInfo>): LabelMap | undefined {
    const union = selectedLabels(q, known);
    if (!union) return undefined;
    if (q.by.length > 0) {
        const keep = q.functions.has('histogram_quantile') ? q.by.filter((l) => l !== 'le') : q.by;
        return new Map(keep.map((l) => [l, union.get(l) ?? OPEN] as const));
    }
    if (q.aggregates) {
        return q.without.length > 0 ? new Map([...union].filter(([k]) => !q.without.includes(k))) : new Map();
    }
    return union;
}

/** The catalogue plus every recording rule, whose labels are its expression's output. */
const known = new Map(catalogue);
for (let pass = 0; pass < 5; pass++) {
    for (const site of rules) {
        if (!site.record || known.has(site.record)) continue;
        const labels = outputLabels(parsePromQL(site.expr), known);
        if (labels) known.set(site.record, { labels, counterLike: false, source: `recording rule (${site.where})` });
    }
}

const describeValues = (v: ValueSet): string => (v.open ? 'any value' : `{${[...v.values].join(', ')}}`);

function closestNames(name: string): string {
    const stem = name.replace(/_(total|bucket|sum|count|ratio)$/, '');
    const near = [...known.keys()].filter((k) => k.startsWith(stem) || stem.startsWith(k.replace(/_(total|bucket|sum|count|ratio)$/, ''))).slice(0, 4);
    return near.length > 0 ? ` (exported names near it: ${near.join(', ')})` : '';
}

function markdownSlugs(md: string): Set<string> {
    const slugs = new Set<string>();
    let fenced = false;
    for (const line of md.split('\n')) {
        if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
        if (fenced) continue;
        const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
        if (!h) continue;
        slugs.add(h[1].trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '').replace(/ /g, '-'));
    }
    return slugs;
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe('the translation this test reproduces is the one the stack runs', () => {
    it('pins the collector and Prometheus images the translation was read from', () => {
        // A bump is welcome — it just has to bring this file with it. Re-read
        // pkg/translator/prometheus (or prometheus/otlptranslator, which newer
        // releases use) at the new tag, and the generated telemetry of the
        // collector's helpers, then update the translation and externalSeries().
        expect({
            collector: compose.services['otel-collector']?.image,
            prometheus: compose.services.prometheus?.image,
        }).toEqual({ collector: PINNED_COLLECTOR_IMAGE, prometheus: PINNED_PROMETHEUS_IMAGE });
    });

    it('runs the Prometheus exporter with the options the translation assumes', () => {
        const exporter = collectorConfig.exporters[appMetricsExporter().name];
        expect({
            namespace: exporter.namespace ?? null,
            addMetricSuffixes: exporter.add_metric_suffixes ?? true,
            resourceToTelemetry: exporter.resource_to_telemetry_conversion?.enabled === true,
        }).toEqual({ namespace: null, addMetricSuffixes: true, resourceToTelemetry: true });
    });

    it('reproduces normalizeName for the cases the rules depend on', () => {
        // Cases copied from the translator's own tests at v0.123.0
        // (normalize_name_test.go, normalize_label_test.go).
        const cases: Array<[string, Kind, string, string]> = [
            ['system.filesystem.usage', 'gauge', 'By', 'system_filesystem_usage_bytes'],
            ['system.io', 'counter', 'By', 'system_io_bytes_total'],
            ['system.network.dropped', 'counter', '{packets}', 'system_network_dropped_total'],
            ['hw.gpu.memory.utilization', 'gauge', '1', 'hw_gpu_memory_utilization_ratio'],
            ['hw.fan.speed_ratio', 'gauge', '1', 'hw_fan_speed_ratio'],
            ['objects', 'counter', '1', 'objects_total'],
            ['broken.metric.speed', 'gauge', 'km/h', 'broken_metric_speed_km_per_hour'],
            ['active_directory.ds.ldap.bind.last_successful.time', 'gauge', 'ms', 'active_directory_ds_ldap_bind_last_successful_time_milliseconds'],
            ['system.cpu.load_average.15m', 'gauge', '1', 'system_cpu_load_average_15m_ratio'],
            ['mongodbatlas.process.network.io', 'gauge', 'By/s', 'mongodbatlas_process_network_io_bytes_per_second'],
        ];
        expect(cases.map(([name, kind, unit]) => prometheusName(name, kind, unit))).toEqual(cases.map((c) => c[3]));
        expect(['_test', '0test', 'test_/', '__test'].map(prometheusLabel)).toEqual(['key_test', 'key_0test', 'test__', '__test']);
    });
});

describe('the app instruments are read from source, all of them', () => {
    it('resolves every instrument the observability modules declare', () => {
        // The denominator: a declaration the scan cannot name is a metric
        // that would silently be missing from the catalogue.
        const unresolvedInObservability = instrumentCatalogue.unresolvedDeclarations.filter((w) =>
            /^src\/lib\/observability\/(metrics|business-metrics)\.ts:/.test(w),
        );
        expect(unresolvedInObservability).toEqual([]);
        const counts = ['src/lib/observability/metrics.ts', 'src/lib/observability/business-metrics.ts'].map((f) => ({
            file: f,
            ...instrumentCatalogue.declarationCounts.get(f),
        }));
        for (const c of counts) {
            expect(c.calls).toBeGreaterThan(0);
            expect(c.resolved).toBe(c.calls);
        }
    });

    it('reads the labels of every instrument a rule or panel selects', () => {
        const problems: string[] = [];
        const selected = new Set<Instrument>();
        for (const site of allSites) {
            for (const s of parsePromQL(site.expr).selectors) {
                const inst = catalogue.get(s.name)?.instrument;
                if (inst) selected.add(inst);
            }
        }
        for (const inst of selected) {
            if (inst.sites === 0) problems.push(`${inst.name}: no .add/.record/.observe found, so its labels are unknown`);
            for (const w of inst.unresolvedSites) problems.push(`${inst.name}: attributes at ${w} are not readable`);
        }
        expect(problems).toEqual([]);
    });

    it('selects only instruments something in src/ or scripts/ actually records', () => {
        const problems: string[] = [];
        for (const site of allSites) {
            for (const s of parsePromQL(site.expr).selectors) {
                const inst = catalogue.get(s.name)?.instrument;
                if (!inst || inst.sites === 0) continue;
                if (![...inst.recordedFrom].some(isCalled)) {
                    problems.push(`${site.where}: \`${s.name}\` (${inst.name}) is recorded only inside ${[...inst.recordedFrom].join(', ')}, which nothing outside tests calls — the app never emits it`);
                }
            }
        }
        expect(problems).toEqual([]);
    });
});

describe('every query selects what the stack exports', () => {
    it('finds the rule files and dashboards it checks', () => {
        expect(ruleFiles.length).toBeGreaterThan(0);
        expect(dashboardFiles.length).toBeGreaterThan(0);
        expect(rules.filter((r) => r.record).length).toBeGreaterThan(0);
        expect(panels.length).toBeGreaterThan(0);
    });

    it('selects only metric names that are exported', () => {
        const problems: string[] = [];
        const recordingRules = new Set(rules.map((r) => r.record).filter((r): r is string => r !== undefined));
        for (const site of allSites) {
            for (const s of parsePromQL(site.expr).selectors) {
                if (known.has(s.name)) continue;
                problems.push(
                    recordingRules.has(s.name)
                        ? `${site.where}: selects recording rule \`${s.name}\`, whose own query selects something nothing exports`
                        : `${site.where}: selects \`${s.name || '{…}'}\`, which nothing exports${closestNames(s.name)}`,
                );
            }
        }
        expect(problems).toEqual([]);
    });

    it('matches only on labels those metrics carry, and on values they can take', () => {
        const problems: string[] = [];
        for (const site of allSites) {
            for (const s of parsePromQL(site.expr).selectors) {
                const info = known.get(s.name);
                if (!info) continue;
                for (const m of s.matchers) {
                    const values = info.labels.get(m.label);
                    if (!values) {
                        problems.push(`${site.where}: \`${s.name}\` has no label \`${m.label}\` (it has: ${[...info.labels.keys()].sort().join(', ')})`);
                        continue;
                    }
                    if (values.open) continue;
                    const can =
                        m.op === '=' ? values.values.has(m.value)
                        : m.op === '=~' ? [...values.values].some((v) => new RegExp(`^(?:${m.value})$`).test(v))
                        : true;
                    if (!can) problems.push(`${site.where}: \`${s.name}{${m.label}${m.op}"${m.value}"}\` can never match; \`${m.label}\` takes ${describeValues(values)}`);
                }
            }
        }
        expect(problems).toEqual([]);
    });

    it('groups only by labels the selected metrics carry', () => {
        const problems: string[] = [];
        for (const site of allSites) {
            const q = parsePromQL(site.expr);
            const labels = selectedLabels(q, known);
            if (!labels) continue;
            for (const l of q.grouping) {
                if (!labels.has(l)) problems.push(`${site.where}: groups by \`${l}\`, which no selected series carries (they have: ${[...labels.keys()].sort().join(', ')})`);
            }
        }
        expect(problems).toEqual([]);
    });

    it('names in templates only labels the query returns', () => {
        // `{{ $labels.x }}` in an alert annotation, `{{x}}` in a legend.
        const problems: string[] = [];
        for (const site of allSites) {
            const out = outputLabels(parsePromQL(site.expr), known);
            if (!out) continue;
            for (const l of site.templateLabels) {
                if (!out.has(l)) problems.push(`${site.where}: renders \`${l}\`, but the query returns only {${[...out.keys()].sort().join(', ')}}`);
            }
        }
        expect(problems).toEqual([]);
    });

    it('takes rate()/increase() only of counters and histogram series', () => {
        const problems: string[] = [];
        for (const site of allSites) {
            for (const s of parsePromQL(site.expr).selectors) {
                const info = known.get(s.name);
                if (info && s.fn && COUNTER_FUNCTIONS.has(s.fn) && !info.counterLike) {
                    problems.push(`${site.where}: ${s.fn}(${s.name}) — \`${s.name}\` is a gauge (${info.source})`);
                }
            }
        }
        expect(problems).toEqual([]);
    });
});

describe('every alert points somewhere real', () => {
    it('links runbook_url only to a heading in a doc this repository holds', () => {
        const problems: string[] = [];
        for (const site of rules) {
            const url = site.runbookUrl;
            if (url === undefined) continue;
            if (!url.startsWith(RUNBOOK_URL_PREFIX)) {
                problems.push(`${site.where}: runbook_url ${url} is not under ${RUNBOOK_URL_PREFIX}`);
                continue;
            }
            const [docPath, anchor] = url.slice(RUNBOOK_URL_PREFIX.length).split('#');
            if (!files.includes(docPath)) {
                problems.push(`${site.where}: runbook_url names ${docPath}, which is not in the repository`);
                continue;
            }
            if (anchor !== undefined && !markdownSlugs(read(docPath)).has(anchor)) {
                problems.push(`${site.where}: runbook_url anchor #${anchor} is not a heading in ${docPath}`);
            }
        }
        expect(problems).toEqual([]);
    });
});
