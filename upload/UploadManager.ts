import { logger as MainLogger } from "../core/Logger";
import { uuidv7 } from "../utils/uuid";
import type { StorageProvider } from "../storage/StorageProvider";
import { LocalStorageProvider } from "../storage/LocalStorageProvider";
import type { UploadConfiguration, UploadResult, UploadError, FileMetadata } from "../types/upload.types";
import { FileValidator } from "./FileValidator";

const logger = MainLogger.child({ scope: "UploadManager" });

/**
 * UploadManager - Singleton class for managing file uploads
 * Provides centralized upload handling with pluggable storage backends
 */
export class UploadManager {
    private static instance: UploadManager;
    private storageProviders: Map<string, StorageProvider> = new Map();
    private defaultStorageProvider: string = "local";
    private fileValidator: FileValidator;
    private globalConfig: UploadConfiguration;

    private constructor() {
        this.fileValidator = new FileValidator();
        this.globalConfig = this.getDefaultConfiguration();
        this.initializeDefaultProviders();
    }

    public static getInstance(): UploadManager {
        if (!UploadManager.instance) {
            UploadManager.instance = new UploadManager();
        }
        return UploadManager.instance;
    }

    /**
     * Register a storage provider
     */
    public registerStorageProvider(name: string, provider: StorageProvider): void {
        logger.info(`Registering storage provider: ${name}`);
        this.storageProviders.set(name, provider);
    }

    /**
     * Set the default storage provider
     */
    public setDefaultStorageProvider(name: string): void {
        if (!this.storageProviders.has(name)) {
            throw new Error(`Storage provider '${name}' not found`);
        }
        this.defaultStorageProvider = name;
        logger.info(`Default storage provider set to: ${name}`);
    }

    /**
     * Get storage provider by name
     */
    public getStorageProvider(name?: string): StorageProvider {
        const providerName = name || this.defaultStorageProvider;
        const provider = this.storageProviders.get(providerName);
        if (!provider) {
            throw new Error(`Storage provider '${providerName}' not found`);
        }
        return provider;
    }

    /**
     * Process file upload
     */
    public async uploadFile(
        file: File,
        config?: Partial<UploadConfiguration>,
        storageProvider?: string
    ): Promise<UploadResult> {
        const uploadId = uuidv7();
        const mergedConfig = { ...this.globalConfig, ...config };
        
        logger.info(`Processing upload ${uploadId} for file: ${file.name}`);

        try {
            // Validate file
            const validation = await this.fileValidator.validate(file, mergedConfig);
            if (!validation.valid) {
                const error: UploadError = {
                    uploadId,
                    code: "VALIDATION_FAILED",
                    message: validation.errors.join(", "),
                    details: { validationErrors: validation.errors }
                };
                logger.warn(`Upload ${uploadId} validation failed: ${validation.errors.join(', ')}`);
                return { success: false, error };
            }

            // Get storage provider
            const provider = this.getStorageProvider(storageProvider);

            // Generate file metadata
            const metadata = await this.generateFileMetadata(file, uploadId, mergedConfig);

            // Store file
            const storeResult = await provider.store(file, metadata, mergedConfig);

            const result: UploadResult = {
                success: true,
                uploadId,
                fileName: metadata.fileName,
                originalFileName: file.name,
                mimeType: file.type,
                size: file.size,
                path: storeResult.path,
                url: storeResult.url,
                metadata: storeResult.metadata || {}
            };

            logger.info(`Upload ${uploadId} completed successfully`);
            return result;

        } catch (error) {
            const uploadError: UploadError = {
                uploadId,
                code: "UPLOAD_FAILED",
                message: error instanceof Error ? error.message : "Unknown error occurred",
                details: { originalError: error }
            };
            logger.error(`Upload ${uploadId} failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return { success: false, error: uploadError };
        }
    }

    /**
     * Process multiple file uploads
     */
    public async uploadFiles(
        files: File[],
        config?: Partial<UploadConfiguration>,
        storageProvider?: string
    ): Promise<UploadResult[]> {
        logger.info(`Processing batch upload of ${files.length} files`);
        
        const uploadPromises = files.map(file => 
            this.uploadFile(file, config, storageProvider)
        );

        return await Promise.all(uploadPromises);
    }

    /**
     * Delete uploaded file
     */
    public async deleteFile(path: string, storageProvider?: string): Promise<boolean> {
        try {
            const provider = this.getStorageProvider(storageProvider);
            const success = await provider.delete(path);
            logger.info(`File deleted: ${path}`);
            return success;
        } catch (error) {
            logger.error(`Failed to delete file ${path}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return false;
        }
    }

    /**
     * Get file URL
     */
    public async getFileUrl(path: string, storageProvider?: string): Promise<string | null> {
        try {
            const provider = this.getStorageProvider(storageProvider);
            return await provider.getUrl(path);
        } catch (error) {
            logger.error(`Failed to get URL for file ${path}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return null;
        }
    }

    /**
     * Update global configuration
     */
    public updateConfiguration(config: Partial<UploadConfiguration>): void {
        this.globalConfig = { ...this.globalConfig, ...config };
        logger.info("Upload configuration updated");
    }

    /**
     * Get current configuration
     */
    public getConfiguration(): UploadConfiguration {
        return { ...this.globalConfig };
    }

    private async initializeDefaultProviders(): Promise<void> {
        // Register default local storage provider
        const localProvider = new LocalStorageProvider();
        await localProvider.initialize();
        this.registerStorageProvider("local", localProvider);
    }

    private getDefaultConfiguration(): UploadConfiguration {
        return {
            maxFileSize: 10 * 1024 * 1024, // 10MB
            allowedMimeTypes: [
                "image/jpeg",
                "image/png",
                "image/gif",
                "image/webp"
            ],
            allowedExtensions: [".jpg", ".jpeg", ".png", ".gif", ".webp"],
            validateFileSignature: true,
            sanitizeFileName: true,
            preserveOriginalName: false,
            generateThumbnails: false,
            uploadPath: "uploads",
            namingStrategy: "uuid"
        };
    }

    private async generateFileMetadata(
        file: File,
        uploadId: string,
        config: UploadConfiguration
    ): Promise<FileMetadata> {
        const extension = this.getFileExtension(file.name);
        
        let fileName: string;
        switch (config.namingStrategy) {
            case "uuid":
                fileName = `${uploadId}${extension}`;
                break;
            case "timestamp":
                fileName = `${Date.now()}_${this.sanitizeFileName(file.name)}`;
                break;
            case "original":
                fileName = config.sanitizeFileName ? 
                    this.sanitizeFileName(file.name) : file.name;
                break;
            default:
                fileName = `${uploadId}${extension}`;
        }

        return {
            uploadId,
            fileName,
            originalFileName: file.name,
            mimeType: file.type,
            size: file.size,
            extension,
            uploadedAt: new Date().toISOString()
        };
    }

    private getFileExtension(fileName: string): string {
        const lastDot = fileName.lastIndexOf('.');
        return lastDot > 0 ? fileName.slice(lastDot) : '';
    }

    private sanitizeFileName(fileName: string): string {
        // Remove dangerous characters and normalize
        return fileName
            .replace(/[^a-zA-Z0-9.-]/g, '_')
            .replace(/_{2,}/g, '_')
            .replace(/^_+|_+$/g, '')
            .toLowerCase();
    }
}