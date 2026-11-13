# 2026-11-13 — Tenant residency: the europe-west1 value (#5288, deploy 1 of 2)

## Design

Production runs on one GCP VM in `europe-west1` (Belgium), but every tenant
was recorded, and shown on the privacy page, as `US_EAST_1` "United States
(East)". That is a false residency statement.

The owner's decision (2026-11-13) was to add a europe-west1 value, move every
tenant to it, and correct the docs. It ships in two deploys:

| Deploy | Changes | Writes the value? |
| --- | --- | --- |
| 1 (this) | `TenantRegion.EUROPE_WEST1` + migration; en/bg labels; `PLANNED_REGIONS` entry | no |
| 2 | default `EUROPE_WEST1`; the only provisioned region; backfill every tenant; `data-residency.md` and the privacy guide say EU | yes |

## Decisions

- **A new value, not `EU_WEST_1`.** `EU_WEST_1` is AWS naming for Ireland and
  is labelled that way. Relabelling it as Belgium would have shipped in one
  deploy, but every engineer reading the identifier would picture the wrong
  country (owner's choice).
- **Two deploys.** Watchtower replaces `app` and `worker` separately. A
  container whose Prisma client predates a value fails every `Tenant` read
  that meets it, so no row carries the value until every running client knows
  it. `AI_ADMIN` (#3699) set the precedent.
- **Declared last in the enum**, as a plain `ADD VALUE IF NOT EXISTS`, so the
  migration is a no-op on a re-run.
- **`PLANNED_REGIONS` for one deploy.** The residency guardrail requires every
  value to be provisioned or planned. Provisioning it now would let a tenant be
  created under it while old containers still run.
