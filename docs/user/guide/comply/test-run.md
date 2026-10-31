---
route: /t/[tenantSlug]/tests/runs/[runId]
---

# A test run

A test run's page is where one execution of a test plan happens: you walk through the plan's procedure, attach the evidence you gathered and record the result. Once completed, the run is a frozen record of that test.

## Where to find it

Open a test plan and click a run in its **{{ui:controls.testPlan.runHistory}}**, or start a new run there. A scheduled run can also be opened from the plan. The breadcrumb reads **{{ui:controlTests.crumb.dashboard}}** › **{{ui:controlTests.run.controls}}** › the plan's name › **{{ui:controlTests.run.run}}**. The arrows beside the title step to the plan's other runs.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the run and its evidence, and verify its integrity | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Start the run, record its result and retest | Owner, Admin, Editor |
| Attach and remove evidence while the run is open | Owner, Admin, Editor |
| Download the control's evidence bundle | Owner, Admin, Editor, Auditor |
| Snapshot a completed run into an audit pack | Owner, Admin, Editor |

The buttons to start, complete, retest, attach evidence and snapshot appear only for Owners, Admins and Editors. Uploading a new file or adding a link also needs permission to edit controls, because the evidence is filed against the control; without it, only **{{ui:controlTests.evKind.evidence}}** is offered.

The **{{ui:controlTests.run.export.csv}}** and **{{ui:controlTests.run.export.json}}** links are shown to every role, but a Reader or AI admin who uses them is refused.

## What it is for

Use the page to carry out a test properly and leave evidence an auditor can rely on: what was checked, what was found and who recorded it.

## What you see

**The header.** **{{ui:controlTests.run.title}}** and the plan's name, the run's status (**{{ui:controlTests.runStatus.PLANNED}}**, **{{ui:controlTests.runStatus.RUNNING}}** or **{{ui:controlTests.runStatus.COMPLETED}}**), its result once it has one, and when it was executed.

**{{ui:controlTests.run.procedureHeading}}.** The plan's steps, until the run is completed. While the run is in progress, each step has a tick box and a count of the steps done. {{ui:controlTests.run.stepsGuidanceNote}}

**{{ui:controlTests.run.startHeading}}.** On a planned run, a card with **{{ui:controlTests.run.startTest}}**.

**{{ui:controlTests.run.completeHeading}}.** On a run in progress, the form for the result. See below.

**The record.** On a completed run, its notes, its finding summary if it failed, and who executed it and when.

**{{ui:controlTests.run.evidence}}.** The evidence attached to the run, each with its kind (**{{ui:controlTests.run.evidenceKind.file}}**, **{{ui:controlTests.run.evidenceKind.link}}** or **{{ui:controlTests.run.evidenceKind.evidence}}**), its title or address, its note, and who added it when.

**{{ui:controlTests.run.hardening.heading}}.** The integrity check, the evidence bundle downloads and, on a completed run, the snapshot to an audit pack.

## What you can do

### Start the run

On a planned run, click **{{ui:controlTests.run.startTest}}**. The run moves to {{ui:controlTests.runStatus.RUNNING}} and the procedure becomes a checklist.

### Record the result

1. In **{{ui:controlTests.run.completeHeading}}**, choose the result: **{{ui:controlTests.result.PASS}}**, **{{ui:controlTests.result.FAIL}}** or **{{ui:controlTests.result.INCONCLUSIVE}}**.
2. Add **{{ui:controlTests.run.notes}}** on what you observed.
3. For a failure, add a **{{ui:controlTests.run.findingLabel}}**. It becomes the description of the follow-up task.
4. Click the complete button, then **{{ui:controlTests.run.confirmComplete.confirm}}** in the dialog that asks **{{ui:controlTests.run.confirmComplete.title}}**

Completing cannot be undone. The run's evidence is frozen from then on.

### Attach evidence

While the run is open, click **{{ui:controlTests.run.evidence}}** and choose an **{{ui:controlTests.run.evidenceType}}**:

