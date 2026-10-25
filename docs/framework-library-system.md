# Framework Library System

> YAML-based framework catalog with import/update pipeline and runtime consumption.

## Overview

The framework library system replaces hardcoded TypeScript framework definitions with a scalable YAML-based catalog. Frameworks are defined as YAML files, parsed and validated at load time, and consumed through a unified runtime provider.

### Architecture

```
YAML Files (src/data/libraries/)
    │
    ▼
┌── Library Loader ──────────────────────────────┐
│ Parse → Validate (Zod) → Normalize → Index     │
│ Output: LoadedLibrary (in-memory, O(1) lookups) │
└────────────────────┬───────────────────────────┘
                     │
        ┌────────────┼────────────────┐
        ▼            ▼                ▼
  Framework     Library Importer   Framework Provider
  Provider      (DB persistence)   (Legacy compat)
  (Runtime)     ┌──────────────┐   ┌────────────────┐
  ┌──────────┐  │ Hash compare │   │ SOC2_REQS()    │
  │ byRefId  │  │ Diff engine  │   │ NIS2_REQS()    │
  │ byURN    │  │ Strategies   │   │ CLAUSES()      │
  │ byNode   │  │ Prisma upsert│   │ MAPPINGS()     │
  └──────────┘  └──────────────┘   └────────────────┘
```

## YAML Catalog Structure

Each framework has one YAML file in `src/data/libraries/`:

```
src/data/libraries/
├── iso27001-2022.yaml   # ISO 27001:2022 (93 Annex A controls + 7 ISMS clauses)
├── nist-csf-2.0.yaml    # NIST CSF v2.0 (27 functions/categories/subcategories)
├── soc2-2017.yaml       # SOC 2 Trust Services Criteria (22 criteria)
└── nis2-2022.yaml       # NIS2 Directive (12 requirement areas)
```

### YAML File Format

```yaml
urn: urn:inflect:library:<framework-id>
locale: en
ref_id: FRAMEWORK-KEY           # Used as Framework.key in Prisma
name: Human Readable Name
description: Optional description
version: 1                      # Monotonically increasing integer
text_hash: <sha256>             # computeLibraryTextHash; the guard prints the value
kind: ISO_STANDARD              # ISO_STANDARD | NIST_FRAMEWORK | SOC_CRITERIA | ...
provider: Standards Body Name
packager: Inflect Compliance

objects:
  framework:
    urn: urn:inflect:framework:<framework-id>
    ref_id: FRAMEWORK-KEY
    name: Framework Name
    min_score: 0
    max_score: 4
    scores:
      - score: 0
        name: Not Assessed
      - score: 4
        name: Fully Implemented
    requirement_nodes:
      - urn: urn:inflect:req:<framework-id>:<node-id>
        ref_id: A.5.1             # Stable identifier
        name: Information Security Policies
        description: ...
        depth: 1
        assessable: true          # true = leaf that can be scored
        category: Organizational
        artifacts: "Policy document, Procedure document"  # Expected evidence
        checklist:                # Implementation checklist
          - Review existing policies
          - Draft new policies

  # Optional cross-framework mappings
  mapping:
    - source_urn: urn:inflect:req:iso27001-2022:a.5.1
      target_urn: urn:inflect:req:soc2-2017:cc1.1
      strength: strong
      rationale: Both address policy governance.
```

## URN Addressing Model

Every framework, library, and requirement node has a globally unique URN:

| Type | Format | Example |
|------|--------|---------|
| Library | `urn:inflect:library:<id>` | `urn:inflect:library:iso27001-2022` |
| Framework | `urn:inflect:framework:<id>` | `urn:inflect:framework:nist-csf-2.0` |
| Requirement | `urn:inflect:req:<framework>:<node>` | `urn:inflect:req:iso27001-2022:a.5.1` |

URNs are:
- **Immutable**: Once assigned, a URN never changes
- **Unique**: Validated at load time across all libraries
- **Hierarchical**: Child nodes reference parent URNs for tree structure

## Loader / Importer / Updater Flow

### Phase 1: Load (in-memory)

```typescript
import { loadAllFromDirectory, getLibraryByRefId } from '@/app-layer/libraries';

// Load all YAML files into memory
const libs = loadAllFromDirectory('src/data/libraries');

// Get a specific framework
const iso = getLibraryByRefId('ISO27001-2022');
const node = iso.framework.nodesByRefId.get('A.5.1');
```

### Phase 2: Import (to database)

```typescript
import { syncAllLibraries, previewSync } from '@/app-layer/usecases/library-sync';

// Preview what would change
const preview = await previewSync(db);

// Import/update all libraries
const result = await syncAllLibraries(db);
// { created: 3, updated: 0, skipped: 0 }

// Force reimport
await syncAllLibraries(db, { force: true });

// Use a migration strategy
await syncAllLibraries(db, { strategy: 'preserve' });
```

