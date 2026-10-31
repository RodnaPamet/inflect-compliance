---
route: /t/[tenantSlug]/frameworks/[frameworkKey]/self-assessment
---

# {{ui:frameworks.selfAssessment.heading}}

The {{ui:frameworks.selfAssessment.heading}} page is where you answer the NIS2 gap-assessment questions outside the setup wizard, for example to finish an assessment you skipped during setup. {{ui:frameworks.selfAssessment.resumeHint}}

## Where to find it

The page opens from a link that names the NIS2 framework. No menu or button leads to it. To answer a new run of the questions instead, use **{{ui:audits.nis2Gap.rerun}}** on the NIS2 gap assessment page. For any framework but NIS2, the page shows {{ui:frameworks.selfAssessment.onlyNis2}}

## Who can use it

Owners and Admins. Anyone else sees **{{ui:onboarding.nis2Step.loadFailed}}**

## What it is for

Record, question by question, how far your organisation meets NIS2's security measures. Your answers feed the [NIS2 readiness](nis2-readiness.md) score and its list of gaps.

## What you see

The page heading and how many questions you have answered, with a progress bar. Then the questions, grouped by domain. Each question shows its criticality, who in the organisation can best answer it, and the questions it builds on, if any.

The questions and domain names are those of the published question set, in English.

## What you can do

### Answer a question

Choose **{{ui:onboarding.nis2Step.answer.YES}}**, **{{ui:onboarding.nis2Step.answer.PARTIALLY}}**, **{{ui:onboarding.nis2Step.answer.NO}}** or **{{ui:onboarding.nis2Step.answer.NA}}**. The answer saves straight away. **{{ui:onboarding.nis2Step.addNote}}** keeps a note beside it.

### Finish

Click **{{ui:onboarding.nis2Step.complete}}**. You can complete with questions unanswered. You return to the NIS2 framework's page.

## What happens next

- Your answers go into the latest run of the assessment, even when it is already completed.
- The NIS2 readiness score is recorded each time you complete, so its trend shows your progress.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| {{ui:frameworks.selfAssessment.onlyNis2}} | The page was opened for another framework | Open the NIS2 gap assessment from the audits page |
| **{{ui:onboarding.nis2Step.loadFailed}}** | The questions could not load, or your role cannot answer them | Reload the page, or ask an Owner or Admin |
| **{{ui:onboarding.nis2Step.saveFailed}}** | That answer was not saved | Choose it again |
| **{{ui:onboarding.nis2Step.completeFailed}}** | The assessment was not marked complete | Try again |

## Related

- [{{ui:audits.nav.nis2Gap}}](../comply/nis2-gap.md), every run of the assessment.
- [{{ui:frameworks.readiness.heading}}](nis2-readiness.md), the score your answers make.
- [{{ui:onboarding.wizard.title}}](../overview/onboarding.md), where the assessment first appears.