- **{{ui:controlTests.evKind.fileUpload}}**: pick a file and give it a **{{ui:controlTests.run.title2}}**. The file is added to the evidence library against the control, then linked to the run. Click **{{ui:controlTests.run.uploadLink}}**.
- **{{ui:controlTests.evKind.link}}**: enter the **{{ui:controlTests.run.url}}** and a title. A link record is added to the evidence library against the control, then linked. Click **{{ui:controlTests.run.link}}**.
- **{{ui:controlTests.evKind.evidence}}**: pick an **{{ui:controlTests.run.evidenceRecord}}** already in the library. Click **{{ui:controlTests.run.link}}**.

Each kind takes an optional **{{ui:controlTests.run.note}}**. The message **{{ui:controlTests.run.evidenceAddedToast}}** confirms it.

To remove a piece of evidence from an open run, point at its row and click the cross that appears. The evidence stays in the library; only its link to the run is removed. There is no undo.

### Verify the evidence

Click **{{ui:controlTests.run.integrity.verify}}**. The files attached to the run are checked against the fingerprints taken when they were uploaded. The badge reads **{{ui:controlTests.run.integrity.ok}}**, **{{ui:controlTests.run.integrity.failed}}** or **{{ui:controlTests.run.integrity.none}}**, with counts of the files verified, failed and unverifiable. Adding or removing evidence clears the result.

### Download the evidence bundle

**{{ui:controlTests.run.export.label}}** offers **{{ui:controlTests.run.export.csv}}** and **{{ui:controlTests.run.export.json}}**. The bundle covers every run of every test plan on the control, not just this run.

### Snapshot into an audit pack

On a completed run, choose a draft audit pack under **{{ui:controlTests.run.snapshot.label}}** and click **{{ui:controlTests.run.snapshot.confirm}}**. The run and its evidence are copied into the pack. If you have not verified the evidence on this visit, a warning suggests doing so first. Only draft packs are offered; **{{ui:controlTests.run.snapshot.noPacks}}** means there are none.

### Retest

A completed run that failed or was inconclusive offers **{{ui:controlTests.run.retest}}**. It creates a new run of the same plan and opens it.

## What happens next

- A **{{ui:controlTests.result.PASS}}** or **{{ui:controlTests.result.FAIL}}** counts as the control having been tested: the control's last-tested date is set and the plan's next due date moves on by its frequency. An **{{ui:controlTests.result.INCONCLUSIVE}}** result moves neither.
- A **{{ui:controlTests.result.FAIL}}** creates a task to close the control gap, using your finding summary.
- The result feeds the plan's cards, the control's health and the {{ui:controlTests.dashboard.title}}.

## Empty and error states

| What you see | Why | What to do |
| --- | --- | --- |
| **{{ui:controlTests.run.evidenceEmpty}}** | Nothing has been attached | Attach evidence before completing the run |
| **{{ui:controlTests.run.errors.forbidden}}** | Your role cannot see test runs | Ask an admin for access |
| **{{ui:controlTests.run.errors.notFound}}** | The run was deleted, or the link is wrong | Go back to the plan |
| **{{ui:controlTests.run.errors.loadFailed}}** | The run could not be read | Reload the page |
| **{{ui:controlTests.run.errors.startFailed}}**, **{{ui:controlTests.run.errors.completeFailed}}** or **{{ui:controlTests.run.errors.retestFailed}}** | The action was refused or failed | Check that the plan is still active and your role, then try again |
| A red message in the evidence form | The upload, the link or the record could not be added. The message gives the reason when there is one | Fix what it names and try again |
| **{{ui:controlTests.run.integrity.error}}** | The check could not run | Try again |
| **{{ui:controlTests.run.snapshot.failed}}** | The snapshot was refused or failed | Check that the pack is still a draft, then try again |

## Related

- [A test plan](test-plan.md), the plan this run belongs to.
- [{{ui:evidence.title}}](evidence.md), where uploaded files and links are kept.
- [An audit pack](audit-pack-detail.md), where a snapshot lands.
- [{{ui:controlTests.dashboard.title}}](tests-dashboard.md), for results across the workspace.
