// k6 load-test scenario — authenticated list-read baseline.
//
// Each VU logs in once at iteration 0 and reuses the resulting
// session-token cookie (carried automatically by the per-VU jar)
// for all subsequent iterations, so we measure the steady-state
// list-read path rather than the cold login path. (auth.js covers
// the cold-login throughput separately.)
//
// Per iteration each VU exercises the three highest-traffic list
// endpoints with realistic filter combinations:
//
//   GET /api/t/{slug}/controls  — paged + filtered (status, q, applicability)
//   GET /api/t/{slug}/risks     — paged + filtered (scoreMin/Max, q)
//   GET /api/t/{slug}/evidence  — paged + filtered (status, archived)
//
// Run staged baselines:
//   k6 run -e VUS=50  -e DURATION=2m tests/load/lists.js
//   k6 run -e VUS=100 -e DURATION=2m tests/load/lists.js
//   k6 run -e VUS=200 -e DURATION=2m tests/load/lists.js
//
// The seed (`prisma/seed.ts`) creates a small but non-empty dataset
// in `acme-corp`: ~4 controls, ~4 risks, plus assets and templates.
// Run the same script against a heavier seed for realistic baselines
// — see tests/load/README.md.

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { textSummary } from './vendor/k6-summary.js';
import { loadConfig } from './lib/config.js';
import { login } from './lib/auth.js';

const cfg = loadConfig();

// Per-endpoint counters so the summary breaks throughput out by surface.
const controlsRequests = new Counter('list_controls_requests');
const risksRequests = new Counter('list_risks_requests');
const evidenceRequests = new Counter('list_evidence_requests');
const listSuccessRate = new Rate('list_success_rate');

// Per-VU module state — k6 loads each module once per VU init, so a
// top-level `let` is effectively a per-VU singleton. Used to gate the
// once-per-VU login.
let loggedIn = false;

export const options = {
    scenarios: {
        list_baseline: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: cfg.rampUp, target: cfg.vus },
                { duration: cfg.duration, target: cfg.vus },
                { duration: cfg.rampDown, target: 0 },
            ],
            gracefulRampDown: '30s',
            gracefulStop: '30s',
        },
    },
    thresholds: {
        // Read-path error budget. Anything above 1% is a real problem.
        'http_req_failed{type:list}': ['rate<0.01'],

        // Per-endpoint latency budgets. p95 < 800ms covers a healthy
        // DB-backed paginated list with auth + tenant-RLS overhead.
        'http_req_duration{endpoint:controls}': ['p(95)<800', 'p(99)<2000'],
        'http_req_duration{endpoint:risks}': ['p(95)<800', 'p(99)<2000'],
        'http_req_duration{endpoint:evidence}': ['p(95)<800', 'p(99)<2000'],

        // Aggregate success rate across all list endpoints.
        list_success_rate: ['rate>0.99'],

        // Per-endpoint check rates.
        'checks{check:controls_ok}': ['rate>0.99'],
        'checks{check:risks_ok}': ['rate>0.99'],
        'checks{check:evidence_ok}': ['rate>0.99'],

        // Login-step health (gate the warm-up, not the steady state).
        'http_req_failed{step:login}': ['rate<0.05'],
    },
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
    discardResponseBodies: false,
};

// Realistic filter sets — rotated per iteration so we don't hammer
// a single query plan. Covers: empty filter, narrow text search, and
// status/score-band filters that exercise different index paths.
const CONTROLS_FILTERS = [
    'limit=50',
    'limit=50&status=IMPLEMENTED',
    'limit=50&q=security',
    // `category` was dropped here (roadmap P3.4): the Category column shows a
    // DERIVED value, the raw server filter that this exercised is gone, and
    // the route schema `.strip()`s unknown keys — so it kept "passing" while
    // measuring an unfiltered query.
    //
    // `applicability` replaces it and is worth more: it is now a real
    // server-side predicate over two columns, and the multi-select form below
    // exercises the OR branch that the single-value form does not.
    'limit=50&applicability=APPLICABLE',
    'limit=50&applicability=NOT_APPLICABLE,UNASSESSED',
    'limit=20&q=policy',
];

const RISKS_FILTERS = [
    'limit=50',
    'limit=50&scoreMin=10&scoreMax=25',
    'limit=50&status=OPEN',
    'limit=50&q=data',
    'limit=20&category=Cybersecurity',
];

const EVIDENCE_FILTERS = [
    'limit=50',
    'limit=50&status=APPROVED',
    'limit=50&archived=false',
    'limit=50&expiring=true',
    'limit=20&q=audit',
];

function pickFilter(filters, iter) {
    return filters[iter % filters.length];
}

export default function listsIteration() {
    // ── Per-VU one-time login ──
    if (!loggedIn) {
        const ok = login(cfg);
        if (!ok) {
            // No point in this VU running list scenarios without a
            // session — let the iteration return so the threshold on
            // login_failed picks it up rather than spamming 401s.
            sleep(1);
            return;
        }
        loggedIn = true;
    }

    // Use the per-VU default jar — it now carries the session cookie
    // from the login call above and will attach it to every request.
    const iter = __ITER;
    const base = `${cfg.baseUrl}/api/t/${cfg.tenant}`;

    group('list:controls', () => {
        const url = `${base}/controls?${pickFilter(CONTROLS_FILTERS, iter)}`;
        const r = http.get(url, {
            tags: { type: 'list', endpoint: 'controls' },
        });
        const ok = check(
            r,
            {
                'controls 200': (res) => res.status === 200,
                'controls is JSON': (res) => {
                    try {
                        const j = res.json();
                        // Shape can be an array (legacy) or
                        // { items, nextCursor } (paginated). Both valid.
                        return Array.isArray(j) || typeof j === 'object';
                    } catch (_e) {
                        return false;
                    }
                },
            },
            { check: 'controls_ok' },
        );
        controlsRequests.add(1);
        listSuccessRate.add(ok);
    });

    group('list:risks', () => {
        const url = `${base}/risks?${pickFilter(RISKS_FILTERS, iter)}`;
        const r = http.get(url, {
            tags: { type: 'list', endpoint: 'risks' },
        });
        const ok = check(
            r,
            {
                'risks 200': (res) => res.status === 200,
                'risks is JSON': (res) => {
                    try {
                        const j = res.json();
                        return Array.isArray(j) || typeof j === 'object';
                    } catch (_e) {
                        return false;
                    }
                },
            },
            { check: 'risks_ok' },
        );
        risksRequests.add(1);
        listSuccessRate.add(ok);
    });

    group('list:evidence', () => {
        const url = `${base}/evidence?${pickFilter(EVIDENCE_FILTERS, iter)}`;
        const r = http.get(url, {
            tags: { type: 'list', endpoint: 'evidence' },
        });
        const ok = check(
            r,
            {
                'evidence 200': (res) => res.status === 200,
                'evidence is JSON': (res) => {
                    try {
                        const j = res.json();
                        return Array.isArray(j) || typeof j === 'object';
                    } catch (_e) {
                        return false;
                    }
                },
            },
            { check: 'evidence_ok' },
        );
        evidenceRequests.add(1);
        listSuccessRate.add(ok);
    });

    // 250ms think-time per iteration. With 50 VUs this is ~200 RPS
    // across all three endpoints (~67 RPS each). Tune via DURATION
    // or by adjusting this sleep if you want sharper or softer load.
    sleep(0.25);
}

export function handleSummary(data) {
    return {
        stdout: textSummary(data, { indent: ' ', enableColors: true }),
        'tests/load/results/lists-summary.json': JSON.stringify(data, null, 2),
    };
}
