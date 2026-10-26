/**
 * Epic OI-3 — runbook + SLOs ratchet (final OI-3 layer).
 *
 * Locks both docs against drift AND asserts the alignment between
 * the docs and the underlying machinery shipped across OI-1/OI-2/OI-3:
 *
 *   - SLOs cover the 4 OI-3-spec targets (availability, read+write
 *     latency split, RPO 1h, RTO 4h)
 *   - Each SLO references the metric/mechanism that powers it
 *   - Incident-response.md has the 7 required playbooks
 *   - Its quick reference routes every deployed GCP alert policy
 *     (`infra/alerts/policies/*.json`) by display name, and App Down
 *     probes the path the uptime contract probes
 *   - The runbook keeps its "Operational alignment" section
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { headingLines, mdSection } from '../helpers/markdown-regions';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

/**
 * #2246 Class A — NARROWED, NOT MASKED, and on this file the difference is
 * the whole point.
 *
 * Both documents this guard reads are long (672 and 702 lines) and every
 * assertion below names ONE part of one of them: an SLO, a playbook, a
 * table. Read whole, a needle is satisfied by that text anywhere — a sibling
 * section, a fenced sample, or, as the RETIRED block further down records in
 * detail, a dated row in the CHANGELOG describing what some past epic did.
 * That is not hypothetical here: `/restore-test\.sh/`, `/helm rollback/` and
 * `/restore-db-instance/` all went on passing after the live text they
 * pinned had been corrected, because the changelog still said April.
 * Measured over the whole runbook, `--namespace inflect-production` matched
 * 20 times, `Rollback` 22, `Epic OI-3` 7, `PagerDuty incident` 5.
 *
 * The markdown MASKER cannot be the fix. `mdCodeOf` keeps a document's code
 * and blanks its prose, and measured across these two files it takes 25 of
 * the needles below to ZERO — every heading assertion, all seven
 * communication templates, both severity rows, the expand-and-contract
 * caveat, and the three Epic-OI-n references. Those assertions would have
 * read as converted while being unable to fail.
 *
 * So each read is bound to the region the test names in its own title:
 * `mdSection` for a section's content, `headingLines(doc, 2)` for the
 * assertions that are about the document HAVING a section rather than about
 * anything inside it. Both are fence-aware, which this runbook needs — it is
 * mostly shell, and a shell comment starts with `#`.
 *
 * Spelled out at every call site rather than behind a `section(heading)`
 * helper: `tests/helpers/assertion-reach.ts` tells a narrowing from a mask by
 * ARITY, and a one-argument wrapper reads as a mask.
 */

