/**
 * Library Loader — Core service for parsing, validating, and loading
 * YAML-based framework library files.
 *
 * Responsibilities:
 * 1. Read YAML from disk
 * 2. Validate against the StoredLibrary Zod schema
 * 3. Normalize into a LoadedLibrary with indexed lookups
 * 4. Enforce URN uniqueness within a library
 * 5. Produce content hashes for deduplication
 *
 * This service does NOT interact with Prisma or the database.
 * It is a pure data transformation layer.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as yaml from 'js-yaml';
import { StoredLibrarySchema, type StoredLibrary, type RequirementNode, type MappingEntry } from './schemas';
import { logger } from '@/lib/observability/logger';
import { canonicalJson } from '@/lib/canonical-json';
import type {
    LoadedLibrary,
    LoadedFramework,
    LoadedRequirementNode,
    LoadedMapping,
    LibraryRegistryEntry,
} from './types';

// ─── Error Types ─────────────────────────────────────────────────────

export class LibraryParseError extends Error {
    constructor(
        public readonly filePath: string,
        public readonly details: string,
        public readonly cause?: unknown,
    ) {
        super(`Failed to parse library "${filePath}": ${details}`);
        this.name = 'LibraryParseError';
    }
}

export class LibraryValidationError extends Error {
    constructor(
        public readonly filePath: string,
        public readonly issues: Array<{ path: string; message: string }>,
    ) {
        const summary = issues.map(i => `  - ${i.path}: ${i.message}`).join('\n');
        super(`Library validation failed for "${filePath}":\n${summary}`);
        this.name = 'LibraryValidationError';
    }
}

export class LibraryUrnCollisionError extends Error {
    constructor(
        public readonly filePath: string,
        public readonly duplicateUrns: string[],
    ) {
        super(`Duplicate URNs found in "${filePath}": ${duplicateUrns.join(', ')}`);
        this.name = 'LibraryUrnCollisionError';
    }
}

// ─── Core Loader ─────────────────────────────────────────────────────

/**
 * Parse a YAML file from disk into a validated StoredLibrary.
 * This is phase 1: Store → Parse → Validate
 *
 * @throws LibraryParseError if YAML parsing fails
 * @throws LibraryValidationError if schema validation fails
 */
export function parseLibraryFile(filePath: string): StoredLibrary {
    // Read file
    let rawContent: string;
    try {
        rawContent = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
        throw new LibraryParseError(filePath, 'Failed to read file', err);
    }

    // Parse YAML
    let rawData: unknown;
    try {
        rawData = yaml.load(rawContent);
    } catch (err) {
        throw new LibraryParseError(filePath, 'Invalid YAML syntax', err);
    }

    if (!rawData || typeof rawData !== 'object') {
        throw new LibraryParseError(filePath, 'YAML content is not an object');
    }

    // Validate against schema
    const result = StoredLibrarySchema.safeParse(rawData);
    if (!result.success) {
        const issues = result.error.issues.map(issue => ({
            path: issue.path.join('.'),
            message: issue.message,
        }));
        throw new LibraryValidationError(filePath, issues);
    }

    return result.data;
}

/**
 * Parse a YAML string (not from file) into a validated StoredLibrary.
 * Useful for testing and in-memory operations.
 */
export function parseLibraryString(content: string, sourceName: string = '<string>'): StoredLibrary {
    let rawData: unknown;
    try {
        rawData = yaml.load(content);
    } catch (err) {
        throw new LibraryParseError(sourceName, 'Invalid YAML syntax', err);
    }

    if (!rawData || typeof rawData !== 'object') {
        throw new LibraryParseError(sourceName, 'YAML content is not an object');
    }

    const result = StoredLibrarySchema.safeParse(rawData);
    if (!result.success) {
        const issues = result.error.issues.map(issue => ({
            path: issue.path.join('.'),
            message: issue.message,
        }));
        throw new LibraryValidationError(sourceName, issues);
    }

    return result.data;
}

