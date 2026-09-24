import "reflect-metadata";
import type { UploadDecoratorConfig } from "../../types/upload.types";
import { UploadManager } from "../../upload/UploadManager";
import { logger as MainLogger } from "../../core/Logger";
import { UPLOAD_CONFIG_KEY, wrapUploadValidation } from "../uploadGuard";

// Back-compat re-export: existing code imported the symbol from here.
export { UPLOAD_CONFIG_KEY };

const logger = MainLogger.child({ scope: "UploadDecorator" });

/**
 * @Upload decorator for GraphQL mutation parameters
 * Automatically handles file uploads and stores metadata
 *
 * SEC-06: this decorator now ALSO installs the shared validation guard on the
 * method (parameter decorators receive no property descriptor, so it is taken
 * from the prototype). Using @Upload without @UploadField no longer means
 * "record metadata, enforce nothing".
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

        // Install the validation guard once per method (idempotent).
        const descriptor = Object.getOwnPropertyDescriptor(target, propertyKey);
        if (descriptor && typeof descriptor.value === "function") {
            wrapUploadValidation(target, propertyKey, descriptor);
            // wrapUploadValidation mutated descriptor.value in place.
            Object.defineProperty(target, propertyKey, descriptor);
        }
    };
}

/**
 * @UploadField decorator for GraphQL field-level upload configuration
 * Used to configure upload behavior for specific fields
 */
export function UploadField(config: UploadDecoratorConfig) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        logger.trace(`Registering @UploadField decorator for ${target.constructor.name}.${propertyKey}`);
        return wrapUploadValidation(target, propertyKey, descriptor);
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
                strictMimeType: true
            }
        });
    }
}
