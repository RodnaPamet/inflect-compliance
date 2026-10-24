# Refusal codes

When the API refuses a request, it answers with an error code, an HTTP status and a message. Many refusals also carry a reason that names the exact rule that refused. This catalogue is generated on every docs build from the error classes in `src/lib/errors/types.ts` and from every place in `src/` that raises one of them with a named reason.

An error response has this shape:

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "This workspace already has a skill called \"triage\".",
    "details": { "reason": "NAME_TAKEN" },
    "requestId": "…"
  }
}
```

{{generated:refusal-codes}}
