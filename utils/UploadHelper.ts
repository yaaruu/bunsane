import { UploadManager } from "../core/UploadManager";
import { UploadComponent, ImageMetadataComponent } from "../core/components/UploadComponent";
import { Entity } from "../core/Entity";
import type { UploadConfiguration, UploadResult, BatchUploadResult } from "../types/upload.types";
import { logger as MainLogger } from "../core/Logger";

const logger = MainLogger.child({ scope: "UploadHelper" });

/**
 * UploadHelper - Utility class for common upload operations
 * Provides convenience methods for handling uploads in services
 */
export class UploadHelper {
    private static uploadManager = UploadManager.getInstance();

    /**
     * Process single file upload and attach to entity
     */
    static async processUploadForEntity(
        entity: Entity,
        file: File,
        config?: Partial<UploadConfiguration>
    ): Promise<UploadResult> {
        try {
            logger.info(`Processing upload for entity ${entity.id}`);
            
            const result = await this.uploadManager.uploadFile(file, config);
            
            if (result.success && result.uploadId) {
                // Create and attach upload component
                const uploadComponent = new UploadComponent();
                uploadComponent.setUploadData({
                    success: result.success,
                    uploadId: result.uploadId,
                    fileName: result.fileName!,
                    originalFileName: result.originalFileName!,
                    mimeType: result.mimeType!,
                    size: result.size!,
                    path: result.path!,
                    url: result.url!,
                    uploadedAt: new Date().toISOString(),
                    metadata: result.metadata || {}
                });
                
                entity.add(UploadComponent, uploadComponent.data());

                // TODO: For better modularity, user might want to use plugins instead
                // Add image metadata if it's an image
                // if (result.mimeType?.startsWith('image/')) {
                //     await this.addImageMetadata(entity, file, result);
                // }
                
                logger.info(`Upload component attached to entity ${entity.id}`);
            }
            
            return result;
            
        } catch (error) {
            logger.error(`Failed to process upload for entity ${entity.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            throw error;
        }
    }

    /**
     * Process multiple files for an entity
     */
    static async processBatchUploadForEntity(
        entity: Entity,
        files: File[],
        config?: Partial<UploadConfiguration>
    ): Promise<BatchUploadResult> {
        logger.info(`Processing batch upload of ${files.length} files for entity ${entity.id}`);
        
        const results = await this.uploadManager.uploadFiles(files, config);
        
        let successfulUploads = 0;
        let failedUploads = 0;
        const errors: any[] = [];
        
        for (const result of results) {
            if (result.success) {
                successfulUploads++;
                
                // Attach upload component to entity
                const uploadComponent = new UploadComponent();
                uploadComponent.setUploadData({
                    success: result.success,
                    uploadId: result.uploadId!,
                    fileName: result.fileName!,
                    originalFileName: result.originalFileName!,
                    mimeType: result.mimeType!,
                    size: result.size!,
                    path: result.path!,
                    url: result.url!,
                    uploadedAt: new Date().toISOString(),
                    metadata: result.metadata || {}
                });
                
                entity.add(UploadComponent, uploadComponent.data());
                
            } else {
                failedUploads++;
                if (result.error) {
                    errors.push(result.error);
                }
            }
        }
        
        return {
            totalFiles: files.length,
            successfulUploads,
            failedUploads,
            results,
            errors
        };
    }

    /**
     * Replace existing upload on entity
     */
    static async replaceUploadForEntity(
        entity: Entity,
        file: File,
        config?: Partial<UploadConfiguration>
    ): Promise<UploadResult> {
        // Remove existing upload component if present
        const existingUpload = await entity.get(UploadComponent);
        if (existingUpload) {
            // Delete old file
            await this.uploadManager.deleteFile(existingUpload.path);
            // Remove component data will be handled by the new upload
        }
        
        return await this.processUploadForEntity(entity, file, config);
    }

    /**
     * Get upload URLs for entity
     */
    static async getUploadUrlsForEntity(entity: Entity): Promise<string[]> {
        const upload = await entity.get(UploadComponent);
        return upload ? [upload.url] : [];
    }

    /**
     * Clean up orphaned uploads for entity
     */
    static async cleanupOrphanedUploads(entity: Entity): Promise<number> {
        let cleaned = 0;
        
        try {
            const upload = await entity.get(UploadComponent);
            
            if (upload) {
                const exists = await this.uploadManager.getStorageProvider().exists(upload.path);
                if (!exists) {
                    // File doesn't exist, remove component
                    // This would require entity method to remove specific component instance
                    cleaned++;
                    logger.info(`Cleaned orphaned upload reference: ${upload.path}`);
                }
            }
            
        } catch (error) {
            logger.error(`Failed to cleanup orphaned uploads for entity ${entity.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
        
        return cleaned;
    }

    /**
     * Get total storage used by entity
     */
    static async getEntityStorageUsage(entity: Entity): Promise<number> {
        const upload = await entity.get(UploadComponent);
        return upload ? upload.size : 0;
    }

    /**
     * Validate file before upload
     */
    static async validateFile(file: File, config: UploadConfiguration): Promise<boolean> {
        const validator = (this.uploadManager as any).fileValidator;
        const result = await validator.validate(file, config);
        return result.valid;
    }

    /**
     * Generate secure file URL with expiration
     */
    static async getSecureFileUrl(
        path: string,
        expiresIn: number = 3600, // 1 hour default
        storageProvider?: string
    ): Promise<string | null> {
        // This would be implemented by storage providers that support signed URLs
        const provider = this.uploadManager.getStorageProvider(storageProvider);
        
        // For now, return regular URL
        // TODO: Implement signed URL generation for cloud providers
        return await provider.getUrl(path);
    }

    /**
     * Copy upload from one entity to another
     */
    static async copyUploadBetweenEntities(
        sourceEntity: Entity,
        targetEntity: Entity,
        preserveOriginal: boolean = true
    ): Promise<boolean> {
        try {
            const sourceUpload = await sourceEntity.get(UploadComponent);
            if (!sourceUpload) {
                return false;
            }
            
            const provider = this.uploadManager.getStorageProvider();
            
            if (preserveOriginal) {
                // Copy file to new location
                const newPath = sourceUpload.path.replace(
                    sourceEntity.id,
                    targetEntity.id
                );
                
                const success = await provider.copy(sourceUpload.path, newPath);
                if (success) {
                    // Create new upload component for target entity
                    const newUpload = new UploadComponent();
                    newUpload.setUploadData({
                        success: true,
                        uploadId: targetEntity.id,
                        fileName: sourceUpload.fileName,
                        originalFileName: sourceUpload.originalFileName,
                        mimeType: sourceUpload.mimeType,
                        size: sourceUpload.size,
                        path: newPath,
                        url: await provider.getUrl(newPath),
                        uploadedAt: sourceUpload.uploadedAt,
                        metadata: JSON.parse(sourceUpload.metadata || '{}')
                    });
                    
                    targetEntity.add(UploadComponent, newUpload.data());
                    return true;
                }
            } else {
                // Move file
                const newPath = sourceUpload.path.replace(
                    sourceEntity.id,
                    targetEntity.id
                );
                
                const success = await provider.move(sourceUpload.path, newPath);
                if (success) {
                    // Remove from source and add to target
                    const newUpload = new UploadComponent();
                    newUpload.setUploadData({
                        success: true,
                        uploadId: targetEntity.id,
                        fileName: sourceUpload.fileName,
                        originalFileName: sourceUpload.originalFileName,
                        mimeType: sourceUpload.mimeType,
                        size: sourceUpload.size,
                        path: newPath,
                        url: await provider.getUrl(newPath),
                        uploadedAt: sourceUpload.uploadedAt,
                        metadata: JSON.parse(sourceUpload.metadata || '{}')
                    });
                    
                    targetEntity.add(UploadComponent, newUpload.data());
                    // TODO: Remove from source entity
                    return true;
                }
            }
            
            return false;
            
        } catch (error) {
            logger.error(`Failed to copy upload between entities: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return false;
        }
    }

    /**
     * Add image metadata to entity
     */
    private static async addImageMetadata(
        entity: Entity,
        file: File,
        uploadResult: UploadResult
    ): Promise<void> {
        try {
            // For now, we'll add basic metadata
            // In a full implementation, this would use an image processing library
            const imageMetadata = new ImageMetadataComponent();
            
            // Set basic metadata (would be extracted from actual image)
            imageMetadata.width = 0; // Would be set from image analysis
            imageMetadata.height = 0; // Would be set from image analysis
            imageMetadata.hasAlpha = file.type === 'image/png';
            imageMetadata.isAnimated = file.type === 'image/gif';
            
            entity.add(ImageMetadataComponent, imageMetadata.data());
            
        } catch (error) {
            logger.warn(`Failed to add image metadata: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    static async deleteFile(path: string): Promise<boolean> {
        try {
            const provider = this.uploadManager.getStorageProvider();
            const success = await provider.delete(path);
            if (success) {
                logger.info(`Deleted file at path: ${path}`);
            } else {
                logger.warn(`File at path ${path} not found for deletion`);
            }
            return success;
        } catch (error) {
            logger.error(`Failed to delete file at path ${path}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return false;
        }
    }
}