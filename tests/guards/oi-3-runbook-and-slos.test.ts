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
 *   - Each playbook references the specific alert + dashboard +
 *     command path that drives it
 *   - The runbook's "Operational alignment" section names every
 *     prior epic's deliverable that it depends on
 */
import * as fs from 'fs';
import * as path from 'path';

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

    it('quick-reference table maps every alert to a playbook', () => {
        // Every alert from rules.yml that pages should appear in the
        // quick-reference. Lock the OI-3-spec alerts. "In the quick
        // reference" is the claim, so that is the region: each of these five
        // occurs 2-3 times document-wide and exactly once here, which is the
        // difference between "the table routes it" and "the word appears".
        const quick = mdSection(read(DOC), 'Quick reference');
        for (const alert of [
            'DatabaseConnectionPoolExhausted',
            'RedisMemoryHighCritical',
            'RedisMemoryHighWarning',
            'QueueDepthBacklogCritical',
            'CertificateExpiryCritical',
        ]) {
            expect(quick).toContain(alert);
        }
    });

    it('references the four OI-3 dashboards by UID', () => {
        const dashboards = mdSection(read(DOC), 'Dashboards');
        for (const uid of [
            'inflect-app-overview',
            'inflect-database',
            'inflect-redis',
            'inflect-bullmq',
        ]) {
            expect(dashboards).toContain(uid);
        }
    });

    it('App Down playbook uses /api/livez (matches external uptime contract)', () => {
        // The playbook must instruct curl/kubectl-curl to /api/livez —
        // the same endpoint the external uptime monitor probes.
        const appDown = mdSection(read(DOC), '1. App Down');
        expect(appDown).toMatch(/curl[^`]*\/api\/livez/);
    });

    it('Rollback playbook uses helm rollback with explicit revision history', () => {
        // `--namespace inflect-production` appears 20 times across the
        // runbook and `helm rollback inflect-production` 4; inside the
        // Rollback playbook, 5 and 2. Every one of the other 15 belonged to
        // some other playbook's shell block.
        const rollback = mdSection(read(DOC), '6. Rollback');
        expect(rollback).toMatch(/helm history inflect-production/);
        expect(rollback).toMatch(/helm rollback inflect-production/);
        expect(rollback).toMatch(/--namespace inflect-production/);
    });

    it('Rollback playbook documents the migration-Job-not-re-run-on-rollback caveat', () => {
        // expand-and-contract is THE mitigation. Without this the
        // rollback playbook is unsafe.
        const rollback = mdSection(read(DOC), '6. Rollback');
        expect(rollback.toLowerCase()).toMatch(/expand[\s-]and[\s-]contract/);
        // Migration Job is one-way
        expect(rollback).toMatch(/migration Job is one-way|hooks?\s+are\s+\*?\*?NOT\*?\*?\s+re-run|NOT.{1,5}re-run on rollback/i);
    });

    it('Database Unavailable playbook covers PgBouncer pool inspection', () => {
        const database = mdSection(read(DOC), '2. Database Unavailable / Slow');
        expect(database).toMatch(/SHOW POOLS/);
        expect(database).toMatch(/pgbouncer/i);
    });

    it('Database recovery from PITR uses restore-db-instance-to-point-in-time', () => {
        // The `###` subsection this test is named after, not the whole
        // playbook: the command also appears in the Operational alignment
        // summary, which is a list of deliverables rather than a procedure.
        const pitr = mdSection(read(DOC), 'DB recovery from PITR');
        expect(pitr).toMatch(/restore-db-instance-to-point-in-time/);
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

    it('Communication templates section has 5 named templates', () => {
        const comms = mdSection(read(DOC), 'Communication templates');
        const templates = [
            'PagerDuty incident',
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

    it('Severity definitions table includes both CRITICAL and WARNING tiers', () => {
        // Both needles carry a `[\s\S]{0,200}` span, so read whole-document
        // they could pair a CRITICAL from one playbook with a PagerDuty 200
        // characters later in another. 3 matches raw, 1 inside the table.
        const severity = mdSection(read(DOC), 'Severity definitions');
        expect(severity).toMatch(/CRITICAL[\s\S]{0,200}PagerDuty/);
        expect(severity).toMatch(/WARNING[\s\S]{0,200}Slack/);
    });

    it('Operational alignment section names every prior-epic deliverable', () => {
        // The closing section MUST call out the dependencies so an
        // operator reading this doc cold sees the system map — and "the
        // section names them" is the claim, so reading the whole document for
        // it answered a different question. `/Epic OI-3/` matched 7 times
        // document-wide; `restore-test.sh` twice, only one of them here.
        const alignment = mdSection(read(DOC), 'Operational alignment summary');
        expect(headingLines(read(DOC), 2)).toMatch(/Operational alignment/i);
        expect(alignment).toMatch(/Epic OI-1/);
        expect(alignment).toMatch(/Epic OI-2/);
        expect(alignment).toMatch(/Epic OI-3/);
        // Specific deliverables
        expect(alignment).toMatch(/restore-test\.sh/);
        expect(alignment).toMatch(/manage_master_user_password/);
        expect(alignment).toMatch(/external-uptime\.yml/);
    });
});

describe('OI-3 — final readiness check (alignment)', () => {
    it('every alert with severity=critical has a corresponding playbook section', () => {
        // The runbook half is bound to the quick-reference table: "addressed
        // in the runbook" means the operator can route from the alert name,
        // and that table is where routing happens.
        const quickReference = mdSection(
            read('docs/incident-response.md'),
            'Quick reference',
        );
        const rulesSrc = read('infra/alerts/rules.yml');

        // Walk the rules YAML for critical alerts
        const criticalNames: string[] = [];
        const lines = rulesSrc.split('\n');
        let pendingAlert: string | null = null;
        for (const line of lines) {
            const alertMatch = line.match(/^\s*-\s*alert:\s*(\w+)/);
            if (alertMatch) {
                pendingAlert = alertMatch[1];
                continue;
            }
            if (pendingAlert && /severity:\s*critical/.test(line)) {
                criticalNames.push(pendingAlert);
                pendingAlert = null;
            }
        }
        expect(criticalNames.length).toBeGreaterThan(0);

        // Subset of criticals that must each be addressed in the runbook.
        // (Not every critical has a unique section — e.g. ApiP95LatencyCritical
        // is handled inside the Database playbook. We assert the
        // OI-3-spec criticals are referenced by NAME in the doc.)
        const MUST_BE_NAMED = [
            'DatabaseConnectionPoolExhausted',
            'RedisMemoryHighCritical',
            'QueueDepthBacklogCritical',
            'CertificateExpiryCritical',
        ];
        for (const name of MUST_BE_NAMED) {
            expect(criticalNames).toContain(name);
            expect(quickReference).toContain(name);
        }
    });

    it('SLO doc references the alert names that protect each SLO', () => {
        // Latency SLO ↔ ApiP95Latency alerts; Error rate SLO ↔ ApiErrorRate
        // alerts. "Protects each SLO" is a claim about WHERE the alert is
        // named — beside the objective it guards. Measured, both names occur
        // exactly once in the document and both are in the read-latency SLO's
        // Telemetry Source, so binding here asserts the pairing rather than
        // the mention.
        const reads = mdSection(read('docs/slos.md'), 'SLO 2: API Latency — Reads (P95)');
        expect(reads).toMatch(/ApiP95LatencyWarning/);
        expect(reads).toMatch(/ApiP95LatencyCritical/);
    });

    it('runbook references the dashboards UIDs that each alert uses', () => {
        const dashboards = mdSection(read('docs/incident-response.md'), 'Dashboards');
        const rules = read('infra/alerts/rules.yml');

        // Extract every `dashboard:` annotation value from rules.yml
        const annotated = Array.from(
            rules.matchAll(/dashboard:\s*"([^"]+)"/g),
            (m) => m[1],
        );
        const uniqueUids = new Set(
            annotated
                .map((url) => {
                    const m = url.match(/^\/d\/([^/]+)/);
                    return m ? m[1] : '';
                })
                .filter((u) => u),
        );

        for (const uid of uniqueUids) {
            // The runbook's Dashboards section should list every dashboard
            // the alerts route operators to — a UID buried in some
            // playbook's shell block is not a directory entry.
            expect(dashboards).toContain(uid);
        }
    });
});
