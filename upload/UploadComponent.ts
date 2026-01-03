import { BaseComponent, Component, CompData } from "../core/components";
import type { UploadResult } from "../types/upload.types";

/**
 * UploadComponent - Stores file upload metadata in entities
 * This component contains all essential information about uploaded files
 */
@Component
export class UploadComponent extends BaseComponent {
    @CompData()
    uploadId: string = "";

    @CompData()
    fileName: string = "";

    @CompData()
    originalFileName: string = "";

    @CompData()
    mimeType: string = "";

    @CompData()
    size: number = 0;

    @CompData()
    path: string = "";

    @CompData()
    url: string = "";

    @CompData()
    uploadedAt: string = "";

    @CompData()
    metadata: string = "{}"; // JSON string for additional metadata

    /**
     * Set upload data from UploadResult
     */
    public setUploadData(data: UploadResult): void {
        this.uploadId = data.uploadId ?? "";
        this.fileName = data.fileName ?? "";
        this.originalFileName = data.originalFileName ?? "";
        this.mimeType = data.mimeType ?? "";
        this.size = data.size ?? 0;
        this.path = data.path ?? "";
        this.url = data.url ?? "";
        this.uploadedAt = new Date().toISOString();
        this.metadata = JSON.stringify(data.metadata || {});
    }

    /**
     * Get parsed metadata
     */
    public getMetadata(): Record<string, any> {
        try {
            return JSON.parse(this.metadata);
        } catch {
            return {};
        }
    }

    /**
     * Update metadata
     */
    public updateMetadata(newMetadata: Record<string, any>): void {
        const current = this.getMetadata();
        this.metadata = JSON.stringify({ ...current, ...newMetadata });
    }

    /**
     * Check if this is an image file
     */
    public isImage(): boolean {
        return this.mimeType.startsWith("image/");
    }

    /**
     * Check if this is a document file
     */
    public isDocument(): boolean {
        const documentMimeTypes = [
            "application/pdf",
            "text/plain",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ];
        return documentMimeTypes.includes(this.mimeType);
    }

    /**
     * Get file extension
     */
    public getExtension(): string {
        const lastDot = this.fileName.lastIndexOf('.');
        return lastDot > 0 ? this.fileName.slice(lastDot) : '';
    }

    /**
     * Get human-readable file size
     */
    public getHumanReadableSize(): string {
        const bytes = this.size;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        if (bytes === 0) return '0 Bytes';
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
    }

    /**
     * Get upload age in days
     */
    public getUploadAge(): number {
        const uploadDate = new Date(this.uploadedAt);
        const now = new Date();
        const diffTime = Math.abs(now.getTime() - uploadDate.getTime());
        return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    }
}

/**
 * ImageMetadataComponent - Extended metadata for image files
 */
@Component
export class ImageMetadataComponent extends BaseComponent {
    @CompData()
    width: number = 0;

    @CompData()
    height: number = 0;

    @CompData()
    colorDepth: number = 0;

    @CompData()
    hasAlpha: boolean = false;

    @CompData()
    isAnimated: boolean = false;

    @CompData()
    thumbnails: string = "[]"; // JSON array of thumbnail paths

    /**
     * Set image dimensions
     */
    public setDimensions(width: number, height: number): void {
        this.width = width;
        this.height = height;
    }

    /**
     * Get aspect ratio
     */
    public getAspectRatio(): number {
        return this.height > 0 ? this.width / this.height : 0;
    }

    /**
     * Get thumbnail paths
     */
    public getThumbnails(): Array<{ size: string; url: string; path: string }> {
        try {
            return JSON.parse(this.thumbnails);
        } catch {
            return [];
        }
    }

    /**
     * Add thumbnail
     */
    public addThumbnail(thumbnail: { size: string; url: string; path: string }): void {
        const thumbnails = this.getThumbnails();
        thumbnails.push(thumbnail);
        this.thumbnails = JSON.stringify(thumbnails);
    }

    /**
     * Check if image is landscape
     */
    public isLandscape(): boolean {
        return this.width > this.height;
    }

    /**
     * Check if image is portrait
     */
    public isPortrait(): boolean {
        return this.height > this.width;
    }

    /**
     * Check if image is square
     */
    public isSquare(): boolean {
        return this.width === this.height;
    }

    /**
     * Get megapixels
     */
    public getMegapixels(): number {
        return Math.round((this.width * this.height) / 1000000 * 100) / 100;
    }
}