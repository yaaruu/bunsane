import { S3Client } from "bun";
import { StorageProvider } from "./StorageProvider";
import type {
    UploadConfiguration,
    StorageResult,
    FileMetadata,
} from "../types/upload.types";
import { logger as MainLogger } from "../core/Logger";

const logger = MainLogger.child({ scope: "S3StorageProvider" });

export interface S3StorageConfig {
    bucket: string;
    region?: string;
    endpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    acl?: "private" | "public-read";
    keyPrefix?: string;
    /** Presign expiry in seconds for private objects (default: 3600) */
    presignExpiry?: number;
    /** Presign expiry in seconds for public-read objects (default: 86400 / 24h) */
    publicPresignExpiry?: number;
}

export class S3StorageProvider extends StorageProvider {
    private client: S3Client;
    private bucket: string;
    private acl: "private" | "public-read";
    private keyPrefix: string;
    private presignExpiry: number;
    private publicPresignExpiry: number;

    constructor(config: S3StorageConfig, client?: S3Client) {
        super("s3", config);
        this.bucket = config.bucket;
        this.acl = config.acl ?? "private";
        // Normalize keyPrefix to ensure trailing /
        const prefix = config.keyPrefix ?? "";
        this.keyPrefix = prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
        this.presignExpiry = config.presignExpiry ?? 3600;
        this.publicPresignExpiry = config.publicPresignExpiry ?? 86400;

        this.client =
            client ??
            new S3Client({
                bucket: config.bucket,
                region: config.region ?? process.env.S3_REGION,
                endpoint: config.endpoint ?? process.env.S3_ENDPOINT,
                accessKeyId:
                    config.accessKeyId ?? process.env.S3_ACCESS_KEY_ID,
                secretAccessKey:
                    config.secretAccessKey ?? process.env.S3_SECRET_ACCESS_KEY,
                sessionToken: config.sessionToken,
            });

        this.validateConfig();
    }

    public async initialize(): Promise<void> {
        logger.info(`Initializing S3 Storage Provider for bucket: ${this.bucket}`);
        try {
            await this.client.list({ maxKeys: 1 });
            logger.info("S3 connectivity verified");
        } catch (error) {
            const msg =
                error instanceof Error ? error.message : "Unknown error";
            logger.error(`S3 connectivity check failed: ${msg}`);
            throw new Error(`S3 initialization failed: ${msg}`);
        }
    }

    public async store(
        file: File,
        metadata: FileMetadata,
        config: UploadConfiguration,
    ): Promise<StorageResult> {
        const key = this.buildKey(config.uploadPath, metadata.fileName);

        logger.info({ key, size: metadata.size }, "Storing file to S3");

        try {
            // Pass File (Blob) directly — Bun streams it without full buffering
            await this.client.write(key, file, {
                type: metadata.mimeType,
                acl: this.acl,
            });

            const url = this.buildFileUrl(key);

            logger.info({ key }, "File stored successfully");

            return {
                path: key,
                url,
                metadata: {
                    ...metadata,
                    bucket: this.bucket,
                    s3Key: key,
                    storedAt: new Date().toISOString(),
                },
            };
        } catch (error) {
            // Attempt cleanup of any partial upload
            try {
                await this.client.delete(key);
            } catch {
                // Cleanup is best-effort
            }
            const msg =
                error instanceof Error ? error.message : "Unknown error";
            logger.error({ key }, "Failed to store file to S3");
            throw new Error(`Failed to store file to S3: ${msg}`);
        }
    }

    public async delete(filePath: string): Promise<boolean> {
        const key = this.resolveKey(filePath);
        try {
            await this.client.delete(key);
            logger.info(`File deleted from S3: ${key}`);
            return true;
        } catch (error) {
            const msg =
                error instanceof Error ? error.message : "Unknown error";
            logger.error(`Failed to delete file ${key}: ${msg}`);
            return false;
        }
    }

    public async getUrl(filePath: string): Promise<string> {
        const key = this.resolveKey(filePath);
        return this.buildFileUrl(key);
    }

    public async exists(filePath: string): Promise<boolean> {
        const key = this.resolveKey(filePath);
        try {
            return await this.client.exists(key);
        } catch {
            return false;
        }
    }

