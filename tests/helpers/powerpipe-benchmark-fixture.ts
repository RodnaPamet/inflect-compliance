/**
 * Powerpipe `benchmark run --output json` fixtures — the REAL wire shape.
 *
 * WHY THIS FILE EXISTS. Every posture fixture used to be written inline beside
 * the parser's own assumption (`summary: { status: { ok: 1 } }`), so the suite
 * validated the parser against itself and no amount of green here was evidence
 * about real collector output. It was wrong: that nesting belongs to a GROUP,
 * not a control. Builders live here, once, so a fixture cannot drift back into
 * agreement with the parser.
 *
 * PROVENANCE — every key below is taken from turbot/powerpipe @ main, read on
 * 2026-09-04. The JSON is rendered by a text/template, so the TEMPLATE is the
 * authority for key names and the struct tags for each value's shape:
 *
 *   internal/controldisplay/templates/json/output.tmpl
 *     - "output" applies "result_group_template" to `.Data.Root`, so the
 *       top-level object IS a result group.
 *     - result_group_template emits:
 *         group_id, title, description, tags, summary, groups, controls
 *       `groups` renders `[]` and `controls` renders `null` when empty.
 *     - control_run_template emits:
 *         summary, results, control_id, description, severity, tags, title,
 *         run_status, run_error
 *       `results` renders `null` — not `[]` — when the control has no rows.
 *     - control_row_template emits: reason, resource, status, dimensions
 *     - run_status_map: "complete" -> 4, "error" -> 8
 *
 *   internal/controlstatus/status_summary.go
 *       type StatusSummary struct {
 *           Alarm int `json:"alarm"`
 *           Ok    int `json:"ok"`
 *           Info  int `json:"info"`
 *           Skip  int `json:"skip"`
 *           Error int `json:"error"`
 *       }
 *     A CONTROL's `summary` is this struct directly — FLAT.
 *
 *   internal/controlexecute/result_group.go
 *       type GroupSummary struct {
 *           Status   controlstatus.StatusSummary            `json:"status"`
 *           Severity map[string]controlstatus.StatusSummary `json:"-"`
 *       }
 *     A GROUP's `summary` nests its counters under "status". The two shapes
 *     genuinely differ; that is the trap this file exists to hold open.
 *
 *   internal/controlexecute/control_run.go
 *       Summary   *controlstatus.StatusSummary `json:"summary"`
 *       RunStatus dashboardtypes.RunStatus     `json:"status"`
 *     `setError` does `r.Summary.Error++`, sets `RunErrorString`, and moves
 *     RunStatus to "error" — the errored control below is that state.
 */

/** A row status Powerpipe can put on a result row. */
export type PowerpipeRowStatus = 'ok' | 'alarm' | 'skip' | 'info' | 'error';

/** `controlstatus.StatusSummary` — flat, five counters, always all five keys. */
export interface PowerpipeStatusSummary {
    alarm: number;
    ok: number;
    info: number;
    skip: number;
    error: number;
}

export interface PowerpipeRow {
    reason: string;
    resource: string;
    status: PowerpipeRowStatus;
    dimensions: unknown[];
}

export interface PowerpipeControl {
    summary: PowerpipeStatusSummary;
    results: PowerpipeRow[] | null;
    control_id: string;
    description: string;
    severity: string;
    tags: Record<string, string>;
    title: string;
    run_status: number;
    run_error: string;
}

export interface PowerpipeGroup {
    group_id: string;
    title: string;
    description: string;
    tags: Record<string, string>;
    /** A GROUP nests its counters under "status" — unlike a control. */
    summary: { status: PowerpipeStatusSummary };
    groups: PowerpipeGroup[];
    controls: PowerpipeControl[] | null;
}

/** RunStatus "complete" / "error" as the JSON template numbers them. */
export const POWERPIPE_RUN_COMPLETE = 4;
export const POWERPIPE_RUN_ERROR = 8;

const zeroCounts = (): PowerpipeStatusSummary => ({ alarm: 0, ok: 0, info: 0, skip: 0, error: 0 });

