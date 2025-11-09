/**
 * Upload System Type Definitions
 * Comprehensive TypeScript types for the Bunsane upload system
 */

export interface UploadConfiguration {
    /** Maximum file size in bytes */
    maxFileSize: number;
    
    /** Allowed MIME types */
    allowedMimeTypes: string[];
    
    /** Allowed file extensions */
    allowedExtensions: string[];
    
    /** Validate file signature (magic numbers) */
    validateFileSignature: boolean;
    
    /** Sanitize file names to prevent path traversal */
    sanitizeFileName: boolean;
    
    /** Preserve original file name */
    preserveOriginalName: boolean;
    
    /** Generate thumbnails for images */
    generateThumbnails: boolean;
    
    /** Upload path relative to storage root */
    uploadPath: string;
    
    /** File naming strategy */
    namingStrategy: "uuid" | "timestamp" | "original";
    
    /** Storage provider to use */
    storageProvider?: string;
    
    /** Image processing options */
    imageProcessing?: ImageProcessingOptions;
    
    /** Validation options */
    validation?: ValidationOptions;
}

export interface ImageProcessingOptions {
    /** Generate thumbnails */
    generateThumbnails: boolean;
    
    /** Thumbnail sizes */
    thumbnailSizes: Array<{ width: number; height: number; suffix: string }>;
    
    /** Compress images */
    compress: boolean;
    
    /** Compression quality (0-100) */
    quality: number;
    
    /** Convert to specific format */
    convertTo?: "jpeg" | "png" | "webp";
    
    /** Maximum dimensions */
    maxDimensions?: { width: number; height: number };
}

export interface ValidationOptions {
    /** Check for malicious files */
    scanForMalware: boolean;
    
    /** Custom validation functions */
    customValidators?: Array<(file: File) => Promise<ValidationResult>>;
    
    /** Strict MIME type checking */
    strictMimeType: boolean;
}

export interface ValidationResult {
    valid: boolean;
    errors: string[];
    warnings?: string[];
}

export interface UploadResult {
    success: boolean;
    uploadId?: string;
    fileName?: string;
    originalFileName?: string;
    mimeType?: string;
    size?: number;
    path?: string;
    url?: string;
    metadata?: Record<string, any>;
    uploadedAt?: string;
    thumbnails?: Array<{ size: string; url: string; path: string }>;
    error?: UploadError;
}

export interface UploadError {
    uploadId: string;
    code: UploadErrorCode;
    message: string;
    details?: Record<string, any>;
}

export type UploadErrorCode = 
    | "VALIDATION_FAILED"
    | "FILE_TOO_LARGE"
    | "INVALID_FILE_TYPE"
    | "MALICIOUS_FILE"
    | "UPLOAD_FAILED"
    | "STORAGE_ERROR"
    | "PROCESSING_ERROR"
    | "NETWORK_ERROR"
    | "PERMISSION_DENIED"
    | "QUOTA_EXCEEDED";

export interface FileMetadata {
    uploadId: string;
    fileName: string;
    originalFileName: string;
    mimeType: string;
    size: number;
    extension: string;
    uploadedAt: string;
    dimensions?: { width: number; height: number };
    hash?: string;
    userMetadata?: Record<string, any>;
}

export interface StorageResult {
    path: string;
    url: string;
    metadata?: Record<string, any>;
}

export interface UploadProgress {
    uploadId: string;
    fileName: string;
    totalBytes: number;
    uploadedBytes: number;
    percentage: number;
    speed?: number;
    remainingTime?: number;
    status: "pending" | "uploading" | "processing" | "completed" | "failed";
}

export interface BatchUploadResult {
    totalFiles: number;
    successfulUploads: number;
    failedUploads: number;
    results: UploadResult[];
    errors: UploadError[];
}

export interface UploadComponentData {
    uploadId: string;
    fileName: string;
    originalFileName: string;
    mimeType: string;
    size: number;
    path: string;
    url: string;
    metadata: Record<string, any>;
    uploadedAt: string;
}

/**
 * Configuration for upload decorators
 */
export interface UploadDecoratorConfig extends Partial<UploadConfiguration> {
    /** Field name to apply upload to */
    field?: string;
    
    /** Enable batch uploads */
    batch?: boolean;
    
    /** Required upload */
    required?: boolean;
    
    /** Custom validation message */
    validationMessage?: string;
}

/**
 * Upload field types for GraphQL
 */
export type UploadGraphQLType = "Upload" | "[Upload]" | "Upload!" | "[Upload]!";