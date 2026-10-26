# 2026-10-26 — EU drone operations: a class C2 pack, and class names on the subcategory packs

**Commit:** _(stamped post-commit)_ `feat(frameworks): EU drone packs name their aircraft classes, and a class C2 pack installs A2 and A3`

## Design

Operators look for the framework by the class label on their aircraft ("C2"),
while the regulation, and so the packs, are cut by operating subcategory. Two
changes bridge the two without changing the cut:

```
EU_UAS_OPEN_A1   Open category A1: over people (class C0, C1)
EU_UAS_OPEN_A2   Open category A2: close to people (class C2)
EU_UAS_OPEN_A3   Open category A3: far from people (class C2, C3, C4)
EU_UAS_CLASS_C2  Class C2 drone: open category A2 and A3      ← new, = A2 ∪ A3 (22 controls)
EU_UAS_STS_01    Specific category STS-01: VLOS over a populated area (class C5)
EU_UAS_STS_02    Specific category STS-02: BVLOS over a sparsely populated area (class C6)
(operational authorisation and LUC admit any class and keep their names)
```

## Files

| File | Role |
| --- | --- |
| `prisma/fixtures/eu-uas-ops-control-templates.json` | five pack names; the new pack; its `_meta.applicableRequirements` entry |
| `tests/guardrails/eu-uas-framework-coverage.test.ts` | C2's scope is A2's plus A3's; the C2 pack equals A2 ∪ A3; the subcategory names carry their classes |
| `tests/guardrails/framework-starter-pack-completeness.test.ts` | registers the new pack key |
| `tests/integration/eu-uas-framework-install.test.ts` | installing the C2 pack gives exactly the A2 + A3 controls |
| `docs/user/how-to/get-started/add-a-framework.md` | tells a C2 operator which pack to tick |

## Decisions

- **The C2 pack is exactly A2 ∪ A3, held by the guard.** A C2 aircraft may fly
  in A2 or A3 (UAS.OPEN.030, UAS.OPEN.040(4)(c)), so the controls a C2 operator
  needs are those two packs' controls. Defining the class pack as their union,
  rather than curating a subset, means ticking "Class C2" and ticking A2 + A3
  can never install different controls.
- **Its scope includes Article 20.** A3's aircraft-eligibility control covers
  every aircraft assigned to A3 work, legacy ones included, and the C2 pack
  takes it whole. Splitting that control for a C2-only variant would fork a
  fleet-register control into two that drift; the union keeps one.
- **Only C2 gets a class pack.** C0/C1 map to A1, C3/C4 to A3, C5 to STS-01 and
  C6 to STS-02 one-to-one, so the class in each pack's name is enough. C2 is the
  one class that spans two subcategories.
- **Renames propagate.** `applyCatalogFile` writes a pack's name and description
  on update as well as create, so an existing database gets the new names and
  the new pack on its next container start; nothing installed changes.
