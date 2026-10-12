/**
 * Integration Provider Registry
 *
 * Central registry that maps provider IDs to their implementations.
 * Used to route automationKey prefixes to the correct provider.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * USAGE
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   import { registry } from '@/app-layer/integrations/registry';
 *
 *   // Register a provider
 *   registry.register(new GitHubProvider());
 *
 *   // Lookup by automationKey
 *   const provider = registry.resolveByAutomationKey('github.branch_protection');
 *   // → GitHubProvider instance
 *
 *   // List all registered providers
 *   const all = registry.listProviders();
 *
 * @module integrations/registry
 */
import type {
    IntegrationProvider,
    ScheduledCheckProvider,
    WebhookEventProvider,
    ParsedAutomationKey,
} from './types';
import {
    parseAutomationKey,
    isScheduledCheckProvider,
    isWebhookEventProvider,
} from './types';
import { logger } from '@/lib/observability/logger';

// ─── Registry Implementation ─────────────────────────────────────────

class ProviderRegistry {
    private readonly providers = new Map<string, IntegrationProvider>();

    /**
     * Register a provider. Overwrites any existing provider with the same ID.
     */
    register(provider: IntegrationProvider): void {
        if (!provider.id || typeof provider.id !== 'string') {
            throw new Error('Provider must have a non-empty string id');
        }
        this.providers.set(provider.id, provider);
        logger.info('Integration provider registered', {
            component: 'integrations',
            provider: provider.id,
            checks: provider.supportedChecks,
        });
    }

    /**
     * Unregister a provider by ID.
     */
    unregister(providerId: string): boolean {
        return this.providers.delete(providerId);
    }

    /**
     * Get a provider by its ID.
     */
    getProvider(providerId: string): IntegrationProvider | undefined {
        return this.providers.get(providerId);
    }

    /**
     * Resolve a provider from an automationKey.
     * Parses the key, extracts the provider prefix, and looks it up.
     *
     * @returns The provider and parsed key, or null if not found.
     */
    resolveByAutomationKey(automationKey: string): {
        provider: IntegrationProvider;
        parsed: ParsedAutomationKey;
    } | null {
        const parsed = parseAutomationKey(automationKey);
        if (!parsed) return null;

        const provider = this.providers.get(parsed.provider);
        if (!provider) return null;

        // Verify the provider supports this check type
        if (!provider.supportedChecks.includes(parsed.checkType)) {
            logger.warn('Provider does not support check type', {
                component: 'integrations',
                provider: parsed.provider,
                checkType: parsed.checkType,
                supported: provider.supportedChecks,
            });
            return null;
        }

        return { provider, parsed };
    }

    /**
     * Find a provider that handles webhooks for this provider ID.
     */
    getWebhookProvider(providerId: string): WebhookEventProvider | null {
        const provider = this.providers.get(providerId);
        if (!provider) return null;
        return isWebhookEventProvider(provider) ? provider : null;
    }

    /**
     * Find a provider that supports scheduled checks for this provider ID.
     */
    getScheduledProvider(providerId: string): ScheduledCheckProvider | null {
        const provider = this.providers.get(providerId);
        if (!provider) return null;
        return isScheduledCheckProvider(provider) ? provider : null;
    }

    /**
     * List all registered providers.
     */
    listProviders(): IntegrationProvider[] {
        return Array.from(this.providers.values());
    }

    /**
     * List all registered provider IDs.
     */
    listProviderIds(): string[] {
        return Array.from(this.providers.keys());
    }

    /**
     * List all supported automationKeys across all providers.
     */
    listAllAutomationKeys(): string[] {
        const keys: string[] = [];
        for (const [id, provider] of this.providers) {
            for (const check of provider.supportedChecks) {
                keys.push(`${id}.${check}`);
            }
        }
        return keys;
    }

    /**
     * Check if any provider is registered for the given automationKey.
     */
    canHandle(automationKey: string): boolean {
        return this.resolveByAutomationKey(automationKey) !== null;
    }

    /**
     * Clear all providers. Used in tests.
     * @internal
     */
    _clear(): void {
        this.providers.clear();
    }
}

/**
 * Global singleton provider registry.
 * Import and use this across the application.
 */
export const registry = new ProviderRegistry();


