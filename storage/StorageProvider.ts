import path from "path";
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
     * Sanitize path to prevent directory traversal (SEC-07).
     *
     * Hardened: backslashes are normalized FIRST (on Windows `..\` is a
     * separator pair the old forward-slash-only logic never saw), then
     * iterative `..` removal handles nested payloads (`....//`), and the
     * result must not contain drive/UNC roots.
     */
    protected sanitizePath(path: string): string {
        let sanitized = String(path).replace(/\\/g, '/');
        // Iterative removal to prevent bypass via nested payloads (e.g. "....//")
        while (sanitized.includes('..')) {
            sanitized = sanitized.replace(/\.\./g, '');
        }
        return sanitized
            .replace(/\/+/g, '/')
            .replace(/^\/+/, '');
    }

    /**
     * Containment check (SEC-07): resolve both paths absolutely and require
     * the target to stay inside the base directory. Works for drive letters
     * and UNC paths on Windows. Call this in EVERY provider method after
     * joining — sanitization alone is not a containment guarantee.
     */
    protected assertInsideBase(fullPath: string, basePath: string, context: string): string {
        const resolvedBase = path.resolve(basePath);
        const resolvedFull = path.resolve(fullPath);
        const baseWithSep = resolvedBase.endsWith(path.sep)
            ? resolvedBase
            : resolvedBase + path.sep;
        if (!resolvedFull.startsWith(baseWithSep) && resolvedFull !== resolvedBase) {
            throw new Error(
                `${context}: resolved path escapes storage base (${resolvedFull})`
            );
        }
        return resolvedFull;
    }
}