describe('OI-3 — SLOs (docs/slos.md)', () => {
    const SLO_DOC = 'docs/slos.md';

    it('exists', () => {
        expect(exists(SLO_DOC)).toBe(true);
    });

    it('declares availability ≥ 99.9% (OI-3 spec)', () => {
        // The existing SLO 1 (pre-OI-3) already covered availability.
        // Locked here so a future "simplify" PR can't drop the target.
        // Bound to SLO 1 — the figure appears 4 times across the document,
        // 3 of them here, so the target could have gone from its own SLO and
        // still matched from the summary table.
        const availability = mdSection(read(SLO_DOC), 'SLO 1: API Availability');
        expect(availability).toMatch(/99\.9\s*%/);
    });

    it('splits API latency into READS (<500ms) and WRITES (<1000ms) per OI-3 spec', () => {
        // The SPLIT is a claim about section structure: the doc must have
        // both SLOs as level-2 sections, not merely mention them in prose.
        const slos = headingLines(read(SLO_DOC), 2);
        expect(slos).toMatch(/SLO 2:\s*API Latency\s*[—-]\s*Reads/i);
        expect(slos).toMatch(/SLO 2b:\s*API Latency\s*[—-]\s*Writes/i);
        // Read target — inside the read SLO, not anywhere in the file.
        expect(mdSection(read(SLO_DOC), 'SLO 2: API Latency — Reads (P95)')).toMatch(
            /95th percentile of GET requests\s*<\s*500ms/i,
        );
        // Write target
        expect(mdSection(read(SLO_DOC), 'SLO 2b: API Latency — Writes (P95)')).toMatch(
            /95th percentile of state-mutating requests\s*<\s*1000ms/i,
        );
    });

    it('read latency formula filters by GET|HEAD method', () => {
        const reads = mdSection(read(SLO_DOC), 'SLO 2: API Latency — Reads (P95)');
        expect(reads).toMatch(/http_method=~"GET\|HEAD"/);
    });

    it('write latency formula filters by mutating methods', () => {
        const writes = mdSection(read(SLO_DOC), 'SLO 2b: API Latency — Writes (P95)');
        expect(writes).toMatch(/http_method=~"POST\|PUT\|PATCH\|DELETE"/);
    });

    // ── RETIRED 2026-09-02 (#2226): four assertions that pinned PROSE ──
    //
    // They required `docs/slos.md` to CONTAIN specific sentences:
    //
    //     /Maximum\s+1\s+hour\s+of\s+data\s+loss/     <- the RPO number
    //     /restore-test\.sh/                          <- the verification tool
    //     /helm rollback/  /restore-db-instance/      <- the recovery commands
    //
    // Every one of those facts was false. Production is a GCP VM with a daily
    // crash-consistent disk snapshot: real RPO is 24h, `archive_mode=off`,
    // `pg_stat_archiver.archived_count` is 0, `restore-test.sh` targeted an AWS
    // estate that was never applied, and there is no Kubernetes to `helm
    // rollback`. So a GREEN run of this guard was evidence that the SLO doc
    // still claimed a 1-hour RPO on RDS — the guard was holding the fiction in
    // place, and correcting the doc was what turned it red.
    //
    // Two of them were worse than merely wrong. `restore-test.sh`, `helm
    // rollback` and `restore-db-instance` all still appear in the doc's
    // CHANGELOG TABLE, in a dated 2026-04-27 row recording what that epic did.
    // So those two assertions kept passing after the live text was corrected,
    // satisfied by a line describing April. A grep cannot tell a present-tense
    // commitment from a historical note.
    //
    // Not replaced with corrected greps: that would recreate the same trap one
    // rewrite later. Per CLAUDE.md, "Never gate CI on prose — a check that
    // greps a markdown file verifies MENTION, not accuracy." Doc truth is
    // `tests/guardrails/docs-accuracy.test.ts` and human review; conduct is
    // `.github/workflows/restore-drill-freshness.yml`, which asks another
    // repository whether a restore actually succeeded.
    //
    // The two section-existence checks below are kept: they assert the doc has
    // an RPO and an RTO section at all, which is structure rather than content.
    it('still declares an RPO and an RTO section', () => {
        // "has an RPO and an RTO SECTION" is literally a claim about the
        // level-2 headings — which is what the RETIRED note above concluded
        // when it kept these two and deleted the content assertions.
        const slos = headingLines(read(SLO_DOC), 2);
        expect(slos).toMatch(/SLO 6:\s*RPO/i);
        expect(slos).toMatch(/SLO 7:\s*RTO/i);
    });

    it('declares the repository SLO that uses OI-3 part 2 metrics', () => {
        expect(headingLines(read(SLO_DOC), 2)).toMatch(/SLO 5:\s*Repository latency/i);
        // The metric name from OI-3 part 2 — inside SLO 5, where it powers
        // that SLO, not in the telemetry inventory at the top (3 raw, 2 here).
        expect(mdSection(read(SLO_DOC), 'SLO 5: Repository latency (Epic OI-3)')).toMatch(
            /repo_method_duration/,
        );
    });

    it('summary table contains all 8 SLOs (4 original + read/write split + repo + RPO + RTO)', () => {
        // The summary table appears late in the doc and lists every SLO.
        // `src.split('## SLO Summary Table')[1]` used to bound this: it is
        // not fence-aware and, more to the point, it has no END — it ran
        // 15842 characters to EOF, swallowing the whole Load-Test and Metric
        // Dependencies sections. `mdSection` returns the 800 characters that
        // are actually the table.
        const summarySection = mdSection(read(SLO_DOC), 'SLO Summary Table');
        for (const target of [
            'API Availability',
            'API Latency — Reads',
            'API Latency — Writes',
            'API Error Rate',
            'Health Check Availability',
            'Repository Latency',
            'RPO (Recovery Point)',
            'RTO (Recovery Time)',
        ]) {
            expect(summarySection).toContain(target);
        }
    });

    it('revision history records the OI-3 update', () => {
        const history = mdSection(read(SLO_DOC), 'Revision History');
        expect(history).toMatch(/2026-04-27.*OI-3/);
    });
});

