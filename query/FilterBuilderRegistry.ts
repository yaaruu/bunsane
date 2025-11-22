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
     * @throws Error if the operator is already registered
     */
    public static register(
        operator: string,
        builder: FilterBuilder,
        options?: FilterBuilderOptions,
        pluginName?: string
    ): void {
        // Simple lock mechanism for thread safety
        while (this.lock) {
            // Busy wait - in practice, this should be very short
            // Consider using a proper mutex in high-concurrency environments
        }

        this.lock = true;

        try {
            if (this.registry.has(operator)) {
                throw new Error(`Filter operator '${operator}' is already registered. ` +
                    `Existing registration by: ${this.registry.get(operator)!.registeredBy || 'unknown'}`);
            }

            this.registry.set(operator, {
                builder,
                options,
                registeredBy: pluginName,
                registeredAt: new Date()
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
    }> {
        return Array.from(this.registry.entries()).map(([operator, entry]) => ({
            operator,
            options: entry.options,
            registeredBy: entry.registeredBy,
            registeredAt: entry.registeredAt
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
}