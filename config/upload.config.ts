import type { UploadConfiguration } from "../types/upload.types";

/**
 * Default Upload Configuration
 * Contains sensible defaults for the upload system.
 * Thumbnail generation and malware scanning are not implemented.
 */
export const DEFAULT_UPLOAD_CONFIG: UploadConfiguration = {
    maxFileSize: 10 * 1024 * 1024, // 10MB
    allowedMimeTypes: [
        // Images (SVG excluded — XSS vector via embedded scripts)
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
        // Documents
        "application/pdf",
        "text/plain",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ],
    allowedExtensions: [
        ".jpg", ".jpeg", ".png", ".gif", ".webp",
        ".pdf", ".txt", ".doc", ".docx"
    ],
    validateFileSignature: true,
    sanitizeFileName: true,
    preserveOriginalName: false,
    uploadPath: "uploads",
    namingStrategy: "uuid",
    validation: {
        strictMimeType: true,
        customValidators: []
    }
};

/**
 * Image-specific upload configuration.
 * Does not generate thumbnails — that flag was removed because nothing read it.
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
    validation: {
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
};

/**
 * Strict security configuration for public uploads.
 * Signature and MIME checks run. There is no malware scanner.
 */
export const SECURE_UPLOAD_CONFIG: Partial<UploadConfiguration> = {
    maxFileSize: 1 * 1024 * 1024, // 1MB
    allowedMimeTypes: ["image/jpeg", "image/png"],
    allowedExtensions: [".jpg", ".jpeg", ".png"],
    validateFileSignature: true,
    sanitizeFileName: true,
    preserveOriginalName: false,
    validation: {
        strictMimeType: true,
        customValidators: []
    }
};
