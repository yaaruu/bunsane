/**
 * Global Registry for Custom Filter Builders
 *
 * Provides thread-safe registration and lookup of custom filter operators.
 * This registry enables plugins to extend the query system with domain-specific
 * filtering capabilities (e.g., spatial queries, full-text search).
 */

import type { FilterBuilder, FilterBuilderOptions } from "./FilterBuilder";

/**
 * Registry entry containing the builder function and its options
 */
interface RegistryEntry {
    builder: FilterBuilder;
    options?: FilterBuilderOptions;
    registeredBy?: string; // Plugin name for debugging
    registeredAt: Date;
    version?: string; // Semantic version for the filter implementation
}

/**
 * Global registry for custom filter builders
 *
 * This class provides a static interface for registering and retrieving
 * custom filter builders. It ensures thread-safe operations during
 * plugin initialization.
 */
export class FilterBuilderRegistry {
    private static registry: Map<string, RegistryEntry> = new Map();
    private static lock: boolean = false;

    /**
     * Register a custom filter builder for a specific operator
     *
     * @param operator - The filter operator (e.g., "within_distance", "contains_point")
     * @param builder - The filter builder function
     * @param options - Optional configuration for the filter builder
     * @param pluginName - Name of the plugin registering this builder (for debugging)
     * @param version - Optional semantic version for the filter implementation (allows upgrades)
     * @throws Error if the operator is already registered by a different plugin (unless version allows override)
     */
    public static register(
        operator: string,
        builder: FilterBuilder,
        options?: FilterBuilderOptions,
        pluginName?: string,
        version?: string
    ): void {
        // Simple lock mechanism for thread safety
        while (this.lock) {
            // Busy wait - in practice, this should be very short
            // Consider using a proper mutex in high-concurrency environments
        }

        this.lock = true;

        try {
            const existing = this.registry.get(operator);

            if (existing) {
                // Allow override if same plugin or if version is newer
                const canOverride =
                    (pluginName && existing.registeredBy === pluginName) ||
                    (version && existing.version && this.isNewerVersion(version, existing.version));

                if (!canOverride) {
                    throw new Error(`Filter operator '${operator}' is already registered by '${existing.registeredBy || 'unknown'}' (v${existing.version || 'unknown'}). ` +
                        `Cannot register from '${pluginName || 'unknown'}' (v${version || 'unknown'}) without version upgrade.`);
                }
            }

            this.registry.set(operator, {
                builder,
                options,
                registeredBy: pluginName,
                registeredAt: new Date(),
                version
            });
        } finally {
            this.lock = false;
        }
    }

    /**
     * Check if a filter operator has a custom builder registered
     *
     * @param operator - The filter operator to check
     * @returns true if a custom builder is registered for this operator
     */
    public static has(operator: string): boolean {
        return this.registry.has(operator);
    }

    /**
     * Get the custom filter builder for a specific operator
     *
     * @param operator - The filter operator
     * @returns The filter builder function, or undefined if not registered
     */
    public static get(operator: string): FilterBuilder | undefined {
        return this.registry.get(operator)?.builder;
    }

    /**
     * Get the options for a registered filter builder
     *
     * @param operator - The filter operator
     * @returns The filter builder options, or undefined if not registered
     */
    public static getOptions(operator: string): FilterBuilderOptions | undefined {
        return this.registry.get(operator)?.options;
    }

    /**
     * Unregister a custom filter builder
     *
     * @param operator - The filter operator to remove
     * @returns true if the operator was registered and removed, false otherwise
     */
    public static unregister(operator: string): boolean {
        // Simple lock mechanism
        while (this.lock) {
            // Busy wait
        }

        this.lock = true;

        try {
            return this.registry.delete(operator);
        } finally {
            this.lock = false;
        }
    }

    /**
     * List all registered filter operators with their metadata
     *
     * @returns Array of registered operators with metadata
     */
    public static listRegistered(): Array<{
        operator: string;
        options?: FilterBuilderOptions;
        registeredBy?: string;
        registeredAt: Date;
        version?: string;
    }> {
        return Array.from(this.registry.entries()).map(([operator, entry]) => ({
            operator,
            options: entry.options,
            registeredBy: entry.registeredBy,
            registeredAt: entry.registeredAt,
            version: entry.version
        }));
    }

    /**
     * Clear all registered filter builders (for testing purposes)
     */
    public static clear(): void {
        // Simple lock mechanism
        while (this.lock) {
            // Busy wait
        }

        this.lock = true;

        try {
            this.registry.clear();
        } finally {
            this.lock = false;
        }
    }

    /**
     * Compare two semantic versions to determine if the first is newer
     *
     * @param newVersion - The new version string
     * @param oldVersion - The old version string
     * @returns true if newVersion is semantically newer than oldVersion
     */
    private static isNewerVersion(newVersion: string, oldVersion: string): boolean {
        try {
            const newParts = newVersion.split('.').map(n => parseInt(n, 10));
            const oldParts = oldVersion.split('.').map(n => parseInt(n, 10));

            // Compare major, minor, patch versions
            for (let i = 0; i < Math.max(newParts.length, oldParts.length); i++) {
                const newPart = newParts[i] || 0;
                const oldPart = oldParts[i] || 0;

                if (newPart > oldPart) return true;
                if (newPart < oldPart) return false;
            }

            return false; // Same version
        } catch {
            // If parsing fails, fall back to string comparison
            return newVersion > oldVersion;
        }
    }
}