### Delivery to a deployed database

Every container start runs `dist/sync-framework-libraries.mjs`
(`scripts/sync-framework-libraries.ts`, `npm run db:sync-libraries` in a
checkout) right after the catalogue seed. It calls `syncLibrariesAtStartup`,
which imports every library and mapping set whose content hash has changed and
skips the rest, so an unchanged start writes nothing.

- **A row with a pack belongs to the catalogue.** `AIUC-1` and `COSO-ICF-2013`
  are written by their catalogue fixture under the library's own key, so the
  sync does not import those two libraries. Their mapping sets still import:
  they resolve against the catalogue's row by key and code.
- **The YAML ships in the image.** The Dockerfile copies `src/data/libraries`
  into `/app`, and the script passes that directory explicitly. `LIBRARIES_DIR`
  resolves from `__dirname`, which in a bundle is `dist/`.
- **The offer lists show one row per framework.** `listFrameworks` (the
  Frameworks page, its API and the MCP resource) and the control-mapping picker
  leave out a library row whose family also has an installable catalogue row,
  through `withoutReferenceTwins`. A library-only framework, such as GDPR or
  NIST CSF 2.0, is listed.

The "framework libraries reach production" block of
`tests/guardrails/catalogue-reaches-production.test.ts` holds the wiring, and
`tests/integration/framework-library-startup-sync.test.ts` holds what the sync
writes.

### Deduplication

Every library has a SHA-256 content hash computed from its URN, version, and all requirement node URNs. On import:

1. **Hash match** → skip entirely (zero DB writes)
2. **Hash mismatch** → compute requirement diff → apply strategy → upsert

The hash does not cover the text, so **a change to a library's text must bump
its `version`**. A reworded title or description, or a changed copyright line,
under the same version is skipped by every database that already holds the
library. The version is the right signal rather than a text-covering hash: each
version transition records one `FrameworkVersionDiff` and notifies tenants
once, and two same-version edits would land on one diff row.

Each library file records `text_hash`, `computeLibraryTextHash` of its content
(everything but `version` and the hash itself), beneath `version`. The
"a library's text change reaches a database that already holds it" block of
`tests/guardrails/catalogue-reaches-production.test.ts` fails while the two
disagree, and names the version and hash to write.

A mapping set's hash (`computeMappingSetHash`) covers its whole parsed content,
the rationales included, so a reworded rationale reaches every database without
a version bump. A mapping set records no diff, so it needs none.

### Migration Strategies

| Strategy | Behavior | When to Use |
|----------|----------|-------------|
| `preserve` | Keep data, add new, deprecate removed | Default for production |
| `clamp` | Preserve + flag score recalculation | When max_score changes |
| `reset` | Clear assessment data for changed reqs | Major framework overhaul |
| `rule-of-three` | Only apply changes stable for 3+ versions | Draft/unstable standards |

The `rule-of-three` strategy is version-history-aware. When sufficient version history exists (≥3 entries), it uses actual multi-version stability analysis to determine which removals and changes are safe. Without history, it falls back to conservatively suppressing all removals.

## Dependency Graph Resolution

Libraries can declare dependencies on other libraries via the `dependencies` field:

```yaml
urn: urn:inflect:library:gdpr-mapping
dependencies:
  - urn:inflect:library:iso27001-2022
```

