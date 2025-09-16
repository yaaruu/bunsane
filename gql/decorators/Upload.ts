import "reflect-metadata";
import type { UploadDecoratorConfig } from "../../types/upload.types";
import { UploadManager } from "../../core/UploadManager";
import { logger as MainLogger } from "../../core/Logger";

const logger = MainLogger.child({ scope: "UploadDecorator" });

/**
 * Metadata key for upload configuration
 */
export const UPLOAD_CONFIG_KEY = Symbol("upload:config");

/**
 * @Upload decorator for GraphQL mutation parameters
 * Automatically handles file uploads and stores metadata
 */
export function Upload(config?: UploadDecoratorConfig) {
    return function (target: any, propertyKey: string, parameterIndex: number) {
        logger.trace(`Registering @Upload decorator for ${target.constructor.name}.${propertyKey} parameter ${parameterIndex}`);
        
        const existingMetadata = Reflect.getMetadata(UPLOAD_CONFIG_KEY, target, propertyKey) || {};
        
        existingMetadata[parameterIndex] = {
            field: config?.field || propertyKey,
            batch: config?.batch || false,
            required: config?.required || false,
            validationMessage: config?.validationMessage,
            ...config
        };
        
        Reflect.defineMetadata(UPLOAD_CONFIG_KEY, existingMetadata, target, propertyKey);
    };
}

/**
 * @UploadField decorator for GraphQL field-level upload configuration
 * Used to configure upload behavior for specific fields
 */
export function UploadField(config: UploadDecoratorConfig) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        logger.trace(`Registering @UploadField decorator for ${target.constructor.name}.${propertyKey}`);
        
        const originalMethod = descriptor.value;
        
        descriptor.value = async function (...args: any[]) {
            const uploadManager = UploadManager.getInstance();
            
            // Check if this method has upload parameters
            const uploadMetadata = Reflect.getMetadata(UPLOAD_CONFIG_KEY, target, propertyKey);
            
            if (uploadMetadata) {
                // Process uploads before calling the original method
                for (const [paramIndex, uploadConfig] of Object.entries(uploadMetadata)) {
                    const paramIdx = parseInt(paramIndex);
                    const file = args[paramIdx];
                    const config = uploadConfig as any;
                    
                    if (file && file instanceof File) {
                        logger.info(`Processing upload for parameter ${paramIdx} in ${target.constructor.name}.${propertyKey}`);
                        
                        try {
                            const result = await uploadManager.uploadFile(file, config);
                            
                            if (!result.success) {
                                throw new Error(config.validationMessage || result.error?.message || "Upload failed");
                            }
                            
                            // Replace file parameter with upload result
                            args[paramIdx] = result;
                            
                        } catch (error) {
                            logger.error(`Upload failed for ${target.constructor.name}.${propertyKey}: ${error instanceof Error ? error.message : 'Unknown error'}`);
                            throw error;
                        }
                    } else if (config.required) {
                        throw new Error(`Required upload file missing for parameter ${paramIdx}`);
                    }
                }
            }
            
            return await originalMethod.apply(this, args);
        };
        
        return descriptor;
    };
}

/**
 * Helper function to extract upload configuration from method metadata
 */
export function getUploadConfiguration(target: any, propertyKey: string): Record<number, any> | undefined {
    return Reflect.getMetadata(UPLOAD_CONFIG_KEY, target, propertyKey);
}

/**
 * @BatchUpload decorator for handling multiple file uploads
 */
export function BatchUpload(config?: UploadDecoratorConfig) {
    return Upload({ ...config, batch: true });
}

/**
 * @RequiredUpload decorator for mandatory file uploads
 */
export function RequiredUpload(config?: UploadDecoratorConfig) {
    return Upload({ ...config, required: true });
}

/**
 * Higher-order decorator factory for common upload patterns
 */
export class UploadDecorators {
    /**
     * Image upload decorator with image-specific validation
     */
    static Image(config?: Partial<UploadDecoratorConfig>) {
        return Upload({
            ...config,
            maxFileSize: 5 * 1024 * 1024, // 5MB
            allowedMimeTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
            allowedExtensions: [".jpg", ".jpeg", ".png", ".gif", ".webp"],
            generateThumbnails: true
        });
    }

    /**
     * Avatar upload decorator with strict constraints
     */
    static Avatar(config?: Partial<UploadDecoratorConfig>) {
        return Upload({
            ...config,
            required: true,
            maxFileSize: 2 * 1024 * 1024, // 2MB
            allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
            allowedExtensions: [".jpg", ".jpeg", ".png", ".webp"],
            generateThumbnails: true,
            namingStrategy: "uuid"
        });
    }

    /**
     * Document upload decorator
     */
    static Document(config?: Partial<UploadDecoratorConfig>) {
        return Upload({
            ...config,
            maxFileSize: 25 * 1024 * 1024, // 25MB
            allowedMimeTypes: [
                "application/pdf",
                "text/plain", 
                "application/msword",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            ],
            allowedExtensions: [".pdf", ".txt", ".doc", ".docx"],
            validateFileSignature: true
        });
    }

    /**
     * Secure upload decorator with strict validation
     */
    static Secure(config?: Partial<UploadDecoratorConfig>) {
        return Upload({
            ...config,
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