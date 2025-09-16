import type { UploadConfiguration } from "../types/upload.types";

/**
 * Default Upload Configuration
 * Contains sensible defaults for the upload system
 */
export const DEFAULT_UPLOAD_CONFIG: UploadConfiguration = {
    maxFileSize: 10 * 1024 * 1024, // 10MB
    allowedMimeTypes: [
        // Images
        "image/jpeg",
        "image/png", 
        "image/gif",
        "image/webp",
        "image/svg+xml",
        // Documents
        "application/pdf",
        "text/plain",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ],
    allowedExtensions: [
        // Images
        ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg",
        // Documents  
        ".pdf", ".txt", ".doc", ".docx"
    ],
    validateFileSignature: true,
    sanitizeFileName: true,
    preserveOriginalName: false,
    generateThumbnails: false,
    uploadPath: "uploads",
    namingStrategy: "uuid",
    imageProcessing: {
        generateThumbnails: false,
        thumbnailSizes: [
            { width: 150, height: 150, suffix: "_thumb" },
            { width: 300, height: 300, suffix: "_medium" },
            { width: 800, height: 600, suffix: "_large" }
        ],
        compress: true,
        quality: 85,
        maxDimensions: { width: 2048, height: 2048 }
    },
    validation: {
        scanForMalware: false,
        strictMimeType: true,
        customValidators: []
    }
};

/**
 * Image-specific upload configuration
 */
export const IMAGE_UPLOAD_CONFIG: Partial<UploadConfiguration> = {
    maxFileSize: 5 * 1024 * 1024, // 5MB
    allowedMimeTypes: [
        "image/jpeg",
        "image/png",
        "image/gif", 
        "image/webp"
    ],
    allowedExtensions: [".jpg", ".jpeg", ".png", ".gif", ".webp"],
    generateThumbnails: true,
    imageProcessing: {
        generateThumbnails: true,
        thumbnailSizes: [
            { width: 150, height: 150, suffix: "_thumb" },
            { width: 300, height: 300, suffix: "_medium" }
        ],
        compress: true,
        quality: 85,
        maxDimensions: { width: 1920, height: 1080 }
    }
};

/**
 * Document upload configuration
 */
export const DOCUMENT_UPLOAD_CONFIG: Partial<UploadConfiguration> = {
    maxFileSize: 25 * 1024 * 1024, // 25MB
    allowedMimeTypes: [
        "application/pdf",
        "text/plain",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ],
    allowedExtensions: [".pdf", ".txt", ".doc", ".docx", ".xls", ".xlsx"],
    validateFileSignature: true,
    generateThumbnails: false,
    validation: {
        scanForMalware: true,
        strictMimeType: true
    }
};

/**
 * Avatar/profile picture configuration
 */
export const AVATAR_UPLOAD_CONFIG: Partial<UploadConfiguration> = {
    maxFileSize: 2 * 1024 * 1024, // 2MB
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    allowedExtensions: [".jpg", ".jpeg", ".png", ".webp"],
    generateThumbnails: true,
    imageProcessing: {
        generateThumbnails: true,
        thumbnailSizes: [
            { width: 50, height: 50, suffix: "_small" },
            { width: 150, height: 150, suffix: "_medium" },
            { width: 300, height: 300, suffix: "_large" }
        ],
        compress: true,
        quality: 90,
        maxDimensions: { width: 800, height: 800 }
    }
};

/**
 * Strict security configuration for public uploads
 */
export const SECURE_UPLOAD_CONFIG: Partial<UploadConfiguration> = {
    maxFileSize: 1 * 1024 * 1024, // 1MB
    allowedMimeTypes: ["image/jpeg", "image/png"],
    allowedExtensions: [".jpg", ".jpeg", ".png"],
    validateFileSignature: true,
    sanitizeFileName: true,
    preserveOriginalName: false,
    validation: {
        scanForMalware: true,
        strictMimeType: true,
        customValidators: []
    }
};