When importing multiple libraries, the import pipeline resolves dependencies using topological sort (Kahn's algorithm):

- **Dependencies load first** — deterministic, stable ordering
- **Cycle detection** — throws `DependencyCycleError` with clear cycle path
- **Missing dependencies** — warned but not fatal (allows incremental import)

```typescript
import { resolveDependencies, sortLibrariesByDependency } from '@/app-layer/libraries';

// Check dependency status
const resolution = resolveDependencies(libraries);
console.log(resolution.fullyResolved); // true if all deps present
console.log(resolution.order);         // URNs in dependency-first order
```

## Version History

Every framework import appends a version history entry to `Framework.metadataJson`. This enables the `rule-of-three` strategy to make data-driven stability decisions.

### History Entry Schema

```json
{
  "version": 2,
  "contentHash": "sha256...",
  "importedAt": "2026-04-15T21:00:00.000Z",
  "requirementCodes": ["A.5.1", "A.5.2"],
  "addedCodes": ["A.5.3"],
  "removedCodes": ["A.5.99"],
  "changedCodes": ["A.5.1"]
}
```

### Stability Analysis

| Function | Purpose |
|----------|---------|
| `getStablyRemovedCodes(history, 3)` | Codes absent for 3+ consecutive versions |
| `getStablyAddedCodes(history, codes, 3)` | Codes present for 3+ consecutive versions |
| `getStablyChangedCodes(history, codes, 3)` | Changes unchanged for 3+ subsequent versions |

## Runtime Consumption Model

### New Code (Recommended)

```typescript
import {
    getLibraryByRefId,
    findNodeByUrn,
    findNodeByRefId,
    getAssessableNodes,
    listAvailableFrameworks,
} from '@/app-layer/libraries';

// Get all assessable requirements for a framework
const nodes = getAssessableNodes('ISO27001-2022');

// Look up a specific node by URN (cross-framework)
const node = findNodeByUrn('urn:inflect:req:soc2-2017:cc1.1');

// List available frameworks
const frameworks = listAvailableFrameworks();
```

### Legacy-Compatible Code (Transitional)

For existing consumers that expect the old data shapes:

```typescript
import {
    getSOC2Requirements,     // Returns FrameworkInfo[] (same shape as old SOC2_REQUIREMENTS)
    getNIS2Requirements,     // Returns FrameworkInfo[] (YAML-primary)
    getISO27001Clauses,      // Returns ClauseInfo[] (YAML-primary)
    getFrameworkMappings,    // Returns GuidanceMapping[] (YAML-primary)
} from '@/app-layer/libraries';
```

These functions:
1. Try to load from YAML-backed libraries first
2. Fall back to hardcoded data if YAML isn't available
3. Return the exact same shape as the old imports

## Rollout and Legacy Deprecation

### Current State

| Data Source | Primary | Fallback | Status |
|-------------|---------|----------|--------|
| ISO 27001 Annex A | YAML | None needed | ✅ Migrated |
| ISO 27001 Clauses 4–10 | YAML | Hardcoded | ✅ YAML-primary (with artifacts/checklist) |
| SOC 2 Criteria | YAML | Hardcoded | ✅ YAML-primary |
| NIST CSF 2.0 | YAML | None needed | ✅ Migrated |
| NIS2 Requirements | YAML | Hardcoded | ✅ YAML-primary |
| Cross-Framework Mappings | YAML | Hardcoded | ✅ YAML-primary (72 mapping entries) |

### Legacy Files (Deprecated)

These files in `src/data/` have `@deprecated` JSDoc headers:

| File | Status | Removal Criteria |
|------|--------|-----------------|
| `frameworks.ts` | Deprecated | Safe to remove — all data migrated to YAML (safety fallback only) |
| `clauses.ts` | Deprecated | Safe to remove — all data migrated to YAML (safety fallback only) |
| `annex-a.ts` | Deprecated | No runtime consumers — safe to remove now |

### Migration Path for New Frameworks

To add a new framework:
1. Create `src/data/libraries/<framework-id>.yaml`
2. Follow the YAML schema (see above)
3. Run `syncAllLibraries(db)` to import
4. No code changes needed

## Database Schema

### Framework Model

```prisma
model Framework {
  id           String                 @id @default(cuid())
  key          String                 @unique
  name         String
  version      String?
  contentHash  String?                // SHA-256 for dedup
  sourceUrn    String?                // Library URN
  updatedAt    DateTime               @updatedAt
  kind         FrameworkKind
  requirements FrameworkRequirement[]
}

enum FrameworkKind {
  ISO_STANDARD
  NIST_FRAMEWORK
  SOC_CRITERIA
  EU_DIRECTIVE
  REGULATION
  INDUSTRY_STANDARD
  CUSTOM
}
```

## File Map

```
src/app-layer/libraries/
├── schemas.ts              # Zod schemas for YAML validation
├── types.ts                # LoadedLibrary, LoadedFramework, LoadedRequirementNode
├── library-loader.ts       # YAML parse → validate → normalize → index
├── dependency-graph.ts     # Topological sort + cycle detection
├── version-history.ts      # Append-only version tracking + rule-of-three analysis
├── framework-provider.ts   # Runtime adapter (YAML-first, hardcoded fallback)
└── index.ts                # Barrel exports (50+ exports)

src/app-layer/services/
├── library-importer.ts     # Hash-compare → dep-order → version-history → Prisma upsert
└── library-updater.ts      # Diff engine + history-aware migration strategies

src/app-layer/usecases/
└── library-sync.ts         # Orchestration (sync-all, sync-one, preview)

src/data/libraries/
├── iso27001-2022.yaml
├── nist-csf-2.0.yaml
├── soc2-2017.yaml
└── nis2-2022.yaml

src/data/                   # @deprecated — legacy hardcoded data
├── frameworks.ts
├── clauses.ts
└── annex-a.ts

tests/unit/
├── dependency-graph.test.ts   # 22 tests (topo sort, cycles, missing deps)
├── version-history.test.ts    # 31 tests (history CRUD, rule-of-three, metadata)
├── library-loader.test.ts     # 43 tests (parse, validate, load, NIS2, artifacts, mappings)
├── library-updater.test.ts    # 35 tests (diff, strategies, idempotency)
├── library-importer.test.ts   # 13 tests (hash dedup, kind mapping)
└── framework-provider.test.ts # 41 tests (lookups, YAML-primary, mappings, cache)
```