    public async getMetadata(filePath: string): Promise<FileMetadata | null> {
        const key = this.resolveKey(filePath);
        try {
            const stat = await this.client.stat(key);
            const fileName = key.split("/").pop() ?? key;
            const extIdx = fileName.lastIndexOf(".");
            const extension = extIdx > 0 ? fileName.slice(extIdx) : "";

            return {
                uploadId: "",
                fileName,
                originalFileName: fileName,
                mimeType: stat.type ?? "application/octet-stream",
                size: stat.size,
                extension,
                uploadedAt: stat.lastModified
                    ? stat.lastModified.toISOString()
                    : new Date().toISOString(),
            };
        } catch (error) {
            const msg =
                error instanceof Error ? error.message : "Unknown error";
            logger.error(`Failed to get metadata for ${key}: ${msg}`);
            return null;
        }
    }

    public async list(prefix: string): Promise<string[]> {
        const resolvedPrefix = this.keyPrefix + this.sanitizePath(prefix);
        const keys: string[] = [];
        let continuationToken: string | undefined;

        try {
            do {
                const page = await this.client.list({
                    prefix: resolvedPrefix,
                    maxKeys: 1000,
                    continuationToken,
                });
                for (const obj of page.contents ?? []) {
                    keys.push(obj.key);
                }
                continuationToken = page.isTruncated
                    ? page.nextContinuationToken
                    : undefined;
            } while (continuationToken);

            return keys;
        } catch (error) {
            const msg =
                error instanceof Error ? error.message : "Unknown error";
            logger.error(`Failed to list prefix ${resolvedPrefix}: ${msg}`);
            return [];
        }
    }

    public async getStream(filePath: string): Promise<ReadableStream> {
        const key = this.resolveKey(filePath);
        const s3File = this.client.file(key);
        return s3File.stream();
    }

    public async copy(
        sourcePath: string,
        destinationPath: string,
    ): Promise<boolean> {
        const sourceKey = this.resolveKey(sourcePath);
        const destKey = this.resolveKey(destinationPath);

        try {
            const stat = await this.client.stat(sourceKey);
            const sourceFile = this.client.file(sourceKey);
            // Pass the S3File directly so Bun streams bytes rather than loading
            // the entire object into memory (previously `arrayBuffer()`).
            await this.client.write(destKey, sourceFile, {
                type: stat.type,
                acl: this.acl,
            });
            logger.info({ sourceKey, destKey }, "File copied");
            return true;
        } catch (error) {
            const msg =
                error instanceof Error ? error.message : "Unknown error";
            logger.error({ sourceKey, destKey, err: msg }, "Failed to copy file");
            return false;
        }
    }

    public async move(
        sourcePath: string,
        destinationPath: string,
    ): Promise<boolean> {
        const success = await this.copy(sourcePath, destinationPath);
        if (success) {
            return await this.delete(sourcePath);
        }
        return false;
    }

    public async getStats(): Promise<{
        totalFiles: number;
        totalSize: number;
    }> {
        let totalFiles = 0;
        let totalSize = 0;
        let continuationToken: string | undefined;

        try {
            do {
                const page = await this.client.list({
                    prefix: this.keyPrefix,
                    maxKeys: 1000,
                    continuationToken,
                });
                for (const obj of page.contents ?? []) {
                    totalFiles++;
                    totalSize += obj.size ?? 0;
                }
                continuationToken = page.isTruncated
                    ? page.nextContinuationToken
                    : undefined;
            } while (continuationToken);

            return { totalFiles, totalSize };
        } catch (error) {
            const msg =
                error instanceof Error ? error.message : "Unknown error";
            logger.error(`Failed to get S3 stats: ${msg}`);
            return { totalFiles: 0, totalSize: 0 };
        }
    }

    public async cleanup(): Promise<void> {
        // S3 lifecycle policies handle cleanup — no-op
        logger.info("S3 storage cleanup — managed by S3 lifecycle policies");
    }

    protected validateConfig(): boolean {
        if (!this.bucket) {
            throw new Error("S3StorageProvider: bucket is required");
        }
        if (this.presignExpiry <= 0) {
            throw new Error("S3StorageProvider: presignExpiry must be positive");
        }
        if (this.publicPresignExpiry <= 0) {
            throw new Error("S3StorageProvider: publicPresignExpiry must be positive");
        }
        return true;
    }

    private buildKey(uploadPath: string, fileName: string): string {
        const path = this.buildPath(uploadPath, fileName);
        return `${this.keyPrefix}${this.sanitizePath(path)}`;
    }

    private resolveKey(filePath: string): string {
        const sanitized = this.sanitizePath(filePath);
        if (this.keyPrefix && !sanitized.startsWith(this.keyPrefix)) {
            return `${this.keyPrefix}${sanitized}`;
        }
        return sanitized;
    }

    private buildFileUrl(key: string): string {
        const expiresIn =
            this.acl === "public-read"
                ? this.publicPresignExpiry
                : this.presignExpiry;
        return this.client.presign(key, { expiresIn, method: "GET" });
    }
}
