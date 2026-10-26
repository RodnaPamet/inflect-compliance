/**
 * Epic OI-3 — the external uptime contract.
 *
 * Locks:
 *   - external-uptime.yml targets /api/readyz (NOT /api/livez) — see the
 *     block at the bottom for why this INVERTED on 2026-09-22 (#2745)
 *   - it names the provisioned GCP check and policy, probes from several
 *     regions, and states the deployed policy's window and duration
 *
 * This file also held the alert rules and receivers of infra/alerts/rules.yml
 * and receivers.yml: a Prometheus rule set and an Alertmanager config that no
 * running system loaded. Both were deleted on 2026-10-26. The rules the
 * Prometheus stack loads are held to the app's metrics by
 * tests/unit/prometheus-rules-match-emitted-metrics.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

describe('OI-3 — external uptime contract', () => {
    interface UptimeMonitor {
        name: string;
        url: string;
        gcp_uptime_check_id: string;
        interval_seconds: number;
        locations_observed: string[];
        expect: { status_class?: string; body_contains?: string; ssl_valid?: boolean };
        on_failure: { alert_policy: string; alert_policy_id: string; condition: string };
    }
    interface UptimeFile {
        metadata: { product: string; provider: string; deployment: string };
        monitors: UptimeMonitor[];
    }

    function loadUptime(): UptimeFile {
        return yaml.load(read('infra/alerts/external-uptime.yml')) as UptimeFile;
    }

    it('parses as YAML and has at least one monitor', () => {
        const u = loadUptime();
        expect(Array.isArray(u.monitors)).toBe(true);
        expect(u.monitors.length).toBeGreaterThan(0);
    });

    /**
     * THIS ASSERTION IS THE INVERSE OF WHAT IT USED TO BE, DELIBERATELY.
     *
     * Until 2026-09-22 this guard required `/api/livez` and FORBADE
     * `/api/readyz`, on reasoning imported from a Kubernetes deployment:
     * readyz 503s were called "noise" because k8s rotates traffic away from a
     * NotReady pod while other replicas serve.
     *
     * inflect-compliance has no pods, no replicas and no load balancer — one
     * app container on one GCE VM. Nothing rotates traffic anywhere, so a
     * readyz 503 is users getting errors.
     *
     * And `livez` is dependency-free: it answers 200 whenever the process is
     * running. On 2026-09-20 redis crash-looped for 39 hours; a livez monitor
     * would have stayed green throughout. The old guard was pinning the
     * failure mode in place.
     *
     * If this product ever grows replicas, re-derive the reasoning — do not
     * simply flip it back.
     */
    it('every monitor targets /api/readyz, NOT the dependency-free /api/livez', () => {
        const u = loadUptime();
        for (const m of u.monitors) {
            expect(m.url).toMatch(/\/api\/readyz$/);
            expect(m.url).not.toMatch(/\/api\/livez/);
        }
    });

    /**
     * The matcher is compared BYTE-FOR-BYTE against what the route actually
     * emits. `"status": "ready"` (with a space) never matches the real body,
     * and a content matcher that can never match is a check that is
     * permanently failing — noise, which gets muted, which is how you arrive
     * back at no alerting at all.
     */
    it('expects a 2xx and the exact readyz body substring, with no space after the colon', () => {
        const u = loadUptime();
        for (const m of u.monitors) {
            expect(m.expect.status_class).toBe('2xx');
            expect(m.expect.body_contains).toBe('"status":"ready"');
            expect(m.expect.body_contains).not.toContain('": "');
            expect(m.expect.ssl_valid).toBe(true);
        }
    });

    /**
     * The file must name the REAL provisioned resources. A contract that
     * describes a monitor nobody created is what this file was for four
     * months, and it read exactly like a monitor that existed.
     */
    it('names the provisioned GCP check and alert policy by id', () => {
        const u = loadUptime();
        expect(u.metadata.provider).toMatch(/GCP Cloud Monitoring/i);
        for (const m of u.monitors) {
            expect(m.gcp_uptime_check_id).toMatch(/^[a-z0-9-]+-[A-Za-z0-9_-]{8,}$/);
            expect(m.on_failure.alert_policy_id).toMatch(/^\d{15,}$/);
        }
    });

    it('probes from multiple regions, and does not alert on a single region failing', () => {
        const u = loadUptime();
        for (const m of u.monitors) {
            expect(m.locations_observed.length).toBeGreaterThan(1);
            // One region failing is a network partition to that region; two is
            // the service. Verified live: sa-brazil-sao_paulo times out against
            // app.inflect.bg while the other five pass, so a `> 0` threshold
            // would page continuously for a reachability quirk. See #2752.
            expect(m.on_failure.condition).toMatch(/COUNT_FALSE > 1/);
        }
    });

    /**
     * The record's condition must say what the deployed policy does. On
     * 2026-09-24 the policy's duration went from 60s to 300s (a deploy took
     * readyz down long enough to page on every deploy), and this file went on
     * saying `for 60s` for a month. Read from the policy file, so the two
     * cannot drift apart again without this failing.
     */
    it("states the deployed policy's window and duration in its condition", () => {
        const u = loadUptime();
        const policies = fs
            .readdirSync(path.join(ROOT, 'infra/alerts/policies'))
            .filter((f) => f.endsWith('.json'))
            .map((f) => JSON.parse(read(`infra/alerts/policies/${f}`)));
        for (const m of u.monitors) {
            const policy = policies.find((p) => p.displayName === m.on_failure.alert_policy);
            expect(policy).toBeDefined();
            const threshold = policy.conditions[0].conditionThreshold;
            const window = threshold.aggregations[0].alignmentPeriod;
            expect(m.on_failure.condition).toBe(`COUNT_FALSE > 1 over a ${window} window, for ${threshold.duration}`);
        }
    });

    it('records that no rota exists, so nobody reads a response time into it', () => {
        const src = read('infra/alerts/external-uptime.yml');
        expect(src).toMatch(/not.*a rota|no rota/i);
    });
});
