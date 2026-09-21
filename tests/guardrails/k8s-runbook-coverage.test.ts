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

    it('marks the Kubernetes/EKS path as the primary production model', () => {
        const src = readRepoFile(DOC);
        // Regression: a future doc-cleanup PR that re-promotes the
        // docker-compose path or removes the "primary" framing leaves
        // ops without a clear default. The framing matters: SRE on-
        // call triages production by what this header says.
        expect(src).toMatch(/Kubernetes \(Helm\) — primary production path/);
    });

    it('marks the docker-compose Backup & Restore section as legacy-only', () => {
        const src = readRepoFile(DOC);
        // Regression: someone reading the doc top-to-bottom hits
        // `## Backup & Restore` (line ~214) before the K8s section
        // and runs `docker compose exec db pg_dump …` on a
        // production EKS deployment, where it does nothing useful.
        // The legacy framing is the visibility lever.
        expect(src).toMatch(
            /Backup & Restore[\s\S]*?Docker Compose[\s\S]*?legacy/i,
        );
    });

    // ─── 2. Deploy + Rollback + Scaling all present ─────────────────

    it('documents the K8s deploy flow (workflow + local helm path)', () => {
        const src = readRepoFile(DOC);
        // Two surfaces — automated deploy via the GH workflow + local
        // helm commands for ad-hoc operations. Both must exist; one
        // alone leaves operators stuck when the workflow is broken.
        expect(src).toMatch(/Deploy.*GitHub Actions workflow|deploy\.yml/i);
        expect(src).toMatch(/helm upgrade --install/);
        expect(src).toMatch(/Local helm commands/);
    });

    it('documents rollback via helm rollback with migration safety notes', () => {
        const src = readRepoFile(DOC);
        // The "Migration safety on rollback" subsection is critical —
        // without it, an operator running `helm rollback` after a
        // migration with a destructive change can leave the cluster
        // in a half-rolled state. The note must stay even when the
        // happy-path commands are tightened.
        expect(src).toMatch(/helm rollback/);
        expect(src).toMatch(/Migration safety on rollback/);
    });

    it('documents scaling — HPA-driven app + manual worker', () => {
        const src = readRepoFile(DOC);
        // Two scaling models live here: HPA for the app
        // (autoscaling.minReplicas / maxReplicas), manual replicas
        // for the worker (per OI-2 spec — workers don't get HPA).
        expect(src).toMatch(/autoscaling\.min[Rr]eplicas|autoscaling\.max[Rr]eplicas|HPA/);
        expect(src).toMatch(/Worker scaling.*manual|manual.*[Ww]orker.*scal/);
    });

    // ─── 3. Backup & Restore — RDS + S3 (the closing 10% of GAP-12) ─

    it('has a K8s-native Backup & Restore section', () => {
        const src = readRepoFile(DOC);
        // GAP-12 acceptance criterion. Pre-this-PR, only the
        // docker-compose path was documented and would mislead
        // operators on EKS. Section presence is the main hook.
        expect(src).toMatch(/Backup & Restore \(RDS \+ S3\)/);
    });

    it('documents RDS automated backups + retention windows', () => {
        const src = readRepoFile(DOC);
        // Operators must see that DB backups are AUTOMATIC — the
        // common mistake is running pg_dump ad-hoc when RDS already
        // has it covered. The ratchet keys on the words operators
        // grep for during an incident.
        expect(src).toMatch(/Automated backups|automated.*snapshot/i);
        expect(src).toMatch(/db_backup_retention_days/);
        expect(src).toMatch(/staging.*7.*production.*14|7d.*14d/);
    });

    it('documents PITR (point-in-time recovery) with a runnable command', () => {
        const src = readRepoFile(DOC);
        // Surgical recovery — most-asked-for restore type after a
        // bad query. The runbook must give operators the actual AWS
        // CLI invocation, not just hand-wave "use PITR".
        expect(src).toMatch(/PITR|point-in-time/i);
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
        const src = readRepoFile(DOC);
        // The "I accidentally deleted a file" case has a different
        // runbook than the "I overwrote a file" case — operators
        // must see both. Removing the delete marker re-exposes the
        // version underneath.
        expect(src).toMatch(/delete[\s-]marker/i);
        expect(src).toMatch(/aws s3api delete-object/);
    });

    // ─── 4. Honest about scope (no false promises) ───────────────────

    it('explicitly scopes out cross-region DR and Redis restore', () => {
        const src = readRepoFile(DOC);
        // The runbook honestly enumerates what it does NOT cover so
        // ops doesn't assume cross-region DR is configured today.
        // The "deliberately does NOT cover" header is the sentinel
        // future PRs must preserve when expanding the runbook.
        expect(src).toMatch(/deliberately does NOT cover|Out of scope/i);
        expect(src).toMatch(/[Cc]ross-region|disaster recovery/);
        // Redis explicitly called out — BullMQ job state is
        // intentionally ephemeral; operators trying to "restore
        // Redis" should know this is by design, not a missing tool.
        expect(src).toMatch(/Redis[\s\S]*?ephemeral|ephemeral[\s\S]*?Redis/);
    });
});