/** Counters for a control that produced `n` rows all carrying `status`. */
export function powerpipeCounts(status: PowerpipeRowStatus, n = 1): PowerpipeStatusSummary {
    return { ...zeroCounts(), [status]: n };
}

/**
 * A completed control carrying one row of `status` — the ordinary case.
 * Its counters are FLAT, matching `controlstatus.StatusSummary`.
 */
export function powerpipeControl(
    controlId: string,
    status: PowerpipeRowStatus,
    over: Partial<PowerpipeControl> = {},
): PowerpipeControl {
    const qualified = controlId.includes('.') ? controlId : `aws_compliance.control.${controlId}`;
    return {
        summary: powerpipeCounts(status),
        results: [
            { reason: `${status} reason`, resource: `resource/${controlId}`, status, dimensions: [] },
        ],
        control_id: qualified,
        description: '',
        severity: 'medium',
        tags: {},
        title: controlId,
        run_status: POWERPIPE_RUN_COMPLETE,
        run_error: '',
        ...over,
    };
}

/**
 * A control whose query FAILED — the `setError` state. Powerpipe increments
 * `Summary.Error`, records the message, and marks the run errored; because the
 * query never returned, there are no rows and `results` renders as `null`.
 *
 * This is the object the #2301 investigation saw for every control of a
 * benchmark run with a revoked credential.
 */
export function powerpipeErroredControl(
    controlId: string,
    message = 'operation error STS: GetCallerIdentity, https response error StatusCode: 403, api error InvalidClientTokenId: The security token included in the request is invalid',
): PowerpipeControl {
    return powerpipeControl(controlId, 'error', {
        summary: { ...zeroCounts(), error: 1 },
        results: null,
        run_status: POWERPIPE_RUN_ERROR,
        run_error: message,
    });
}

/**
 * A control that ran cleanly and matched NO resources: every counter zero and
 * no rows. Distinct from an errored control — the collector answered, there was
 * simply nothing in scope.
 */
export function powerpipeEmptyControl(controlId: string): PowerpipeControl {
    return powerpipeControl(controlId, 'ok', { summary: zeroCounts(), results: null });
}

/** Sum a group's descendants into the nested counter block a group carries. */
function groupCounts(groups: PowerpipeGroup[], controls: PowerpipeControl[] | null): PowerpipeStatusSummary {
    const total = zeroCounts();
    const add = (s: PowerpipeStatusSummary) => {
        for (const k of Object.keys(total) as Array<keyof PowerpipeStatusSummary>) total[k] += s[k];
    };
    for (const c of controls ?? []) add(c.summary);
    for (const g of groups) add(g.summary.status);
    return total;
}

/** A result group. Note the counters nest under "status" — group shape. */
export function powerpipeGroup(
    groupId: string,
    children: { groups?: PowerpipeGroup[]; controls?: PowerpipeControl[] },
    over: Partial<PowerpipeGroup> = {},
): PowerpipeGroup {
    const groups = children.groups ?? [];
    const controls = children.controls ?? null;
    return {
        group_id: groupId,
        title: groupId,
        description: '',
        tags: {},
        summary: { status: groupCounts(groups, controls) },
        groups,
        controls,
        ...over,
    };
}

/**
 * The whole document: the root object IS a group, so a benchmark run's JSON is
 * exactly one `powerpipeGroup` — there is no wrapper key around it.
 */
export function powerpipeBenchmark(
    benchmarkId: string,
    children: { groups?: PowerpipeGroup[]; controls?: PowerpipeControl[] },
): PowerpipeGroup {
    return powerpipeGroup(benchmarkId, children);
}

/** The same document as the string a collector actually writes to stdout. */
export function powerpipeBenchmarkJson(
    benchmarkId: string,
    children: { groups?: PowerpipeGroup[]; controls?: PowerpipeControl[] },
): string {
    return JSON.stringify(powerpipeBenchmark(benchmarkId, children));
}

/**
 * The GROUP-shaped summary a control must never be given. Held here as a named
 * negative so a test can assert the parser refuses it, and so nobody rebuilds it
 * by hand believing it is the control shape.
 */
export function groupShapedControlSummary(status: PowerpipeRowStatus): { status: PowerpipeStatusSummary } {
    return { status: powerpipeCounts(status) };
}
