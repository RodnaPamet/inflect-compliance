/**
 * GAP-12 step 10 — Structural ratchet for the Kubernetes deployment
 * runbook.
 *
 * The original GAP-12 acceptance criterion was "Ops team
 * self-sufficient" against a 4-axis runbook checklist:
 *   K8s deploy  ·  rollback  ·  scaling  ·  backup restore
 *
 * Steps 1-9 of GAP-12 land Helm/Terraform code; step 10 lives entirely
 * in `docs/deployment.md`. Without a structural ratchet, doc rot is the
 * obvious failure mode: a section gets renamed during a doc-cleanup PR,
 * or the K8s/EKS path drifts away from the per-env tfvars without an
 * accompanying runbook update, and ops loses the map.
 *
 * This test asserts the four runbook axes are visibly present in
 * docs/deployment.md and contain the load-bearing AWS-managed-store
 * commands that distinguish the K8s/EKS path from the legacy
 * docker-compose path. It does NOT validate prose quality — that's
 * the reviewer's job.
 *
 * Same shape as `tests/guardrails/encryption-key-enforcement.test.ts`
 * and the GAP-13 / GAP-17 ratchets.
 */

import * as fs from 'fs';
import * as path from 'path';

import { headingLines, mdSection } from '../helpers/markdown-regions';

const REPO_ROOT = path.resolve(__dirname, '../..');