describe('OI-3 — Incident response runbook (docs/incident-response.md)', () => {
    const DOC = 'docs/incident-response.md';

    it('exists', () => {
        expect(exists(DOC)).toBe(true);
    });

    const REQUIRED_PLAYBOOKS = [
        ['App Down', 'app-down'],
        ['Database Unavailable', 'database-unavailable'],
        ['Redis OOM', 'redis-oom'],
        ['Queue Backlog', 'queue-backlog'],
        ['Certificate Expiry', 'certificate-expiry'],
        ['Rollback', 'rollback'],
        ['Data Breach Response', 'data-breach'],
    ] as const;

    it.each(REQUIRED_PLAYBOOKS)('contains the %s playbook', (label) => {
        // A PLAYBOOK is a level-2 section, so the claim is about the heading
        // lines and not about the label appearing somewhere in 702 lines.
        // Measured lower-cased over the whole document, 'Rollback' matched 22
        // times, 'Redis OOM' 5, 'App Down' 3 — that assertion could not have
        // noticed a deleted playbook. Against the headings each is exactly 1.
        const playbooks = headingLines(read(DOC), 2);
        expect(playbooks.toLowerCase()).toContain(label.toLowerCase());
    });

    // ── The deployed alerting contract, read from the files that record it ──
    //
    // Production alerts are GCP Cloud Monitoring policies, versioned as
    // `infra/alerts/policies/*.json`, and the uptime check is recorded in
    // `infra/alerts/external-uptime.yml`. The two assertions below take their
    // expectation from those files rather than from a list typed here, so a
    // policy added to the directory fails this guard until the runbook routes
    // it, and a change of probe path fails it until App Down follows.
    const POLICY_DIR = 'infra/alerts/policies';
    const policyNames = (): string[] =>
        fs
            .readdirSync(path.join(ROOT, POLICY_DIR))
            .filter((f) => f.endsWith('.json'))
            .sort()
            .map((f) => (JSON.parse(read(`${POLICY_DIR}/${f}`)) as { displayName: string }).displayName);

    it('quick-reference table routes every GCP alert policy by its display name', () => {
        // The alert email is titled with the policy's display name, so that is
        // the string an operator arrives holding. "In the quick reference" is
        // the claim, so that is the region read.
        const quick = mdSection(read(DOC), 'Quick reference');
        const names = policyNames();
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) {
            expect(quick).toContain(name);
        }
    });

    it('App Down playbook probes the path the deployed uptime check probes', () => {
        // Was `/api/livez`, "matching the external uptime contract". The
        // contract moved to `/api/readyz` on 2026-09-22 (#2745) and this
        // assertion went on requiring livez, so it held the runbook to a probe
        // the monitor no longer used. Reading the URL out of the contract
        // keeps the two together.
        const contract = read('infra/alerts/external-uptime.yml');
        const url = contract.match(/^\s*url:\s*(\S+)\s*$/m)?.[1];
        expect(url).toBeDefined();
        expect(url).toMatch(/^https:\/\//);
        const appDown = mdSection(read(DOC), '1. App Down');
        expect(appDown).toContain(`curl -s ${url}`);
    });

    it('Rollback playbook documents that the schema does not roll back', () => {
        // expand-and-contract is THE mitigation. Without this the
        // rollback playbook is unsafe.
        const rollback = mdSection(read(DOC), '6. Rollback');
        expect(rollback.toLowerCase()).toMatch(/expand[\s-]and[\s-]contract/);
        // The migration is one-way. The app container runs `prisma migrate
        // deploy` when it starts, and running an older image does not undo it.
        // (This read "the migration Job is one-way", a Helm hook on a cluster
        // that never existed — #4308.)
        expect(rollback).toMatch(/The schema does not roll back/);
    });

    it('Database Unavailable playbook covers PgBouncer pool inspection', () => {
        const database = mdSection(read(DOC), '2. Database Unavailable / Slow');
        expect(database).toMatch(/SHOW POOLS/);
        expect(database).toMatch(/pgbouncer/i);
    });

    it('Data Breach playbook references the hash-chained AuditLog (preserves evidence)', () => {
        const breach = mdSection(read(DOC), '7. Data Breach Response');
        expect(breach).toMatch(/AuditLog/);
        expect(breach).toMatch(/hash-chained/i);
    });

    it('Data Breach playbook references the Epic B v1→v2 sweep for KEK rotation', () => {
        // The KEK rotation runbook lives in epic-b-encryption.md;
        // the incident-response runbook MUST point at it (regenerating
        // the KEK without the sweep is a data-loss event).
        const breach = mdSection(read(DOC), '7. Data Breach Response');
        expect(breach).toMatch(/epic-b-encryption/);
        expect(breach).toMatch(/v1.{0,5}v2/i);
    });

    it('Communication templates section has its named templates', () => {
        const comms = mdSection(read(DOC), 'Communication templates');
        const templates = [
            'Status page update — initial',
            'Status page update — mitigation in progress',
            'Status page update — resolved',
            'Internal Slack — incident channel kickoff',
        ];
        for (const t of templates) {
            expect(comms).toContain(t);
        }
        // Plus the customer-email templates (degradation + breach)
        expect(comms).toMatch(/Customer email\s*[—-]\s*service degradation/);
        expect(comms).toMatch(/Customer email\s*[—-]\s*confirmed data breach/);
    });

    it('still has an Operational alignment section', () => {
        // Structure, not content: the closing section maps each runbook step to
        // where it is defined. See the RETIRED note below for the needles that
        // used to be asserted inside it.
        expect(headingLines(read(DOC), 2)).toMatch(/Operational alignment/i);
        const alignment = mdSection(read(DOC), 'Operational alignment summary');
        expect(alignment).toMatch(/external-uptime\.yml/);
    });

    // ── RETIRED 2026-10-26 (#4308): assertions that pinned the EKS/RDS runbook ──
    //
    // The runbook was rewritten for the production VM. These assertions
    // required it to keep text describing an estate that was never provisioned
    // and was removed on 2026-09-02 (#2226), the same trap the RETIRED block in
    // the SLO half of this file describes:
    //
    //     Rollback:    /helm history inflect-production/, /helm rollback
    //                  inflect-production/, /--namespace inflect-production/
    //     PITR:        /restore-db-instance-to-point-in-time/ — there is no
    //                  RDS and no point-in-time recovery
    //     Severity:    CRITICAL…PagerDuty, WARNING…Slack — there is no pager;
    //                  every policy emails one channel
    //     Templates:   'PagerDuty incident'
    //     Alignment:   /Epic OI-1/, /Epic OI-2/, /Epic OI-3/,
    //                  /restore-test\.sh/, /manage_master_user_password/
    //     Quick ref:   the five `infra/alerts/rules.yml` names
    //                  (DatabaseConnectionPoolExhausted, RedisMemoryHigh*,
    //                  QueueDepthBacklogCritical, CertificateExpiryCritical)
    //     Dashboards:  the four `infra/dashboards/` UIDs
    //
    // `infra/alerts/rules.yml` and the dashboards it linked (both deleted
    // 2026-10-26) described a Prometheus/Alertmanager/Grafana deployment that
    // did not run (see
    // `infra/alerts/gcp-custom-metrics.yml`). Requiring the runbook to route
    // those alert names meant routing operators from alerts that never fire.
    // The quick-reference assertion above takes its place, read from the
    // policies that do fire. The others are not replaced with corrected greps,
    // for the reason the SLO note gives: a grep verifies mention, not accuracy.
});