// ═══════════════════════════════════════════════════════════════════════
// Integration Registry — Client + Mapper Bundle Pattern
// ═══════════════════════════════════════════════════════════════════════
//
// This is a SECOND registry that sits alongside ProviderRegistry.
//
// ProviderRegistry  → routes automationKeys to check/webhook providers
// IntegrationRegistry → bundles client + mapper classes for CRUD integrations
//
// Inspired by CISO-Assistant's IntegrationRegistry, which registers
// client_class + mapper_class + orchestrator_class per provider name.
// ═══════════════════════════════════════════════════════════════════════

import type { BaseIntegrationClient } from './base-client';
import type { BaseFieldMapper } from './base-mapper';
import type { BaseSyncOrchestrator } from './sync-orchestrator';

/**
 * Constructor type for BaseIntegrationClient subclasses.
 * `config` is typed `any` to handle contravariant constructor parameters:
 * each concrete subclass narrows config to its own shape (e.g. GitHubConnectionConfig),
 * but the registry must accept any subclass — `BaseConnectionConfig` would break callers.
 */
export type IntegrationClientConstructor<T extends BaseIntegrationClient = BaseIntegrationClient> = new (config: never, fetchImpl?: typeof globalThis.fetch) => T;

/**
 * Constructor type for BaseFieldMapper subclasses.
 * `options` is typed `any` for the same contravariant constructor reason —
 * each concrete mapper may narrow the options shape.
 */
export type FieldMapperConstructor<T extends BaseFieldMapper = BaseFieldMapper> = new (options?: never) => T;

/**
 * Orchestrator constructor options type.
 * Typed `any` because concrete orchestrators (e.g. GitHubSyncOrchestrator)
 * accept additional fields beyond the BaseSyncOrchestrator base shape —
 * the registry stores the constructor for any concrete subclass.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- contravariant constructor parameter; concrete subclasses extend the base opts shape
export type OrchestratorConstructorOpts = any;

/**
 * A registered integration bundle — groups client + mapper classes
 * under a single provider key with metadata.
 */
export interface IntegrationBundle {
    /** Unique provider key (e.g. 'jira', 'github', 'servicenow') */
    readonly name: string;
    /** Integration category (e.g. 'itsm', 'scm', 'cloud', 'directory') */
    readonly type: string;
    /** Human-readable display name */
    readonly displayName: string;
    /** Provider description */
    readonly description: string;
    /** Client class constructor */
    readonly clientClass: IntegrationClientConstructor;
    /** Field mapper class constructor */
    readonly mapperClass: FieldMapperConstructor;
    /** Sync orchestrator class constructor (optional) */
    readonly orchestratorClass?: new (opts: OrchestratorConstructorOpts) => BaseSyncOrchestrator; // OrchestratorConstructorOpts is intentionally `any` — see its declaration
    /**
     * #3432 — has this bundle's response MAPPING ever met the vendor?
     *
     * The same claim as `IntegrationProvider.mappingVerifiedBy`, and a claim
     * about the RECORD rather than about the vendor: `null` means no live
     * mapping run is on record, which is not the same as "the mapping is
     * wrong".
     *
     * OPTIONAL here on purpose. A bundle whose name is ALSO an
     * `IntegrationProvider` (github, servicenow) answers through the provider,
     * and duplicating the string would be two copies of one predicate with the
     * one that matters being the quiet one. Required only for bundles with NO
     * provider of the same name — enforced by the census in
     * `tests/guards/integration-credential-placement.test.ts`, which
     * enumerates the UNION of both registries.
     */
    readonly mappingVerifiedBy?: string | null;
}

/**
 * Registration input — what callers pass to IntegrationRegistry.register().
 */
export interface IntegrationBundleRegistration {
    name: string;
    type: string;
    displayName?: string;
    description?: string;
    clientClass: IntegrationClientConstructor;
    mapperClass: FieldMapperConstructor;
    orchestratorClass?: new (opts: OrchestratorConstructorOpts) => BaseSyncOrchestrator; // OrchestratorConstructorOpts is intentionally `any`
    /** See {@link IntegrationBundle.mappingVerifiedBy} (#3432). */
    mappingVerifiedBy?: string | null;
}

