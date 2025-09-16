import type { ImageProcessingOptions } from "../../types/upload.types";
import { logger as MainLogger } from "../Logger";

const logger = MainLogger.child({ scope: "ImageProcessor" });

/**
 * ImageProcessor - Handle image manipulation and processing
 * Note: This is a basic implementation. For production use, consider integrating
 * with Sharp, Jimp, or similar image processing libraries.
 */
export class ImageProcessor {
    /**
     * Process image according to configuration
     */
    public static async processImage(
        file: File,
        options: ImageProcessingOptions
    ): Promise<{
        processedFile: File;
        metadata: {
            width: number;
            height: number;
            format: string;
            size: number;
        };
        thumbnails?: Array<{
            size: string;
            file: File;
            width: number;
            height: number;
        }>;
    }> {
        logger.info(`Processing image: ${file.name}`);
        
        try {
            // Get image metadata
            const metadata = await this.getImageMetadata(file);
            
            let processedFile = file;
            
            // Resize if needed
            if (options.maxDimensions) {
                processedFile = await this.resizeImage(
                    processedFile,
                    options.maxDimensions.width,
                    options.maxDimensions.height
                );
            }
            
            // Compress if needed
            if (options.compress && options.quality) {
                processedFile = await this.compressImage(processedFile, options.quality);
            }
            
            // Convert format if needed
            if (options.convertTo) {
                processedFile = await this.convertFormat(processedFile, options.convertTo);
            }
            
            // Generate thumbnails
            let thumbnails: Array<{
                size: string;
                file: File;
                width: number;
                height: number;
            }> | undefined;
            
            if (options.generateThumbnails && options.thumbnailSizes) {
                thumbnails = await this.generateThumbnails(processedFile, options.thumbnailSizes);
            }
            
            const finalMetadata = await this.getImageMetadata(processedFile);
            
            logger.info(`Image processing completed for: ${file.name}`);
            
            return {
                processedFile,
                metadata: finalMetadata,
                thumbnails
            };
            
        } catch (error) {
            logger.error(`Image processing failed for ${file.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            throw error;
        }
    }

    /**
     * Get image metadata (basic implementation)
     * In production, use a proper image processing library
     */
    public static async getImageMetadata(file: File): Promise<{
        width: number;
        height: number;
        format: string;
        size: number;
    }> {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(file);
            
            img.onload = () => {
                URL.revokeObjectURL(url);
                resolve({
                    width: img.width,
                    height: img.height,
                    format: file.type.split('/')[1] || 'unknown',
                    size: file.size
                });
            };
            
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Failed to load image for metadata extraction'));
            };
            
            img.src = url;
        });
    }

    /**
     * Resize image (basic canvas implementation)
     * For production, use Sharp or similar library
     */
    public static async resizeImage(
        file: File,
        maxWidth: number,
        maxHeight: number
    ): Promise<File> {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            if (!ctx) {
                reject(new Error('Canvas context not available'));
                return;
            }
            
            img.onload = () => {
                // Calculate new dimensions
                const { width: newWidth, height: newHeight } = this.calculateDimensions(
                    img.width,
                    img.height,
                    maxWidth,
                    maxHeight
                );
                
                canvas.width = newWidth;
                canvas.height = newHeight;
                
                // Draw resized image
                ctx.drawImage(img, 0, 0, newWidth, newHeight);
                
                // Convert to file
                canvas.toBlob((blob) => {
                    if (blob) {
                        const resizedFile = new File([blob], file.name, {
                            type: file.type,
                            lastModified: Date.now()
                        });
                        resolve(resizedFile);
                    } else {
                        reject(new Error('Failed to create resized image blob'));
                    }
                }, file.type);
            };
            
            img.onerror = () => {
                reject(new Error('Failed to load image for resizing'));
            };
            
            img.src = URL.createObjectURL(file);
        });
    }

    /**
     * Compress image (basic implementation)
     */
    public static async compressImage(file: File, quality: number): Promise<File> {
        if (!file.type.startsWith('image/')) {
            return file;
        }
        
        return new Promise((resolve, reject) => {
            const img = new Image();
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            if (!ctx) {
                reject(new Error('Canvas context not available'));
                return;
            }
            
            img.onload = () => {
                canvas.width = img.width;
                canvas.height = img.height;
                
                ctx.drawImage(img, 0, 0);
                
                // Convert with quality
                canvas.toBlob((blob) => {
                    if (blob) {
                        const compressedFile = new File([blob], file.name, {
                            type: file.type,
                            lastModified: Date.now()
                        });
                        resolve(compressedFile);
                    } else {
                        reject(new Error('Failed to create compressed image blob'));
                    }
                }, file.type, quality / 100);
            };
            
            img.onerror = () => {
                reject(new Error('Failed to load image for compression'));
            };
            
            img.src = URL.createObjectURL(file);
        });
    }

    /**
     * Convert image format
     */
    public static async convertFormat(
        file: File,
        targetFormat: "jpeg" | "png" | "webp"
    ): Promise<File> {
        const mimeType = `image/${targetFormat}`;
        const extension = targetFormat === 'jpeg' ? 'jpg' : targetFormat;
        const newName = file.name.replace(/\.[^/.]+$/, `.${extension}`);
        
        return new Promise((resolve, reject) => {
            const img = new Image();
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            if (!ctx) {
                reject(new Error('Canvas context not available'));
                return;
            }
            
            img.onload = () => {
                canvas.width = img.width;
                canvas.height = img.height;
                
                // Set white background for JPEG conversion
                if (targetFormat === 'jpeg') {
                    ctx.fillStyle = '#FFFFFF';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                }
                
                ctx.drawImage(img, 0, 0);
                
                canvas.toBlob((blob) => {
                    if (blob) {
                        const convertedFile = new File([blob], newName, {
                            type: mimeType,
                            lastModified: Date.now()
                        });
                        resolve(convertedFile);
                    } else {
                        reject(new Error('Failed to create converted image blob'));
                    }
                }, mimeType);
            };
            
            img.onerror = () => {
                reject(new Error('Failed to load image for format conversion'));
            };
            
            img.src = URL.createObjectURL(file);
        });
    }

    /**
     * Generate thumbnails
     */
    public static async generateThumbnails(
        file: File,
        sizes: Array<{ width: number; height: number; suffix: string }>
    ): Promise<Array<{
        size: string;
        file: File;
        width: number;
        height: number;
    }>> {
        const thumbnails: Array<{
            size: string;
            file: File;
            width: number;
            height: number;
        }> = [];
        
        for (const size of sizes) {
            try {
                const thumbnail = await this.createThumbnail(file, size.width, size.height, size.suffix);
                thumbnails.push({
                    size: `${size.width}x${size.height}`,
                    file: thumbnail,
                    width: size.width,
                    height: size.height
                });
            } catch (error) {
                logger.warn(`Failed to generate ${size.width}x${size.height} thumbnail: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        }
        
        return thumbnails;
    }

    /**
     * Create a single thumbnail
     */
    private static async createThumbnail(
        file: File,
        width: number,
        height: number,
        suffix: string
    ): Promise<File> {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            if (!ctx) {
                reject(new Error('Canvas context not available'));
                return;
            }
            
            img.onload = () => {
                // Calculate dimensions maintaining aspect ratio
                const { width: newWidth, height: newHeight } = this.calculateDimensions(
                    img.width,
                    img.height,
                    width,
                    height
                );
                
                canvas.width = newWidth;
                canvas.height = newHeight;
                
                ctx.drawImage(img, 0, 0, newWidth, newHeight);
                
                const fileName = file.name.replace(/(\.[^.]+)$/, `${suffix}$1`);
                
                canvas.toBlob((blob) => {
                    if (blob) {
                        const thumbnailFile = new File([blob], fileName, {
                            type: file.type,
                            lastModified: Date.now()
                        });
                        resolve(thumbnailFile);
                    } else {
                        reject(new Error('Failed to create thumbnail blob'));
                    }
                }, file.type);
            };
            
            img.onerror = () => {
                reject(new Error('Failed to load image for thumbnail creation'));
            };
            
            img.src = URL.createObjectURL(file);
        });
    }

    /**
     * Calculate new dimensions maintaining aspect ratio
     */
    private static calculateDimensions(
        originalWidth: number,
        originalHeight: number,
        maxWidth: number,
        maxHeight: number
    ): { width: number; height: number } {
        const aspectRatio = originalWidth / originalHeight;
        
        let newWidth = originalWidth;
        let newHeight = originalHeight;
        
        if (originalWidth > maxWidth) {
            newWidth = maxWidth;
            newHeight = newWidth / aspectRatio;
        }
        
        if (newHeight > maxHeight) {
            newHeight = maxHeight;
            newWidth = newHeight * aspectRatio;
        }
        
        return {
            width: Math.round(newWidth),
            height: Math.round(newHeight)
        };
    }

    /**
     * Validate if file is a processable image
     */
    public static isProcessableImage(file: File): boolean {
        const processableTypes = [
            'image/jpeg',
            'image/png',
            'image/gif',
            'image/webp'
        ];
        
        return processableTypes.includes(file.type);
    }

    /**
     * Get optimal quality based on file size
     */
    public static getOptimalQuality(fileSize: number): number {
        // Reduce quality for larger files
        if (fileSize > 5 * 1024 * 1024) return 70; // >5MB
        if (fileSize > 2 * 1024 * 1024) return 80; // >2MB
        if (fileSize > 1 * 1024 * 1024) return 85; // >1MB
        return 90; // Default quality
    }
}