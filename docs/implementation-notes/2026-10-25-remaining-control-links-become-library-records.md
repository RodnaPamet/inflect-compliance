# 2026-10-25 — The remaining control links become library records

**Commit:** see the PR (follow-up to #4126)

## Design

#4126 moved the link on a control's Evidence tab into the evidence library and
named two writers of plain `ControlEvidenceLink` rows that were left:
`POST /controls/:id/evidence` for API callers, and the URL box in the controls
list's edit panel, which posts to the same route. Both now go to the library,
because the change is in the route's usecase:

```
before   POST /controls/:id/evidence {kind: LINK, url, note}
           └─► ControlEvidenceLink (no status, not in the library)
after    POST /controls/:id/evidence {kind: LINK, url, note}
           └─► linkEvidence ──► Evidence(LINK, DRAFT, title = note || url)
                              + EvidenceControlLink
                              + audit CREATE Evidence, CONTROL_EVIDENCE_LINKED
```

The response is the new `Evidence` record, not a link row. The route's success
shape was never in the published contract (its OpenAPI entry is a stub), and
the request schema's description now says what a LINK creates. FILE and
INTEGRATION_RESULT kinds are unchanged. No schema change and no migration:
older plain links keep showing on the tab and keep their remove button. Nothing
in the product writes one now, so the e2e that removes one seeds it as a row.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/control/evidence.ts` | `linkEvidence` sends a LINK to `linkEvidenceRecord` |
| `src/lib/schemas/index.ts`, `public/openapi.json` | `EvidenceLinkRequest` describes what a LINK creates |
| `tests/e2e/control-evidence.spec.ts` | The API link is a library record; the plain-link seed is a DB row |

## Decisions

- **The control's gate, not the library's** (owner decision). Going through
  `createEvidence` would add its `evidence.edit` check, and an API key scoped
  `controls:write` without `evidence:write` would start getting 403 for a call
  that worked. The record is written in the control usecase instead, as tasks,
  risks and assets already write theirs, with the same columns `createEvidence`
  writes and the same `CREATE Evidence` audit row. The Evidence tab in the app
  still posts to `/evidence` and still needs `evidence.edit`, as #4126 made it.
- **Titled by the note, else the address** (owner decision). Neither caller
  sends a title, and the task, risk and asset link paths already use
  `note || url`. The note is sanitised first, as theirs is.
- **A LINK with no URL is refused.** It used to write a plain row with no
  address, which the tab rendered as an empty link.
