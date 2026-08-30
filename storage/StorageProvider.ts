import path from "path";
import fs from "fs";
import type { UploadConfiguration, StorageResult, FileMetadata } from "../types/upload.types";

/**
 * Resolve symlinks on the longest EXISTING prefix of `p`, keeping the
 * not-yet-created tail lexical (SEC-07). `fs.realpathSync` throws ENOENT for a
 * target that does not exist yet (every `store()` destination), so walk up to
 * the deepest ancestor that does, canonicalise that, then rejoin the tail.
 *
 * This is what turns the containment check from lexical to real: a symlink
 * planted INSIDE the base that points outside resolves to its true location and
 * fails the prefix test, where `path.resolve` alone would wave it through.
 */
function realpathExisting(p: string): string {
    let current = path.resolve(p);
    const tail: string[] = [];
    // Bounded by path depth; `path.dirname` is a strict fixpoint at the root.
    while (true) {
        try {
            const real = fs.realpathSync(current);
            return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            const parent = path.dirname(current);
            if (parent === current) return path.resolve(p); // nothing on the path exists
            tail.push(path.basename(current));
            current = parent;
        }
    }
}

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
        // Realpath BOTH sides through the same helper. Realpathing only the
        // target would break every upload when the base itself is a symlink
        // (a symlinked project root, a Docker bind mount, macOS /var→/private/var,
        // Windows short-name/case), because the resolved target would then land
        // outside the un-resolved base. Symlinks on the existing prefix are
        // resolved so one planted inside the base cannot escape the check.
        const realBase = realpathExisting(basePath);
        const realFull = realpathExisting(fullPath);
        const baseWithSep = realBase.endsWith(path.sep) ? realBase : realBase + path.sep;
        if (!realFull.startsWith(baseWithSep) && realFull !== realBase) {
            throw new Error(
                `${context}: resolved path escapes storage base (${realFull})`
            );
        }
        // Return the lexical resolve, NOT the realpath: callers feed this back
        // into path.join / mkdir and surface it as StorageResult.fullPath, so
        // the containment check stays purely additive and observable output is
        // unchanged.
        return path.resolve(fullPath);
    }
}