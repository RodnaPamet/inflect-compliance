# Integration & check observability — operator runbook

Inflect is a monitoring product whose defining failure mode is a check going
green — or a sync corrupting data — **silently**. The generic
`job.execution.count` only reflects whether the job *wrapper* returned; it stays
`success` even when a collector internally recorded `ERROR`, resolved a false
`PASSED`, or a sync deprovisioned the tail. The domain metrics below (module
`src/lib/observability/integration-metrics.ts`) make each of those alertable.

All of these are **out-of-band + fail-safe** — none gate `/api/readyz` (like the
audit-stream metrics, escalation is alert-based, not readiness-based).

## Metrics

| Metric | Type | Labels | Emitted from |
| --- | --- | --- | --- |
| `integration.check.outcome` | counter | `provider`, `check.type`, `status` | `automation-runner` on every `IntegrationExecution` finalize |
| `integration.check.duration` | histogram (ms) | same | same |
| `integration.check.staleness_seconds` | observable gauge | `provider` | in-memory; seconds since the provider's last recorded outcome |
| `integration.sync.truncated` | counter | `provider` | identity-sync / hris-sync when an enumeration hits the cap |
| `integration.identity.deprovisioned` | counter | `provider` | identity-sync reconcile (adds the batch size) |
| `integration.device.report` | counter | — | `reportDevice` on every ingest |
| `ai.generation.count` | counter | `feature` | questionnaire (per question) + assistant (per ask) |
| `ai.generation.tokens` | histogram | `feature` | when the provider reports token usage |
| `agentic.policy_card.evaluation` | counter | `outcome`, `surface` | `assertWithinPolicyCard`, once per call through the MCP gate |
| `agentic.policy_card.refusal` | counter | `agent`, `rule`, `escalate`, `risk.tier`, `surface` | the same function, on every policy-card refusal |

`status` includes `NOT_APPLICABLE` (H2) as a first-class value so "went green"
is distinguishable from "no data" on the dashboard.

`agentic.policy_card.evaluation`'s `outcome` partitions all traffic through the
gate into `allowed` / `refused` / `no_card` / `no_agent`, and the last two are
deliberately separate: `no_card` is a REGISTERED AGENT with no policy card — the
governance gap — while `no_agent` is a human, an ordinary integration key, or a
tenant with the register switched off. Folded together, a tenant that runs no
agents would be indistinguishable from one running agents nobody has written a
card for. It is also the denominator that turns the refusal counter into a rate:
refusals climbing while evaluations hold flat is a policy change, both climbing
together is a traffic change.

`agentic.policy_card.refusal` carries the AGENT and the RULE on one series
because that pair is what separates the two things refusal volume can mean — a
misconfigured card (one agent, one rule, starting at an edit) from an agent
operating outside its intended envelope (one agent, spread across rules, or
burning its action budgets). `agent` is a label here while `tenant.id` is a
label nowhere: this series exists only for an agent that has actually been
refused, which in a healthy deployment is none, whereas a tenant label on a
request counter creates a series per tenant unconditionally.

## Alert conditions

| Condition | Signal | Why |
| --- | --- | --- |
| Collector error surge | `rate(integration.check.outcome{status="ERROR"})` climbs | a broken/revoked-credential collector (H2 fail-closed) |
| Silently-dead collector | `integration.check.staleness_seconds{provider}` `> 7d` | a provider stopped emitting outcomes entirely (H2-C1) |
| Silent truncation | `increase(integration.sync.truncated) > 0` | a directory/roster larger than the cap (H3) — data-integrity risk |
| Wrongful mass-deprovision | `increase(integration.identity.deprovisioned)` spikes vs baseline | the H3 wrongful-deprovision signature |
| Device-report abuse | `rate(integration.device.report)` spikes | a leaked/looping device token (H3) |
| AI cost spike | `rate(ai.generation.count)` / `ai.generation.tokens` climbs | the H4 questionnaire amplification |
| An agent hit a refusal its own card asked to be woken for | any `agentic.policy_card.refusal{escalate="true"}` | the card DECLARED that rule as an escalation trigger; page on the first one |
| An agent operating outside its envelope | `count(count by (rule) (increase(agentic_policy_card_refusal_total{agent="X"}[1h]))) >= 3` | one agent tripping three different declarations in an hour is the SPREAD that separates this from a mis-edited card, which concentrates on one rule |
| A misconfigured card | `increase(agentic_policy_card_refusal_total{agent="X",rule="Y"}[1h])` climbs on ONE rule after a card edit | the fix is an edit; nobody needs waking |
| Governance gap | `agentic.policy_card.evaluation{outcome="no_card"}` is a large share | registered agents are running with no policy card at all, which produces zero refusals for ever and so is invisible in the refusal counter |

Tune thresholds per tenant volume; the truncation + deprovision-spike alerts
should be **page-worthy** (silent data corruption), the rest ticket-worthy.

## Not on the readyz path

These are deliberately kept off `/api/readyz` (`src/app/api/readyz/route.ts`) —
the check/sync paths are out-of-band and fail-safe (the execution row is already
committed), exactly like the audit-stream delivery metrics. A dead collector is
an alert, not a reason to fail readiness and roll back a deploy.
