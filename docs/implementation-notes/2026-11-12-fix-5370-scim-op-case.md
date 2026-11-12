# 2026-11-12 — SCIM PATCH reads Entra's operations (#5370)

**Commit:** `fix(scim): read PatchOp op case-insensitively, accept filter-form member remove and string booleans (#5370)`

## Design

Both SCIM patch usecases compared the PatchOp `op` with `===` against the
lower-case literals. RFC 7644 §3.5.2 makes it case-insensitive, and Microsoft
Entra sends `"Add"` / `"Remove"` / `"Replace"`, so every Entra PATCH matched no
branch and returned 200 with nothing changed:

- `scimPatchGroup`: a member removed from a role-mapped group stayed in
  `memberIds` and kept the role the group mapped to.
- `scimPatchUser`: a user disabled in Entra stayed ACTIVE.

Two neighbouring defects on the same request shapes:

- Entra removes a group member by filter, `path: 'members[value eq "<oid>"]'`
  with no `value`. The lower-cased path matched no branch.
- `active` was true only for `true` / `'true'`, so `"True"` (under a
  lower-case `op`, which did reach the branch) DEACTIVATED the user.

One new module, `src/lib/scim/patch.ts`, is read by both usecases:

```
raw Operations ──normaliseScimPatchOperations──▶ { op: 'add'|'remove'|'replace', path, value }[]
                    │  not an object / op not one of the three → 400 invalidSyntax
                    │  path not a string                       → 400 invalidPath
active value ──readScimBoolean──▶ true | false, or 400 invalidValue
group path  ──memberValueFromFilterPath──▶ "<oid>" | null
```

Every operation is validated before either usecase writes anything, so a
PatchOp containing one bad operation applies none (§3.5.2: "If any operation
fails, the whole request fails"). The 400 is a `ScimInvalidPatchError`, a
`ScimAuthError` subclass like `ScimForbiddenError` and
`ScimUnresolvableMemberError`, so every SCIM route already renders it in the
SCIM error shape without a route change.

## Files

| File | Role |
| --- | --- |
| `src/lib/scim/patch.ts` | New: op normalisation, SCIM boolean reader, member filter-path parser, `ScimInvalidPatchError` |
| `src/app-layer/usecases/scim-groups.ts` | `scimPatchGroup` normalises ops, applies a filter-form remove, refuses any other `members[...]` path |
| `src/app-layer/usecases/scim-users.ts` | `scimPatchUser` normalises ops and reads `active` (path and no-path forms) through `readScimBoolean` |
| `src/lib/scim/types.ts` | `ScimPatchOp.Operations[].op` is `string`: it is IdP input, not the three-verb union |
| `tests/integration/scim-patch-entra-shapes.test.ts` | Real-DB test with Entra's payload shapes, reading the membership back |

## Decisions

- **Refuse an unknown `op`, do not skip it.** Before this, both usecases
  ignored it and answered 200. The IdP then records the change as applied and
  never retries. `invalidSyntax` is the RFC 7644 §3.12 type for a body that
  does not conform to the request schema.
- **A non-boolean `active` is refused, never defaulted.** Both possible
  defaults are a status write: defaulting to false is how `"True"` deactivated
  people.
- **A `members[...]` path is accepted only as a `remove` of
  `members[value eq "<id>"]`.** Any other filter on members (`add` with a
  filter, a different attribute or operator) is a 400 `invalidPath` rather than
  a silent no-op. The quoted id is not case-folded: it is matched against
  `UserIdentityLink.externalSubject` exactly, as the array form is.
- **The no-path `replace` was already handled** (`{ op: "Replace", value:
  { active: false } }`); it was unreachable only because of the case
  comparison. Its `active` now goes through the same boolean reader. A no-path
  value that is not an object stays a no-op, as before.
- **Left as they were**, being outside the reported defect: `remove` on a user
  attribute is still a no-op, `replace` of a group's whole `members` is still
  ignored (Entra sends Add/Remove for members, not Replace), and a `remove` of
  `members` with no value still removes nobody rather than everybody.
