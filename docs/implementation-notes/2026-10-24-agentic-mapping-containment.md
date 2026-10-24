# 2026-10-24 — Agentic mapping strengths: SUBSET is a containment claim

**Commit:** _(stamped post-commit)_ `fix(mappings): 18 agentic edges that read as COVERED become INTERSECT`

## Design

The agentic mapping pairs ship in both directions as exact transposes, with
`SUBSET` ⇄ `SUPERSET` inverted. `determineGapStatus` reads `SUPERSET` as
`COVERED`, so every `SUBSET` in one file is a `COVERED` claim in the other.
The pairs were authored with the documented rule — `SUBSET` where the source
is narrower and covers part of the target. That rule does not see the second
claim, and the transposes ended up holding 19 `COVERED` edges, for example:

- **ASI03 → ISO 27001 A.5.15.** A tenant with an agent identity-and-privilege
  control was told that access control, for every system, is covered.
- **ASI10 → ISO 42001 A.4.2.** Registering agents was read as covering an
  inventory of every AI system resource.

The bar applied here is the one #4060 used for AIUC-1: `SUBSET` / `SUPERSET`
only where meeting the broader requirement, as written, necessarily meets the
narrower one. Each edge was judged on its own.

**18 fail the bar and become `INTERSECT`, with rationales saying why:**

- **The 15 ISO-sourced edges.** ISO 27001 and ISO 42001 controls govern every
  system the organisation runs. An agentic risk control covers part of one,
  never the whole.
- **3 of the 4 OWASP → IMDA edges** (ASI03 → MGF-3.4, ASI04 → MGF-1.5,
  ASI09 → MGF-2.4). The risk, as written, does not prescribe the specific
  measures the MGF requirement does: rotation, pre-ticked defaults,
  approval-rate monitoring.

**One holds: OWASP ASI07 → IMDA MGF-3.6.** The risk's four named failures —
unauthenticated, unauthorised, unbounded and unlogged exchanges — are exactly
what MGF-3.6 requires closed. It stays `SUPERSET`, and its rationale now says
why.

## What a tenant sees

Nothing changes in per-agent risk coverage, the only live reader of these
edges. `SUBSET` and `INTERSECT` are both partial coverage there. What moves:

- **The reported strength:** `INTERSECT`, not `SUBSET`.
- **The route order** for a risk reached from several ISO controls. With the
  strengths now tied, the tie-break decides: framework key, then requirement
  code.

The `COVERED` claims were all in the reverse direction, read by no route
today. The gap-analysis usecase that would have shown them has no route, and
fixing them first means they cannot appear when it gets one.

## Files

| File | Role |
|---|---|
| `src/data/libraries/mappings/{iso27001,iso-42001}-to-owasp-agentic.yaml` + reverses | 13 edges → `INTERSECT` |
| `src/data/libraries/mappings/iso-42001-to-imda-mgf.yaml` + reverse | 2 edges → `INTERSECT` |
| `src/data/libraries/mappings/owasp-agentic-to-imda-mgf.yaml` + reverse | 3 → `INTERSECT`, ASI07 → MGF-3.6 kept with a containment rationale |
| `tests/unit/agentic-framework-mappings.test.ts` | Two assertions rewritten (see Decisions) |
| `tests/integration/agent-coverage-analysis.test.ts` | Tenants C and F expect `INTERSECT` and the tie-break order |
| `tests/integration/inherited-control-data-usecase.test.ts` | Teardown clears the tenant's audit rows before deleting it |
| `docs/requirement-mapping-sets.md` | `SUBSET` guidance now states containment, with the A.5.15 trap as the example |

## Decisions

### Two test assertions encoded the old rule

The unit suite asked the ISO 42001 → ASI map for at least three distinct
strengths. Only a `SUBSET` could supply the third, and every `SUBSET` there
failed. The assertion was protecting against a map of nothing but `RELATED`
edges, so it now checks that directly: at least a third of the routes are
coverage-bearing.

The `SUBSET` ⇄ `SUPERSET` inversion check was pinned to the ISO 42001 pair. It
now searches every agentic set and inverts each directional edge it finds,
which today is the one.

### No registry of containment edges

A list naming every permitted `SUBSET` / `SUPERSET` was considered and not
added. It would pin the shape of this diff, and no test can judge whether a
containment argument is sound. The rule lives in the authoring guidance, and
each surviving directional edge carries its argument in the rationale.

### The teardown fix rides along

`inherited-control-data-usecase.test.ts` deleted its tenant without clearing
the tenant's audit rows. `AuditLog_tenantId_fkey` is `ON DELETE RESTRICT`, so
the teardown failed wherever audit rows existed for the tenant (locally, on
every run; CI happened not to). It now calls `deleteAuditRowsForTenants`, as
the other suites do, and goes red again without it.