describe('OI-3 — final readiness check (alignment)', () => {
    // RETIRED 2026-10-26 (#4308): 'every alert with severity=critical has a
    // corresponding playbook section' and 'runbook references the dashboards
    // UIDs that each alert uses'. Both derived their expectation from
    // `infra/alerts/rules.yml`, which no production system loaded, so both held
    // the runbook to alerts and dashboards that do not exist. The runbook's
    // routing is now checked against `infra/alerts/policies/` above.

    it('SLO doc names, beside the latency SLO, an alert rule that exists', () => {
        // "Protects the SLO" is a claim about WHERE the alert is named: beside
        // the objective it guards, in the read-latency SLO's Telemetry Source.
        // Until 2026-10-26 this required `ApiP95LatencyWarning` and
        // `ApiP95LatencyCritical`, rules in `infra/alerts/rules.yml`, which
        // nothing loaded. The name is now checked against the rule file the
        // Prometheus stack reads, so the doc cannot name a rule that is gone.
        const reads = mdSection(read('docs/slos.md'), 'SLO 2: API Latency — Reads (P95)');
        expect(reads).toMatch(/ApiLatencySloBreach/);
        const rules = yaml.load(read('infra/observability/prometheus/rules/alerting-rules.yml')) as {
            groups: { rules: { alert?: string }[] }[];
        };
        const alerts = rules.groups.flatMap((g) => g.rules.map((r) => r.alert));
        expect(alerts).toContain('ApiLatencySloBreach');
    });
});
