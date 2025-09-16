import type { UploadConfiguration, ValidationResult } from "../types/upload.types";
import { logger as MainLogger } from "./Logger";

const logger = MainLogger.child({ scope: "FileValidator" });

/**
 * File Validator - Comprehensive file validation and security checking
 */
export class FileValidator {
    private fileSignatures: Map<string, Uint8Array[]>;

    constructor() {
        this.fileSignatures = this.initializeFileSignatures();
    }

    /**
     * Validate a file against configuration rules
     */
    public async validate(file: File, config: UploadConfiguration): Promise<ValidationResult> {
        const errors: string[] = [];
        const warnings: string[] = [];

        logger.trace(`Validating file: ${file.name} (${file.size} bytes, ${file.type})`);

        // File size validation
        if (file.size > config.maxFileSize) {
            errors.push(`File size ${file.size} exceeds maximum allowed size ${config.maxFileSize}`);
        }

        if (file.size === 0) {
            errors.push("File is empty");
        }

        // MIME type validation
        if (config.allowedMimeTypes.length > 0) {
            if (!config.allowedMimeTypes.includes(file.type)) {
                errors.push(`MIME type "${file.type}" is not allowed. Allowed types: ${config.allowedMimeTypes.join(", ")}`);
            }
        }

        // File extension validation
        if (config.allowedExtensions.length > 0) {
            const extension = this.getFileExtension(file.name);
            if (!config.allowedExtensions.includes(extension)) {
                errors.push(`File extension "${extension}" is not allowed. Allowed extensions: ${config.allowedExtensions.join(", ")}`);
            }
        }

        // File signature validation (magic numbers)
        if (config.validateFileSignature) {
            try {
                const signatureValid = await this.validateFileSignature(file);
                if (!signatureValid) {
                    errors.push("File signature does not match MIME type (possible file type spoofing)");
                }
            } catch (error) {
                warnings.push(`Could not validate file signature: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        }

        // File name validation
        const nameValidation = this.validateFileName(file.name);
        if (!nameValidation.valid) {
            errors.push(...nameValidation.errors);
        }

        // Custom validation
        if (config.validation?.customValidators) {
            for (const validator of config.validation.customValidators) {
                try {
                    const result = await validator(file);
                    if (!result.valid) {
                        errors.push(...result.errors);
                    }
                    if (result.warnings) {
                        warnings.push(...result.warnings);
                    }
                } catch (error) {
                    warnings.push(`Custom validator failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
                }
            }
        }

        const valid = errors.length === 0;
        
        if (!valid) {
            logger.warn(`File validation failed for ${file.name}: ${errors.join(', ')}`);
        } else {
            logger.trace(`File validation passed for ${file.name}`);
        }

        return {
            valid,
            errors,
            warnings: warnings.length > 0 ? warnings : undefined
        };
    }

    /**
     * Validate file name for security issues
     */
    public validateFileName(fileName: string): ValidationResult {
        const errors: string[] = [];

        // Check for path traversal attempts
        if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
            errors.push("File name contains invalid path characters");
        }

        // Check for dangerous characters
        const dangerousChars = /[<>:"|?*\x00-\x1f]/;
        if (dangerousChars.test(fileName)) {
            errors.push("File name contains dangerous characters");
        }

        // Check for reserved names (Windows)
        const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
        if (reservedNames.test(fileName)) {
            errors.push("File name is a reserved system name");
        }

        // Check for hidden files
        if (fileName.startsWith(".")) {
            errors.push("Hidden files are not allowed");
        }

        // Check file name length
        if (fileName.length > 255) {
            errors.push("File name is too long (maximum 255 characters)");
        }

        if (fileName.length === 0) {
            errors.push("File name cannot be empty");
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    /**
     * Validate file signature against MIME type
     */
    private async validateFileSignature(file: File): Promise<boolean> {
        const buffer = await file.slice(0, 32).arrayBuffer();
        const bytes = new Uint8Array(buffer);
        
        const expectedSignatures = this.getSignaturesForMimeType(file.type);
        if (expectedSignatures.length === 0) {
            // No known signatures for this MIME type
            return true;
        }

        return expectedSignatures.some(signature => 
            this.bytesMatch(bytes, signature)
        );
    }

    /**
     * Check if bytes match a signature
     */
    private bytesMatch(bytes: Uint8Array, signature: Uint8Array): boolean {
        if (bytes.length < signature.length) {
            return false;
        }

        for (let i = 0; i < signature.length; i++) {
            if (bytes[i] !== signature[i]) {
                return false;
            }
        }

        return true;
    }

    /**
     * Get file signatures for MIME type
     */
    private getSignaturesForMimeType(mimeType: string): Uint8Array[] {
        return this.fileSignatures.get(mimeType) || [];
    }

    /**
     * Extract file extension from filename
     */
    private getFileExtension(fileName: string): string {
        const lastDot = fileName.lastIndexOf('.');
        return lastDot > 0 ? fileName.slice(lastDot).toLowerCase() : '';
    }

    /**
     * Initialize known file signatures (magic numbers)
     */
    private initializeFileSignatures(): Map<string, Uint8Array[]> {
        const signatures = new Map<string, Uint8Array[]>();

        // Image formats
        signatures.set("image/jpeg", [
            new Uint8Array([0xFF, 0xD8, 0xFF])
        ]);

        signatures.set("image/png", [
            new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        ]);

        signatures.set("image/gif", [
            new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]), // GIF87a
            new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])  // GIF89a
        ]);

        signatures.set("image/webp", [
            new Uint8Array([0x52, 0x49, 0x46, 0x46]) // RIFF (WebP is RIFF-based)
        ]);

        // Document formats
        signatures.set("application/pdf", [
            new Uint8Array([0x25, 0x50, 0x44, 0x46]) // %PDF
        ]);

        // Archive formats
        signatures.set("application/zip", [
            new Uint8Array([0x50, 0x4B, 0x03, 0x04]), // ZIP
            new Uint8Array([0x50, 0x4B, 0x05, 0x06]), // Empty ZIP
            new Uint8Array([0x50, 0x4B, 0x07, 0x08])  // Spanned ZIP
        ]);

        return signatures;
    }

    /**
     * Get human-readable validation summary
     */
    public getValidationSummary(result: ValidationResult): string {
        if (result.valid) {
            return "File validation passed";
        }

        let summary = `File validation failed: ${result.errors.join("; ")}`;
        
        if (result.warnings && result.warnings.length > 0) {
            summary += ` | Warnings: ${result.warnings.join("; ")}`;
        }

        return summary;
    }

    /**
     * Check if file is potentially dangerous
     */
    public async isDangerous(file: File): Promise<boolean> {
        // Check for executable file extensions
        const dangerousExtensions = [
            '.exe', '.scr', '.bat', '.cmd', '.com', '.pif', '.vbs', '.js', '.jar',
            '.sh', '.py', '.pl', '.php', '.asp', '.aspx', '.jsp'
        ];

        const extension = this.getFileExtension(file.name);
        if (dangerousExtensions.includes(extension)) {
            return true;
        }

        // Check for polyglot files (files that are valid in multiple formats)
        try {
            const buffer = await file.slice(0, 1024).arrayBuffer();
            const bytes = new Uint8Array(buffer);
            const content = new TextDecoder().decode(bytes);
            
            // Look for script patterns
            const scriptPatterns = [
                /<script/i,
                /javascript:/i,
                /vbscript:/i,
                /<iframe/i,
                /<object/i,
                /<embed/i
            ];

            return scriptPatterns.some(pattern => pattern.test(content));
        } catch {
            return false;
        }
    }
}