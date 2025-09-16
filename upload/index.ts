/**
 * Bunsane Upload System
 * Comprehensive file upload handling for the Bunsane framework
 */

// Core Upload System
export { UploadManager } from "../core/UploadManager";
export { FileValidator } from "../core/FileValidator";

// Storage Providers
export { StorageProvider } from "../core/storage/StorageProvider";
export { LocalStorageProvider } from "../core/storage/LocalStorageProvider";

// Components
export { UploadComponent, ImageMetadataComponent } from "../core/components/UploadComponent";

// Processors
export { ImageProcessor } from "../core/processors/ImageProcessor";

// Utilities
export { UploadHelper } from "../utils/UploadHelper";

// GraphQL Decorators
export {
    Upload,
    UploadField,
    BatchUpload,
    RequiredUpload,
    UploadDecorators,
    getUploadConfiguration
} from "../gql/decorators/Upload";

// Configuration
export {
    DEFAULT_UPLOAD_CONFIG,
    IMAGE_UPLOAD_CONFIG,
    DOCUMENT_UPLOAD_CONFIG,
    AVATAR_UPLOAD_CONFIG,
    SECURE_UPLOAD_CONFIG
} from "../config/upload.config";

// Types
export type {
    UploadConfiguration,
    ImageProcessingOptions,
    ValidationOptions,
    ValidationResult,
    UploadResult,
    UploadError,
    UploadErrorCode,
    FileMetadata,
    StorageResult,
    UploadProgress,
    BatchUploadResult,
    UploadComponentData,
    UploadDecoratorConfig,
    UploadGraphQLType
} from "../types/upload.types";

// Imports for internal use
import { UploadManager } from "../core/UploadManager";
import type { UploadConfiguration } from "../types/upload.types";

/**
 * Initialize the upload system with default configuration
 */
export async function initializeUploadSystem(config?: Partial<UploadConfiguration>): Promise<void> {
    const uploadManager = UploadManager.getInstance();
    
    if (config) {
        uploadManager.updateConfiguration(config);
    }
    
    // Initialize default storage provider
    await uploadManager.getStorageProvider("local").initialize();
}

/**
 * Quick setup functions for common use cases
 */
export class QuickSetup {
    /**
     * Setup for image uploads with thumbnails
     */
    static async forImages(): Promise<void> {
        const uploadManager = UploadManager.getInstance();
        uploadManager.updateConfiguration({
            maxFileSize: 5 * 1024 * 1024, // 5MB
            allowedMimeTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
            allowedExtensions: [".jpg", ".jpeg", ".png", ".gif", ".webp"],
            generateThumbnails: true,
            imageProcessing: {
                generateThumbnails: true,
                thumbnailSizes: [
                    { width: 150, height: 150, suffix: "_thumb" },
                    { width: 300, height: 300, suffix: "_medium" }
                ],
                compress: true,
                quality: 85
            }
        });
    }

    /**
     * Setup for document uploads
     */
    static async forDocuments(): Promise<void> {
        const uploadManager = UploadManager.getInstance();
        uploadManager.updateConfiguration({
            maxFileSize: 25 * 1024 * 1024, // 25MB
            allowedMimeTypes: [
                "application/pdf",
                "text/plain",
                "application/msword",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            ],
            allowedExtensions: [".pdf", ".txt", ".doc", ".docx"],
            validateFileSignature: true,
            generateThumbnails: false
        });
    }

    /**
     * Setup for secure uploads with strict validation
     */
    static async forSecureUploads(): Promise<void> {
        const uploadManager = UploadManager.getInstance();
        uploadManager.updateConfiguration({
            maxFileSize: 1 * 1024 * 1024, // 1MB
            allowedMimeTypes: ["image/jpeg", "image/png"],
            allowedExtensions: [".jpg", ".jpeg", ".png"],
            validateFileSignature: true,
            sanitizeFileName: true,
            validation: {
                scanForMalware: true,
                strictMimeType: true
            }
        });
    }
}