/**
 * Central registry for integration bundles (client + mapper per provider).
 *
 * This is a class-level (static) singleton — no instantiation required.
 * Providers register their client + mapper classes at module load time,
 * and consumers resolve them by name or type at runtime.
 *
 * @example
 *   IntegrationRegistry.register({
 *       name: 'jira',
 *       type: 'itsm',
 *       clientClass: JiraClient,
 *       mapperClass: JiraMapper,
 *   });
 *
 *   const bundle = IntegrationRegistry.getBundle('jira');
 *   const client = IntegrationRegistry.createClient('jira', config);
 */
class IntegrationRegistryImpl {
    private readonly bundles = new Map<string, IntegrationBundle>();

    /**
     * Register an integration bundle (client + mapper).
     * Overwrites any existing bundle with the same name.
     */
    register(registration: IntegrationBundleRegistration): void {
        const { name, type, clientClass, mapperClass } = registration;

        if (!name || typeof name !== 'string') {
            throw new Error('Integration bundle must have a non-empty string name');
        }

        const bundle: IntegrationBundle = {
            name,
            type,
            displayName: registration.displayName || name.charAt(0).toUpperCase() + name.slice(1),
            description: registration.description || '',
            clientClass,
            mapperClass,
            orchestratorClass: registration.orchestratorClass,
            mappingVerifiedBy: registration.mappingVerifiedBy,
        };

        this.bundles.set(name, bundle);
        logger.info('Integration bundle registered', {
            component: 'integrations',
            bundle: name,
            type,
        });
    }

    /**
     * Unregister an integration bundle by name.
     */
    unregister(name: string): boolean {
        return this.bundles.delete(name);
    }

    /**
     * Get a registered bundle by name.
     * Returns undefined if not found.
     */
    getBundle(name: string): IntegrationBundle | undefined {
        return this.bundles.get(name);
    }

    /**
     * Get a bundle by name, throwing if not found.
     */
    requireBundle(name: string): IntegrationBundle {
        const bundle = this.bundles.get(name);
        if (!bundle) {
            throw new Error(`Integration provider "${name}" is not registered`);
        }
        return bundle;
    }

    /**
     * Get all bundles of a specific integration type.
     */
    getBundlesByType(type: string): IntegrationBundle[] {
        return Array.from(this.bundles.values()).filter(b => b.type === type);
    }

    /**
     * List all registered bundles.
     */
    listBundles(): IntegrationBundle[] {
        return Array.from(this.bundles.values());
    }

    /**
     * List all registered bundle names.
     */
    listBundleNames(): string[] {
        return Array.from(this.bundles.keys());
    }

    /**
     * Check if a bundle with the given name is registered.
     */
    has(name: string): boolean {
        return this.bundles.has(name);
    }

    /**
     * Factory: create a client instance for the given provider.
     */
    createClient<TConfig extends import('./base-client').BaseConnectionConfig>(
        providerName: string,
        config: TConfig,
        fetchImpl?: typeof globalThis.fetch,
    ): import('./base-client').BaseIntegrationClient<TConfig> {
        const bundle = this.requireBundle(providerName);
        return new bundle.clientClass(config as never, fetchImpl) as BaseIntegrationClient<TConfig>;
    }

    /**
     * Factory: create a mapper instance for the given provider.
     */
    createMapper(
        providerName: string,
        options?: { customMappings?: Record<string, string> },
    ): BaseFieldMapper {
        const bundle = this.requireBundle(providerName);
        return new bundle.mapperClass(options as never);
    }

    /**
     * Factory: create an orchestrator instance for the given provider.
     * Returns undefined if the bundle does not support orchestration.
     */
    createOrchestrator(providerName: string, opts: OrchestratorConstructorOpts): BaseSyncOrchestrator | undefined { // opts typed via OrchestratorConstructorOpts (intentionally any)
        const bundle = this.requireBundle(providerName);
        if (!bundle.orchestratorClass) {
            return undefined;
        }
        return new bundle.orchestratorClass(opts);
    }

    /**
     * Clear all bundles. Used in tests.
     * @internal
     */
    _clear(): void {
        this.bundles.clear();
    }
}

/**
 * Global singleton integration registry.
 */
export const integrationRegistry = new IntegrationRegistryImpl();

