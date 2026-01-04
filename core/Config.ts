/**
 * Configuration module for Bunsane Framework
 * Handles environment variables and application settings
 */

export interface BunsaneConfig {
    // Query optimization settings
    useLateralJoins: boolean;
    partitionStrategy: 'list' | 'hash';
    useDirectPartition: boolean;

    // Database settings
    databaseUrl?: string;
    databasePoolSize?: number;

    // Application settings
    appPort: number;
    nodeEnv: string;

    // Debug settings
    debugMode: boolean;
    logLevel: string;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: BunsaneConfig = {
    useLateralJoins: true, // Default to true for PG12+
    partitionStrategy: 'list', // LIST partitioning - one partition per component type
    useDirectPartition: true,  // Direct partition access - queries go directly to partition tables
    appPort: 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    debugMode: false,
    logLevel: 'info'
};

/**
 * Configuration singleton class
 */
class ConfigManager {
    private static instance: ConfigManager;
    private config: BunsaneConfig;

    private constructor() {
        this.config = this.loadConfig();
    }

    public static getInstance(): ConfigManager {
        if (!ConfigManager.instance) {
            ConfigManager.instance = new ConfigManager();
        }
        return ConfigManager.instance;
    }

    /**
     * Load configuration from environment variables
     */
    private loadConfig(): BunsaneConfig {
        return {
            useLateralJoins: this.parseBoolean(process.env.BUNSANE_USE_LATERAL_JOINS, DEFAULT_CONFIG.useLateralJoins),
            partitionStrategy: this.parsePartitionStrategy(process.env.BUNSANE_PARTITION_STRATEGY, DEFAULT_CONFIG.partitionStrategy),
            useDirectPartition: this.parseBoolean(process.env.BUNSANE_USE_DIRECT_PARTITION, DEFAULT_CONFIG.useDirectPartition),
            databaseUrl: process.env.DATABASE_URL,
            databasePoolSize: this.parseNumber(process.env.DATABASE_POOL_SIZE, 10),
            appPort: this.parseNumber(process.env.APP_PORT, DEFAULT_CONFIG.appPort),
            nodeEnv: process.env.NODE_ENV || DEFAULT_CONFIG.nodeEnv,
            debugMode: this.parseBoolean(process.env.DEBUG, DEFAULT_CONFIG.debugMode),
            logLevel: process.env.LOG_LEVEL || DEFAULT_CONFIG.logLevel
        };
    }

    private parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
        if (!value) return defaultValue;
        return value.toLowerCase() === 'true' || value === '1';
    }

    private parseNumber(value: string | undefined, defaultValue: number): number {
        if (!value) return defaultValue;
        const parsed = parseInt(value, 10);
        return isNaN(parsed) ? defaultValue : parsed;
    }

    private parsePartitionStrategy(value: string | undefined, defaultValue: 'list' | 'hash'): 'list' | 'hash' {
        if (!value) return defaultValue;
        const lowerValue = value.toLowerCase();
        return lowerValue === 'hash' ? 'hash' : 'list';
    }

    /**
     * Get the current configuration
     */
    public getConfig(): BunsaneConfig {
        return { ...this.config };
    }

    /**
     * Get a specific configuration value
     */
    public get<K extends keyof BunsaneConfig>(key: K): BunsaneConfig[K] {
        return this.config[key];
    }

    /**
     * Check if LATERAL joins should be used
     */
    public shouldUseLateralJoins(): boolean {
        return this.config.useLateralJoins;
    }

    /**
     * Check if debug mode is enabled
     */
    public isDebugMode(): boolean {
        return this.config.debugMode;
    }

    /**
     * Get partition strategy
     */
    public getPartitionStrategy(): 'list' | 'hash' {
        return this.config.partitionStrategy;
    }

    /**
     * Check if direct partition table access should be used
     */
    public shouldUseDirectPartition(): boolean {
        return this.config.useDirectPartition;
    }

    /**
     * Reload configuration from environment variables
     */
    public reloadConfig(): void {
        this.config = this.loadConfig();
    }
}

/**
 * Global configuration instance
 */
export const config = ConfigManager.getInstance();

/**
 * Convenience functions for common config checks
 */
export const shouldUseLateralJoins = () => config.shouldUseLateralJoins();
export const isDebugMode = () => config.isDebugMode();
export const getPartitionStrategy = () => config.getPartitionStrategy();
export const shouldUseDirectPartition = () => config.shouldUseDirectPartition();

export default config;