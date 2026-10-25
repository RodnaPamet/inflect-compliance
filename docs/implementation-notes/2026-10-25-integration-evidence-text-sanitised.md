# 2026-10-25 — Integration evidence text is sanitised before it is stored

**Commit:** `<sha> fix(integrations): a provider's text is sanitised before it is stored as evidence`

## Design

`2026-10-25-evidence-text-sanitised.md` sanitised every Evidence writer that
takes text from a caller and left the system writers alone. Of those, three
store text that a third party wrote:

| Writer | Third-party text in the row |
| --- | --- |
| `usecases/integrations.ts::runAutomationForControl` (manual run) | whatever the provider's `mapResultToEvidence` composes: GitHub's repository, branch and required status-check names; ServiceNow's change numbers in the details JSON; and the control's check type (from a tenant's `automationKey`) in every title and category |
| `jobs/automation-runner.ts::executeControlAutomation` (scheduled run) | the same payload |
| `usecases/webhook-processor.ts` | the event type, read from the webhook body's `action` / `event_type`; the automation key the provider returns, in the title |

Both integration writers now store the payload through one function,
`integrationEvidenceText` in `src/app-layer/integrations/evidence-text.ts`.
Title, body and category go through `sanitizePlainText`. Safe text comes back
byte-identical, so a well-behaved provider's rows keep their exact shape.

A body may end in JSON. ServiceNow's mapper used to append
`JSON.stringify(result.details, null, 2)` to the summary itself. `EvidencePayload`
gains `contentJson`: ServiceNow hands its details over there, and the writer
appends them after sanitising only their string values. A safe result is
stored exactly as before: the summary, a blank line, the pretty-printed JSON.

The webhook processor sanitises the event type and the automation key where it
composes them. An event type that is blank once sanitised reads `unknown`, as an
absent one already did.

Existing rows are not backfilled.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/integrations/evidence-text.ts` | `integrationEvidenceText` and `sanitizeJsonStringValues` |
| `src/app-layer/integrations/types.ts` | `EvidencePayload.contentJson` |
| `src/app-layer/integrations/providers/servicenow/index.ts` | passes its details as `contentJson` rather than serialising them into `content` |
| `src/app-layer/usecases/integrations.ts`, `src/app-layer/jobs/automation-runner.ts` | store the payload through the helper; the scheduled runner also sanitises its Finding description |
| `src/app-layer/jobs/control-test-runner.ts` | the `AutomationHandlerResult` comment now says what is true |
| `src/app-layer/usecases/webhook-processor.ts` | sanitises the event type and the automation key |

## Decisions

- **At the writer, not in each mapper.** Twelve providers compose a payload in
  `mapResultToEvidence`, and every one interpolates something it did not
  write. Two writers store all of them, so sanitising there covers every
  provider, including one added later by somebody who never reads this note.
- **JSON is never sanitised as text.** `sanitizePlainText` parses its input as
  HTML. A `<` before a letter inside a value opens a "tag" that runs to the next
  `>` and takes the JSON with it: with ServiceNow's details serialised into
  `content`, a change number `CHG02 a<b` left the stored body ending in an
  unterminated string. A `;`-less legacy entity inside a value (`&reg`) is
  decoded too. So the details travel apart from the prose and are sanitised value
  by value. Keys are kept: in the one payload that uses `contentJson` they are
  the mapper's own literals.
- **How that JSON is read.** A TEXT row's `content` is rendered by the evidence
  sheet as escaped plain text (`whitespace-pre-wrap`), never as HTML, and the
  audit-pack share link returns JSON. The block is display text, so what matters
  is that no value carries markup to a renderer that does not escape, not that
  the serialised whole is HTML-safe.
- **A URL value goes through `sanitizeUrlText`.** Only when the whole value is
  one http(s) URL. No payload carries one today; it is the case where
  `sanitizePlainText` would quietly change where a link points
  (`&region=` to `®ion=`). Nothing in the prose columns on this path is a URL.
- **Digest-bound writers are untouched.** The agentic evidence artefacts
  (`agentic-evidence-emission.ts`) are verified against
  `AgenticEvidenceArtefact.sourceDigest`, and the integration passport is read
  back out of `Evidence.content` and checked against it: rewriting those bytes
  would make every prior unverifiable. The connected-app and agent
  access-review evidence are FILE rows over a hashed file (`FileRecord.sha256`),
  titled from a campaign name sanitised at its own write.
- **Writers left alone, and why.**
  - Posture (`aws-posture.ts`, `cloud-posture.ts`). Powerpipe's control id
    produces evidence only when it is a key of the constant control map, so the
    stored id is a constant. The one free value is the automation key built from
    the connection's `benchmark`, which is admin configuration, not third-party
    text. Validating `benchmark` against its declared options when the
    connection is saved would close that at the source.
  - Scanner ingestion already sanitises `repoRef`, its only free value; source,
    scan type and threshold are enums.
  - The control-test runner stores what its handlers compose from Inflect's own
    records (audit procedures, agentic checks) and the plan's name, which is
    sanitised at its own write. Its `AutomationHandlerResult` comment said
    `evidenceContent` was "sanitised at the Evidence persistence boundary"; it
    was not, and the comment now says it is stored as given and that a handler
    adding a third party's text sanitises it itself.
  - The kill-switch drill, governance pack, vendor assessment and the
    retention, status and date writers store constants, internal records or no
    free text. The SharePoint and ZIP imports go through `uploadEvidenceFile`,
    which the earlier change covers.
- **Third-party text that is not Evidence stays as it was.**
  `IntegrationExecution.resultJson` keeps the raw details,
  `IntegrationWebhookEvent.eventType` keeps the raw value (it also routes the
  sync orchestrator). The one exception is the scheduled runner's Finding: its
  description is the provider's summary, written straight to an encrypted
  business-content column that the finding usecase sanitises on every other
  path, so it is sanitised too.
- **Prose loses what plain text always loses.** As in the earlier change, a
  branch named `fix&reg` is stored `fix®` and text inside angle brackets is
  dropped. That is the product-wide plain-text behaviour.
