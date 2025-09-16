import fs from "fs";
import path from "path";
import { StorageProvider } from "./StorageProvider";
import type { UploadConfiguration, StorageResult, FileMetadata } from "../../types/upload.types";
import { logger as MainLogger } from "../Logger";

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
    }

    public async initialize(): Promise<void> {
        logger.info("Initializing Local Storage Provider");
        
        // Ensure base directory exists
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
        const uploadDir = path.join(this.basePath, config.uploadPath);
        const fullPath = path.join(uploadDir, metadata.fileName);
        const relativePath = this.buildPath(config.uploadPath, metadata.fileName);
        
        logger.info(`Storing file: ${metadata.fileName} to ${fullPath}`);

        try {
            // Ensure upload directory exists
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }

            // Write file to disk
            const buffer = Buffer.from(await file.arrayBuffer());
            fs.writeFileSync(fullPath, buffer);

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
        const fullPath = path.join(this.basePath, this.sanitizePath(filePath));
        
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
        const fullPath = path.join(this.basePath, this.sanitizePath(filePath));
        return fs.existsSync(fullPath);
    }

    public async getMetadata(filePath: string): Promise<FileMetadata | null> {
        const fullPath = path.join(this.basePath, this.sanitizePath(filePath));
        
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
        const fullPath = path.join(this.basePath, this.sanitizePath(directoryPath));
        
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
        const fullPath = path.join(this.basePath, this.sanitizePath(filePath));
        
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
        const sourceFullPath = path.join(this.basePath, this.sanitizePath(sourcePath));
        const destFullPath = path.join(this.basePath, this.sanitizePath(destinationPath));
        
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