/**
 * Validate URN uniqueness within a StoredLibrary.
 * Requirement node URNs must be unique within the same library.
 *
 * @throws LibraryUrnCollisionError if duplicates are found
 */
export function validateUrnUniqueness(stored: StoredLibrary, filePath: string = '<unknown>'): void {
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const node of stored.objects.framework.requirement_nodes) {
        if (seen.has(node.urn)) {
            duplicates.push(node.urn);
        }
        seen.add(node.urn);
    }

    if (duplicates.length > 0) {
        throw new LibraryUrnCollisionError(filePath, duplicates);
    }
}

/**
 * Validate parent_urn references are valid within the framework.
 * Every parent_urn must point to an existing node within the same framework.
 */
export function validateParentReferences(stored: StoredLibrary, filePath: string = '<unknown>'): void {
    const allUrns = new Set(stored.objects.framework.requirement_nodes.map(n => n.urn));
    const broken: Array<{ node: string; parent: string }> = [];

    for (const node of stored.objects.framework.requirement_nodes) {
        if (node.parent_urn && !allUrns.has(node.parent_urn)) {
            broken.push({ node: node.urn, parent: node.parent_urn });
        }
    }

    if (broken.length > 0) {
        const issues = broken.map(b => ({
            path: `objects.framework.requirement_nodes[urn=${b.node}].parent_urn`,
            message: `Parent URN "${b.parent}" does not exist in this framework`,
        }));
        throw new LibraryValidationError(filePath, issues);
    }
}

// ─── Normalization (Phase 2) ─────────────────────────────────────────

/**
 * Transform a raw RequirementNode into a LoadedRequirementNode.
 * Child URNs are computed after all nodes are processed.
 */
function normalizeNode(raw: RequirementNode, childUrns: string[]): LoadedRequirementNode {
    return {
        urn: raw.urn,
        refId: raw.ref_id,
        name: raw.name,
        description: raw.description,
        annotation: raw.annotation,
        depth: raw.depth,
        assessable: raw.assessable,
        category: raw.category,
        section: raw.section,
        artifacts: raw.artifacts,
        checklist: raw.checklist,
        parentUrn: raw.parent_urn,
        childUrns,
    };
}

/**
 * Transform a MappingEntry into a LoadedMapping.
 */
function normalizeMapping(raw: MappingEntry): LoadedMapping {
    return {
        sourceUrn: raw.source_urn,
        targetUrn: raw.target_urn,
        strength: raw.strength,
        rationale: raw.rationale,
    };
}

/**
 * Compute a content hash for deduplication.
 * Uses SHA-256 over the library URN, version, and all requirement node URNs.
 *
 * It does NOT cover the text: a title, a description or the framework's
 * metadata can change under the same version and the import skips it. That is
 * what makes the version the delivery signal, and `computeLibraryTextHash`
 * plus its guard are what make sure the version moves when the text does.
 */
function computeContentHash(stored: StoredLibrary): string {
    const hashInput = [
        stored.urn,
        stored.version.toString(),
        ...stored.objects.framework.requirement_nodes.map(n => n.urn),
    ].join('|');

    return crypto.createHash('sha256').update(hashInput).digest('hex');
}

/**
 * The fingerprint a library file records in `text_hash`: SHA-256 over the
 * canonical JSON of everything the file says except its `version` and the
 * hash itself.
 *
 * Taken over the PARSED library, so comments and formatting do not move it, and
 * neither does spelling out a value the schema would default. A version bump
 * alone does not move it either: a bump with no text change needs no new hash.
 */
export function computeLibraryTextHash(stored: StoredLibrary): string {
    const { version: _version, text_hash: _textHash, ...content } = stored;
    return crypto.createHash('sha256').update(canonicalJson(content)).digest('hex');
}

/**
 * Load a validated StoredLibrary into a fully indexed LoadedLibrary.
 * This is phase 2: Validate → Normalize → Index
 *
 * The resulting LoadedLibrary provides:
 * - O(1) lookups by URN and ref_id
 * - Resolved parent/child tree structure
 * - Content hash for deduplication
 */
