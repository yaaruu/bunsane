import fs from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import path from "path";
import { StorageProvider } from "./StorageProvider";
import type { UploadConfiguration, StorageResult, FileMetadata } from "../types/upload.types";
import { logger as MainLogger } from "../core/Logger";

const logger = MainLogger.child({ scope: "LocalStorageProvider" });

/**
 * Local File System Storage Provider
 * Handles file storage on the local filesystem
 */
export class LocalStorageProvider extends StorageProvider {
    private basePath: string;
    private baseUrl: string;

    constructor(config: {
        basePath?: string;
        baseUrl?: string;
    } = {}) {
        super("local", config);
        this.basePath = config.basePath || "./public";
        this.baseUrl = config.baseUrl || "";
        this.validateConfig();
        // Directory creation is lazy (first store / explicit initialize) so
        // UploadManager.getInstance() does not mkdir ./public.
    }

    public async initialize(): Promise<void> {
        // Kept for StorageProvider contract / explicit re-init. Idempotent.
        this.ensureBaseDir();
    }

    private ensureBaseDir(): void {
        if (!fs.existsSync(this.basePath)) {
            fs.mkdirSync(this.basePath, { recursive: true });
            logger.info(`Created base directory: ${this.basePath}`);
        }
    }

    public async store(
        file: File,
        metadata: FileMetadata,
        config: UploadConfiguration
    ): Promise<StorageResult> {
        // SEC-07: store() historically skipped containment entirely — a
        // hostile fileName under namingStrategy:"original" could escape the
        // base directory. Resolve and verify BEFORE any filesystem effect.
        const uploadDir = this.assertInsideBase(
            path.join(this.basePath, config.uploadPath ?? ''),
            this.basePath,
            'LocalStorage.store(uploadPath)',
        );
        const fullPath = this.assertInsideBase(
            path.join(uploadDir, metadata.fileName),
            this.basePath,
            'LocalStorage.store(fileName)',
        );
        // Windows-reserved characters would fail at open() with a confusing
        // ENOENT (or worse, ADS syntax "file:stream"); reject explicitly.
        if (/[:*?"<>|]/.test(metadata.fileName)) {
            throw new Error(
                `LocalStorage.store: fileName contains reserved characters: ${metadata.fileName}`
            );
        }
        const relativePath = this.buildPath(config.uploadPath, metadata.fileName);
        
        logger.info(`Storing file: ${metadata.fileName} to ${fullPath}`);

        try {
            this.ensureBaseDir();
            // Ensure upload directory exists
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }

            // Stream File → disk to avoid full in-memory buffering of large uploads.
            const writeStream = fs.createWriteStream(fullPath);
            try {
                const webStream = file.stream() as ReadableStream<Uint8Array>;
                const nodeStream = Readable.fromWeb(webStream as any);
                await pipeline(nodeStream, writeStream);
            } catch (streamError) {
                try { fs.unlinkSync(fullPath); } catch { /* best-effort cleanup */ }
                throw streamError;
            }

            // Generate URL
            const url = this.buildUrl(relativePath);

            logger.info(`File stored successfully: ${metadata.fileName}`);

            return {
                path: relativePath,
                url,
                metadata: {
                    ...metadata,
                    fullPath,
                    storedAt: new Date().toISOString()
                }
            };

        } catch (error) {
            logger.error(`Failed to store file ${metadata.fileName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            throw new Error(`Failed to store file: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    public async delete(filePath: string): Promise<boolean> {
        const fullPath = this.assertInsideBase(
            path.join(this.basePath, this.sanitizePath(filePath)),
            this.basePath,
            'LocalStorage.delete',
        );
        
        try {
            if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
                logger.info(`File deleted: ${filePath}`);
                return true;
            } else {
                logger.warn(`File not found for deletion: ${filePath}`);
                return false;
            }
        } catch (error) {
            logger.error(`Failed to delete file ${filePath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return false;
        }
    }

    public async getUrl(filePath: string): Promise<string> {
        return this.buildUrl(filePath);
    }

    public async exists(filePath: string): Promise<boolean> {
        const fullPath = this.assertInsideBase(
            path.join(this.basePath, this.sanitizePath(filePath)),
            this.basePath,
            'LocalStorage.read',
        );
        return fs.existsSync(fullPath);
    }

    public async getMetadata(filePath: string): Promise<FileMetadata | null> {
        const fullPath = this.assertInsideBase(
            path.join(this.basePath, this.sanitizePath(filePath)),
            this.basePath,
            'LocalStorage.read',
        );
        
        try {
            if (!fs.existsSync(fullPath)) {
                return null;
            }

            const stats = fs.statSync(fullPath);
            const fileName = path.basename(filePath);
            
            return {
                uploadId: "", // Would need to be stored separately
                fileName,
                originalFileName: fileName,
                mimeType: this.getMimeTypeFromExtension(path.extname(fileName)),
                size: stats.size,
                extension: path.extname(fileName),
                uploadedAt: stats.birthtime.toISOString()
            };

        } catch (error) {
            logger.error(`Failed to get metadata for ${filePath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return null;
        }
    }

    public async list(directoryPath: string): Promise<string[]> {
        const fullPath = this.assertInsideBase(
            path.join(this.basePath, this.sanitizePath(directoryPath)),
            this.basePath,
            'LocalStorage.list',
        );
        
        try {
            if (!fs.existsSync(fullPath)) {
                return [];
            }

            const items = fs.readdirSync(fullPath);
            return items.filter(item => {
                const itemPath = path.join(fullPath, item);
                return fs.statSync(itemPath).isFile();
            });

        } catch (error) {
            logger.error(`Failed to list directory ${directoryPath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return [];
        }
    }

    public async getStream(filePath: string): Promise<ReadableStream> {
        const fullPath = this.assertInsideBase(
            path.join(this.basePath, this.sanitizePath(filePath)),
            this.basePath,
            'LocalStorage.read',
        );
        
        if (!fs.existsSync(fullPath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        const fileStream = fs.createReadStream(fullPath);
        
        return new ReadableStream({
            start(controller) {
                fileStream.on('data', (chunk) => {
                    controller.enqueue(chunk);
                });
                
                fileStream.on('end', () => {
                    controller.close();
                });
                
                fileStream.on('error', (error) => {
                    controller.error(error);
                });
            }
        });
    }

    public async copy(sourcePath: string, destinationPath: string): Promise<boolean> {
        const sourceFullPath = this.assertInsideBase(
            path.join(this.basePath, this.sanitizePath(sourcePath)),
            this.basePath,
            'LocalStorage.copy.source',
        );
        const destFullPath = this.assertInsideBase(
            path.join(this.basePath, this.sanitizePath(destinationPath)),
            this.basePath,
            'LocalStorage.copy.dest',
        );
        
        try {
            if (!fs.existsSync(sourceFullPath)) {
                logger.warn(`Source file not found: ${sourcePath}`);
                return false;
            }

            // Ensure destination directory exists
            const destDir = path.dirname(destFullPath);
            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
            }

            fs.copyFileSync(sourceFullPath, destFullPath);
            logger.info(`File copied from ${sourcePath} to ${destinationPath}`);
            return true;

        } catch (error) {
            logger.error(`Failed to copy file from ${sourcePath} to ${destinationPath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return false;
        }
    }

    public async move(sourcePath: string, destinationPath: string): Promise<boolean> {
        const success = await this.copy(sourcePath, destinationPath);
        if (success) {
            return await this.delete(sourcePath);
        }
        return false;
    }

    public async getStats(): Promise<{
        totalFiles: number;
        totalSize: number;
        availableSpace?: number;
    }> {
        try {
            const stats = await this.calculateDirectoryStats(this.basePath);
            return stats;
        } catch (error) {
            logger.error(`Failed to get storage stats: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return { totalFiles: 0, totalSize: 0 };
        }
    }

    public async cleanup(): Promise<void> {
        logger.info("Local storage cleanup - no action needed");
        // For local storage, cleanup might involve removing temp files
        // This is a placeholder for future implementation
    }

    protected validateConfig(): boolean {
        if (!this.basePath) {
            throw new Error("LocalStorageProvider: basePath is required");
        }
        return true;
    }

    private buildUrl(filePath: string): string {
        const cleanPath = filePath.startsWith('/') ? filePath : `/${filePath}`;
        return `${this.baseUrl}${cleanPath}`;
    }

    private getMimeTypeFromExtension(extension: string): string {
        const mimeTypes: Record<string, string> = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.pdf': 'application/pdf',
            '.txt': 'text/plain',
            '.doc': 'application/msword',
            '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        };
        
        return mimeTypes[extension.toLowerCase()] || 'application/octet-stream';
    }

    private async calculateDirectoryStats(dirPath: string): Promise<{
        totalFiles: number;
        totalSize: number;
    }> {
        let totalFiles = 0;
        let totalSize = 0;

        const traverse = (currentPath: string): void => {
            if (!fs.existsSync(currentPath)) return;
            
            const items = fs.readdirSync(currentPath);
            
            for (const item of items) {
                const itemPath = path.join(currentPath, item);
                const stats = fs.statSync(itemPath);
                
                if (stats.isFile()) {
                    totalFiles++;
                    totalSize += stats.size;
                } else if (stats.isDirectory()) {
                    traverse(itemPath);
                }
            }
        };

        traverse(dirPath);
        
        return { totalFiles, totalSize };
    }
}