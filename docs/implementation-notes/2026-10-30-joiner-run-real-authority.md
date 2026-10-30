# 2026-10-30 — A manual joiner pass carries its requester's real authority, or none (#4400)

## Design

This applies the leaver pass's change (`2026-10-30-leaver-pass-real-authority.md`) to the joiner. A joiner pass someone starts with "Run now" used to act on `buildDelegatedJobContext`. That was an ADMIN-shaped context in the requester's name, checked only when the route queued the pass. At AUTOMATIC it creates directory accounts, and every step of each create (create, group, credential, enable) is journalled with that context's user id.

The joiner now resolves its actor through the same `resolvePassActor`:

- **The requester is still ACTIVE and holds `admin.tenant_lifecycle`.** The pass runs with their real membership, and the journal names them.
- **The requester was removed, is not ACTIVE, or lacks the key.** The pass runs under the 04:30 pass's own `buildSystemContext`, and the journal carries `'system'`. The execution row's `resultJson.request` records who asked and why their authority was refused.
- **`triggeredBy`** is read off the request, so a refused manual pass still says `manual`.

This was the last of #4400's borrowing callers. `buildDelegatedJobContext` is left with four callers that act for a named member (control-test runner, agentic evidence emission, integration passport sweep, agent kill-switch drill), which #4388 classified separately.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/identity-joiner-run.ts` | Resolves its actor through `resolvePassActor`, and every execution-row writer takes the `PassTrigger` |
| `src/app-layer/usecases/identity-pass-requester.ts` | Header covers both passes |
| `src/app-layer/context-system.ts` | Docblocks: neither identity pass calls `buildDelegatedJobContext` |
| `tests/unit/identity-joiner-run.test.ts` | Which context every read and write gets, and the request block on the plan and error rows |
| `tests/integration/identity-joiner-pass-requester-authority.test.ts` | The real pass at AUTOMATIC against a real database, with only the provisioner and writer faked |

## Decisions

- **The joiner's reason to fall back is different from the leaver's, and the rule is the same.** Refusing a joiner pass leaves no departed employee enabled. It holds back a starter's account until 04:30. What makes the fallback safe is shared by both passes: the schedule runs the same pass on the job's own authority whatever anybody asks, so a request changes only when it runs.
- **Still `buildSystemContext`, not the tenant SYSTEM user.** The joiner's writes are the execution row and its journal steps, and neither has a `User` foreign key. `createDirectoryAccount` is given no HRIS write-back today, so it writes nothing else.