export function loadLibrary(stored: StoredLibrary, filePath: string = '<unknown>'): LoadedLibrary {
    // Validate integrity
    validateUrnUniqueness(stored, filePath);
    validateParentReferences(stored, filePath);

    const rawNodes = stored.objects.framework.requirement_nodes;

    // Build child URN map: parent_urn → [child urns]
    const childMap = new Map<string, string[]>();
    for (const node of rawNodes) {
        if (node.parent_urn) {
            const children = childMap.get(node.parent_urn) ?? [];
            children.push(node.urn);
            childMap.set(node.parent_urn, children);
        }
    }

    // Normalize all nodes
    const loadedNodes: LoadedRequirementNode[] = rawNodes.map(node =>
        normalizeNode(node, childMap.get(node.urn) ?? [])
    );

    // Build index maps
    const nodesByUrn = new Map<string, LoadedRequirementNode>();
    const nodesByRefId = new Map<string, LoadedRequirementNode>();
    for (const node of loadedNodes) {
        nodesByUrn.set(node.urn, node);
        nodesByRefId.set(node.refId, node);
    }

    // Extract root nodes (no parent)
    const rootNodes = loadedNodes.filter(n => !n.parentUrn);

    // Build framework object
    const fw = stored.objects.framework;
    const framework: LoadedFramework = {
        urn: fw.urn,
        refId: fw.ref_id,
        name: fw.name,
        description: fw.description,
        scoring: fw.min_score != null && fw.max_score != null
            ? {
                min: fw.min_score,
                max: fw.max_score,
                definitions: fw.scores_definition ?? [],
            }
            : undefined,
        nodes: loadedNodes,
        nodesByUrn,
        nodesByRefId,
        rootNodes,
    };

    // Normalize mappings
    const mappings: LoadedMapping[] = (stored.objects.mappings ?? []).map(normalizeMapping);

    return {
        urn: stored.urn,
        locale: stored.locale,
        refId: stored.ref_id,
        name: stored.name,
        description: stored.description,
        copyright: stored.copyright,
        version: stored.version,
        publicationDate: stored.publication_date,
        provider: stored.provider,
        packager: stored.packager,
        kind: stored.kind,
        dependencies: stored.dependencies ?? [],
        framework,
        mappings,
        contentHash: computeContentHash(stored),
    };
}

// ─── Directory Scanner ───────────────────────────────────────────────

/**
 * Scan a directory for .yaml/.yml framework library files.
 * Returns registry entries (metadata only, not loaded).
 */
export function scanLibraryDirectory(dirPath: string): LibraryRegistryEntry[] {
    if (!fs.existsSync(dirPath)) {
        return [];
    }

    const files = fs.readdirSync(dirPath).filter(f => /\.ya?ml$/i.test(f));
    const entries: LibraryRegistryEntry[] = [];

    for (const file of files) {
        const fullPath = path.join(dirPath, file);
        try {
            const stored = parseLibraryFile(fullPath);
            entries.push({
                urn: stored.urn,
                name: stored.name,
                version: stored.version,
                kind: stored.kind,
                filePath: fullPath,
                loaded: false,
            });
        } catch {
            // Skip files that fail to parse — they'll be caught during explicit load
            logger.warn('Skipping invalid library file', { component: 'library-loader', file });
        }
    }

    return entries;
}

/**
 * Load all libraries from a directory, returning a Map of URN → LoadedLibrary.
 */
export function loadAllFromDirectory(dirPath: string): Map<string, LoadedLibrary> {
    const entries = scanLibraryDirectory(dirPath);
    const loaded = new Map<string, LoadedLibrary>();

    for (const entry of entries) {
        const stored = parseLibraryFile(entry.filePath);
        const library = loadLibrary(stored, entry.filePath);
        loaded.set(library.urn, library);
    }

    return loaded;
}
