// k6 load-test scenario — authentication baseline.
//
// Exercises the full NextAuth v4 credentials login on every VU
// iteration so we can baseline:
//   - throughput  (logins/second sustained)
//   - p95 latency on each step (csrf, callback/credentials, session)
//   - end-to-end auth latency (csrf + login + session verify)
//   - error rate under ramping load
//
// Each iteration uses a FRESH per-iteration cookie jar so we measure
// the cold-start login path, not session reuse — that's the worst
// case the auth stack must support during a thundering-herd login
// burst (e.g. SSO outage recovery, mass password reset).
//
// Run baselines:
//   k6 run -e VUS=50  -e DURATION=2m tests/load/auth.js
//   k6 run -e VUS=100 -e DURATION=2m tests/load/auth.js
//   k6 run -e VUS=200 -e DURATION=2m tests/load/auth.js
//
// Required env on the SUT:
//   AUTH_TEST_MODE=1      — disables the progressive-lockout policy
//                           (3 fails = 5s, 5 = 30s, 10 = 15min lock).
//                           Bcrypt is the bottleneck under load and
//                           the lockout would otherwise kill the run.
//   RATE_LIMIT_ENABLED=0  — bypasses the API rate-limit middleware
//                           so auth endpoint latency reflects only
//                           the auth path itself, not the limiter.
//
// See tests/load/README.md for the full runbook.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { textSummary } from './vendor/k6-summary.js';
import { loadConfig } from './lib/config.js';

const cfg = loadConfig();

// Custom end-to-end latency metric — k6's built-in http_req_duration
// is per-request; we want one number for the whole login transaction.
const authFullLoginMs = new Trend('auth_full_login_ms', true);
const authSuccessCount = new Counter('auth_success_count');
const authFailureCount = new Counter('auth_failure_count');

export const options = {
    scenarios: {
        login_baseline: {
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
    // Hard pass/fail gates. A failed threshold marks the run as failed
    // (non-zero exit code in CI), even if individual checks pass.
    thresholds: {
        // No CSRF endpoint should ever 5xx — it's a flat read.
        'http_req_failed{step:csrf}': ['rate<0.01'],
        // Login may fail occasionally under load; 1% is the SLO ceiling.
        'http_req_failed{step:login}': ['rate<0.01'],
        // Session check must be reliable.
        'http_req_failed{step:session}': ['rate<0.01'],

        // Latency budgets per step. CSRF is a flat read so should be fast;
        // login is bcrypt-bound so gets a much wider budget.
        'http_req_duration{step:csrf}': ['p(95)<500'],
        'http_req_duration{step:login}': ['p(95)<1500', 'p(99)<3000'],
        'http_req_duration{step:session}': ['p(95)<500'],

        // End-to-end login transaction: 3 sequential requests with
        // bcrypt in the middle. 2s p95 is generous-but-realistic.
        auth_full_login_ms: ['p(95)<2000', 'p(99)<4000'],

        // Check rates — one failed check shouldn't tank the run, but
        // sustained failure (>1%) means something's broken.
        'checks{probe:csrf}': ['rate>0.99'],
        'checks{probe:login}': ['rate>0.99'],
        'checks{probe:session}': ['rate>0.99'],
    },
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
    // Cookie jar isolation: each iteration creates its own jar inside
    // the default function so we measure cold-start login every time.
    discardResponseBodies: false,
};

export default function authIteration() {
    // Per-iteration jar — guarantees no carry-over from a previous
    // iteration's session cookie. This is what makes the run a real
    // login-throughput test rather than a session-reuse test.
    const jar = http.cookieJar();
    const params = { jar };

    const t0 = Date.now();

    // ── 1. CSRF token ──
    const csrfRes = http.get(`${cfg.baseUrl}/api/auth/csrf`, {
        ...params,
        tags: { step: 'csrf' },
    });
    const csrfOk = check(
        csrfRes,
        {
            'csrf 200': (r) => r.status === 200,
            'csrf has token': (r) => {
                try {
                    const t = r.json('csrfToken');
                    return typeof t === 'string' && t.length > 0;
                } catch (_e) {
                    return false;
                }
            },
        },
        { probe: 'csrf' },
    );
    if (!csrfOk) {
        authFailureCount.add(1);
        sleep(1);
        return;
    }
    const csrfToken = csrfRes.json('csrfToken');

    // ── 2. POST credentials ──
    const loginRes = http.post(
        `${cfg.baseUrl}/api/auth/callback/credentials`,
        {
            csrfToken,
            email: cfg.email,
            password: cfg.password,
            callbackUrl: `${cfg.baseUrl}/dashboard`,
            json: 'true',
        },
        { ...params, tags: { step: 'login' } },
    );
    const loginOk = check(
        loginRes,
        {
            'login 2xx': (r) => r.status >= 200 && r.status < 400,
            'login no error url': (r) => {
                try {
                    const u = r.json('url');
                    return typeof u === 'string' && !u.includes('error=');
                } catch (_e) {
                    return false;
                }
            },
        },
        { probe: 'login' },
    );
    if (!loginOk) {
        authFailureCount.add(1);
        sleep(1);
        return;
    }

    // ── 3. Verify session is live ──
    const sessionRes = http.get(`${cfg.baseUrl}/api/auth/session`, {
        ...params,
        tags: { step: 'session' },
    });
    const sessionOk = check(
        sessionRes,
        {
            'session 200': (r) => r.status === 200,
            'session has user': (r) => {
                try {
                    const email = r.json('user.email');
                    return typeof email === 'string' && email.length > 0;
                } catch (_e) {
                    return false;
                }
            },
        },
        { probe: 'session' },
    );

    if (sessionOk) {
        authSuccessCount.add(1);
        authFullLoginMs.add(Date.now() - t0);
    } else {
        authFailureCount.add(1);
    }

    // 1s think-time per VU. With 50 VUs this is ~50 logins/sec
    // sustained — a deliberately steep auth load.
    sleep(1);
}

export function handleSummary(data) {
    return {
        stdout: textSummary(data, { indent: ' ', enableColors: true }),
        'tests/load/results/auth-summary.json': JSON.stringify(data, null, 2),
    };
}