function readRepoFile(rel: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

/**
 * Only the FENCED blocks — the runnable half of the runbook (#2727).
 *
 * An assertion that a runbook "gives the operator the actual invocation" has
 * to read the place invocations live. Against the whole document it did not:
 * `/versionId/i` matched the PROSE sentence "The output shows `IsLatest`,
 * `VersionId`, ..." at `docs/deployment.md:841`, so the fenced
 * `aws s3api copy-object` block the test exists to pin could be deleted and
 * that flag would still read as documented.
 *
 * Masking cannot fix it, and #2727's first framing was wrong to claim it
 * could: the surviving token is a backticked CODE SPAN, which any masker worth
 * having keeps. The defect is the assertion reading the wrong REGION.
 *
 * Fence markers are excluded, so a needle cannot be satisfied by the ```bash
 * line itself.
 */
function fencedCommands(md: string): string {
    const out: string[] = [];
    let open: string | null = null;
    for (const line of md.split('\n')) {
        const m = /^\s*(`{3,}|~{3,})/.exec(line);
        if (open === null) {
            if (m) open = m[1][0];
            continue;
        }
        if (m && m[1][0] === open) {
            open = null;
            continue;
        }
        out.push(line);
    }
    return out.join('\n');
}

describe('GAP-12 step 10 ratchet — docs/deployment.md K8s runbook', () => {
    const DOC = 'docs/deployment.md';

    // ─── 1. K8s/EKS section is the documented primary path ─────────

    // NARROWED, NOT MASKED (#2246), for this whole file.
    //
    // `mdCodeOf` — the markdown masker — keeps a document's CODE and blanks
    // its prose. On a runbook that deletes almost everything asserted below:
    // section headings, retention windows, the "deliberately does NOT cover"
    // sentinel. The assertions are about what the runbook SAYS, so the fix is
    // the other route Class A names — bind each read to the region the test
    // names in its own title.
    //
    // It is not cosmetic. Measured on `docs/deployment.md` (39,958 chars),
    // the document says `helm upgrade --install` 6 times, mentions HPA or an
    // `autoscaling.*Replicas` key 13 times and `helm rollback` 6 times — so
    // "documents scaling" was satisfied by the values-file walkthrough in a
    // different section, and every one of these could have had its own
    // section deleted while a sibling kept it green. Bound: 1, 6 and 5.
    //
    // The section finder is fence-aware and that is load-bearing HERE
    // specifically: this runbook is mostly shell, and a shell comment starts
    // with `#`. A finder that scanned for `^#{1,6}\s` without tracking fences
    // stopped at `# Adjust bounds + reapply via helm upgrade` inside a bash
    // block, truncating `### Scaling` from 1700 chars to 164 and taking four
    // needles to ZERO matches — a narrowing that deletes the subject exactly
    // as masking would. The measurement caught it; reading it did not.

    it('marks the Kubernetes/EKS path as the primary production model', () => {
        // Regression: a future doc-cleanup PR that re-promotes the
        // docker-compose path or removes the "primary" framing leaves
        // ops without a clear default. The framing matters: SRE on-
        // call triages production by what this header says.
        //
        // This is a claim about a HEADING, so it reads the level-2 heading
        // lines and nothing else — a sentence or a fenced sample naming the
        // section no longer stands in for the section existing.
        const headings = headingLines(readRepoFile(DOC), 2);
        expect(headings).toMatch(/Kubernetes \(Helm\) — primary production path/);
    });

    it('marks the docker-compose Backup & Restore section as legacy-only', () => {
        // Regression: someone reading the doc top-to-bottom hits
        // `## Backup & Restore` (line ~214) before the K8s section
        // and runs `docker compose exec db pg_dump …` on a
        // production EKS deployment, where it does nothing useful.
        // The legacy framing is the visibility lever.
        //
        // Also a heading claim, and the span is why it matters: over the
        // whole document `/Backup & Restore[\s\S]*?Docker Compose[\s\S]*?
        // legacy/i` could re-form across three unrelated sections. Over the
        // level-2 heading lines the three parts have to sit on ONE heading.
        const headings = headingLines(readRepoFile(DOC), 2);
        expect(headings).toMatch(
            /Backup & Restore[\s\S]*?Docker Compose[\s\S]*?legacy/i,
        );
    });

    // ─── 2. Deploy + Rollback + Scaling all present ─────────────────

    it('documents the K8s deploy flow (workflow + local helm path)', () => {
        const src = readRepoFile(DOC);
        // Two surfaces — automated deploy via the GH workflow + local
        // helm commands for ad-hoc operations. Both must exist; one
        // alone leaves operators stuck when the workflow is broken.
        //
        // "Both must exist" is the whole point, and a whole-document read
        // could not tell them apart: `helm upgrade --install` appears 6 times
        // across the runbook, so the local-helm section could vanish and the
        // workflow section alone would keep this green. Each surface now
        // reads its own section, and the third is a heading claim.
        expect(mdSection(src, 'Deploying')).toMatch(
            /Deploy.*GitHub Actions workflow|deploy\.yml/i,
        );
        expect(mdSection(src, 'Local helm commands')).toMatch(
            /helm upgrade --install/,
        );
        expect(headingLines(src, 3)).toMatch(/Local helm commands/);
    });

    it('documents rollback via helm rollback with migration safety notes', () => {
        // The "Migration safety on rollback" subsection is critical —
        // without it, an operator running `helm rollback` after a
        // migration with a destructive change can leave the cluster
        // in a half-rolled state. The note must stay even when the
        // happy-path commands are tightened.
        //
        // Bound to the rollback section: `helm rollback` is named 6 times
        // across the runbook (the quick-reference card repeats it), so the
        // section this test exists for could be deleted wholesale and the
        // card alone would satisfy the first assertion.
        const rollback = mdSection(readRepoFile(DOC), 'Rollback via `helm rollback`');
        expect(rollback).toMatch(/helm rollback/);
        expect(rollback).toMatch(/Migration safety on rollback/);
    });

    it('documents scaling — HPA-driven app + manual worker', () => {
        // Two scaling models live here: HPA for the app
        // (autoscaling.minReplicas / maxReplicas), manual replicas
        // for the worker (per OI-2 spec — workers don't get HPA).
        //
        // The HPA needle matched 13 times document-wide — the architecture
        // section, the values walkthrough and the quick-reference card all
        // name it — so "documents scaling" said nothing about the scaling
        // section. Bound, it is 6, all of them inside it.
        const scaling = mdSection(readRepoFile(DOC), 'Scaling');
        expect(scaling).toMatch(/autoscaling\.min[Rr]eplicas|autoscaling\.max[Rr]eplicas|HPA/);
        expect(scaling).toMatch(/Worker scaling.*manual|manual.*[Ww]orker.*scal/);
    });

    // ─── 3. Backup & Restore — RDS + S3 (the closing 10% of GAP-12) ─

    it('has a K8s-native Backup & Restore section', () => {
        // GAP-12 acceptance criterion. Pre-this-PR, only the
        // docker-compose path was documented and would mislead
        // operators on EKS. Section presence is the main hook.
        //
        // "Section presence" is what it says, so it reads the level-3
        // heading lines: the phrase occurs twice in the document (the
        // heading, and a cross-reference), and a cross-reference to a
        // section that no longer exists is precisely the failure.
        expect(headingLines(readRepoFile(DOC), 3)).toMatch(
            /Backup & Restore \(RDS \+ S3\)/,
        );
    });

    it('documents RDS automated backups + retention windows', () => {
        // Operators must see that DB backups are AUTOMATIC — the
        // common mistake is running pg_dump ad-hoc when RDS already
        // has it covered. The ratchet keys on the words operators
        // grep for during an incident.
        //
        // Bound to the RDS subsection of the K8s backup runbook, so the
        // legacy docker-compose backup section cannot stand in for it.
        const db = mdSection(readRepoFile(DOC), 'Database (RDS Postgres)');
        expect(db).toMatch(/Automated backups|automated.*snapshot/i);
        expect(db).toMatch(/db_backup_retention_days/);
        expect(db).toMatch(/staging.*7.*production.*14|7d.*14d/);
    });

    it('documents PITR (point-in-time recovery) with a runnable command', () => {
        const src = readRepoFile(DOC);
        // Surgical recovery — most-asked-for restore type after a
        // bad query. The runbook must give operators the actual AWS
        // CLI invocation, not just hand-wave "use PITR".
        // The PROSE claim is bound to the RDS subsection; the COMMAND claim
        // keeps `fencedCommands`, which is the region a runnable invocation
        // lives in (#2727). Two regions because they are two claims.
        expect(mdSection(src, 'Database (RDS Postgres)')).toMatch(/PITR|point-in-time/i);
        expect(fencedCommands(src)).toMatch(/aws rds restore-db-instance-to-point-in-time/);
    });

    it('documents manual snapshot + restore-from-snapshot commands', () => {
        const src = readRepoFile(DOC);
        // The pre-migration safety net. Same load-bearing as the
        // PITR commands; same regression class if removed.
        expect(fencedCommands(src)).toMatch(/aws rds create-db-snapshot/);
        expect(fencedCommands(src)).toMatch(/aws rds restore-db-instance-from-db-snapshot/);
    });

    it('documents S3 versioning + file restore via versionId', () => {
        const src = readRepoFile(DOC);
        // S3 file recovery is fundamentally different from DB
        // restore: list versions → copy-object back to canonical
        // key. Both halves must be visible.
        expect(fencedCommands(src)).toMatch(/aws s3api list-object-versions/);
        expect(fencedCommands(src)).toMatch(/aws s3api copy-object/);
        expect(fencedCommands(src)).toMatch(/versionId/i);
    });

    it('documents the delete-marker restore path (deleted-file recovery)', () => {
        // The "I accidentally deleted a file" case has a different
        // runbook than the "I overwrote a file" case — operators
        // must see both. Removing the delete marker re-exposes the
        // version underneath.
        //
        // Bound to the S3 subsection that owns the file-recovery runbook.
        const files = mdSection(readRepoFile(DOC), 'Files (S3 storage bucket)');
        expect(files).toMatch(/delete[\s-]marker/i);
        expect(files).toMatch(/aws s3api delete-object/);
    });

    // ─── 4. Honest about scope (no false promises) ───────────────────

    it('explicitly scopes out cross-region DR and Redis restore', () => {
        // The runbook honestly enumerates what it does NOT cover so
        // ops doesn't assume cross-region DR is configured today.
        // The "deliberately does NOT cover" header is the sentinel
        // future PRs must preserve when expanding the runbook.
        //
        // Bound to that sentinel section. The Redis needle is also an
        // interior span, and over the whole document its two halves never had
        // to come from the same place — `Redis` is named throughout the
        // architecture and env sections. Inside the scope-out section they do.
        const scope = mdSection(
            readRepoFile(DOC),
            'What this section deliberately does NOT cover',
        );
        expect(scope).toMatch(/deliberately does NOT cover|Out of scope/i);
        expect(scope).toMatch(/[Cc]ross-region|disaster recovery/);
        // Redis explicitly called out — BullMQ job state is
        // intentionally ephemeral; operators trying to "restore
        // Redis" should know this is by design, not a missing tool.
        expect(scope).toMatch(/Redis[\s\S]*?ephemeral|ephemeral[\s\S]*?Redis/);
    });
});
