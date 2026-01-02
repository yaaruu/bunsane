import type { UploadConfiguration, StorageResult, FileMetadata } from "../types/upload.types";

/**
 * Abstract Storage Provider Interface
 * Defines the contract for all storage backend implementations
 */
export abstract class StorageProvider {
    protected name: string;
    protected config: Record<string, any>;

    constructor(name: string, config: Record<string, any> = {}) {
        this.name = name;
        this.config = config;
    }

    /**
     * Get the storage provider name
     */
    public getName(): string {
        return this.name;
    }

    /**
     * Initialize the storage provider
     */
    public abstract initialize(): Promise<void>;

    /**
     * Store a file
     */
    public abstract store(
        file: File,
        metadata: FileMetadata,
        config: UploadConfiguration
    ): Promise<StorageResult>;

    /**
     * Delete a file
     */
    public abstract delete(path: string): Promise<boolean>;

    /**
     * Get file URL
     */
    public abstract getUrl(path: string): Promise<string>;

    /**
     * Check if file exists
     */
    public abstract exists(path: string): Promise<boolean>;

    /**
     * Get file metadata
     */
    public abstract getMetadata(path: string): Promise<FileMetadata | null>;

    /**
     * List files in directory
     */
    public abstract list(path: string): Promise<string[]>;

    /**
     * Get file stream
     */
    public abstract getStream(path: string): Promise<ReadableStream>;

    /**
     * Copy file
     */
    public abstract copy(sourcePath: string, destinationPath: string): Promise<boolean>;

    /**
     * Move file
     */
    public abstract move(sourcePath: string, destinationPath: string): Promise<boolean>;

    /**
     * Get storage statistics
     */
    public abstract getStats(): Promise<{
        totalFiles: number;
        totalSize: number;
        availableSpace?: number;
    }>;

    /**
     * Cleanup temporary files
     */
    public abstract cleanup(): Promise<void>;

    /**
     * Validate storage provider configuration
     */
    protected abstract validateConfig(): boolean;

    /**
     * Build full file path
     */
    protected buildPath(uploadPath: string, fileName: string): string {
        return `${uploadPath}/${fileName}`.replace(/\/+/g, '/');
    }

    /**
     * Sanitize path to prevent directory traversal
     */
    protected sanitizePath(path: string): string {
        return path
            .replace(/\.\./g, '')
            .replace(/\/+/g, '/')
            .replace(/^\/+/, '');
    }
}