import { describe, it, expect, beforeEach, mock } from "bun:test";
import { S3StorageProvider } from "../../../storage/S3StorageProvider";
import type { FileMetadata, UploadConfiguration } from "../../../types/upload.types";

function createMockS3Client(overrides: Record<string, any> = {}) {
    return {
        list: mock(async () => ({
            contents: [],
            isTruncated: false,
            keyCount: 0,
            maxKeys: 1000,
            name: "test-bucket",
        })),
        write: mock(async () => {}),
        delete: mock(async () => {}),
        exists: mock(async () => true),
        stat: mock(async () => ({
            size: 1024,
            lastModified: new Date("2026-01-01"),
            etag: '"abc123"',
            type: "image/png",
        })),
        file: mock((key: string) => ({
            stream: () => new ReadableStream(),
            arrayBuffer: async () => new ArrayBuffer(1024),
        })),
        presign: mock((key: string, opts?: any) => `https://s3.example.com/${key}?signed=true`),
        ...overrides,
    } as any;
}

function createTestMetadata(overrides: Partial<FileMetadata> = {}): FileMetadata {
    return {
        uploadId: "test-upload-id",
        fileName: "test-image.png",
        originalFileName: "my-photo.png",
        mimeType: "image/png",
        size: 1024,
        extension: ".png",
        uploadedAt: new Date().toISOString(),
        ...overrides,
    };
}

function createTestConfig(overrides: Partial<UploadConfiguration> = {}): UploadConfiguration {
    return {
        maxFileSize: 10 * 1024 * 1024,
        allowedMimeTypes: ["image/png", "image/jpeg"],
        allowedExtensions: [".png", ".jpg"],
        validateFileSignature: true,
        sanitizeFileName: true,
        preserveOriginalName: false,
        generateThumbnails: false,
        uploadPath: "uploads",
        namingStrategy: "uuid",
        ...overrides,
    };
}

describe("S3StorageProvider", () => {
    describe("constructor", () => {
        it("throws if bucket is missing", () => {
            const client = createMockS3Client();
            expect(
                () => new S3StorageProvider({ bucket: "" }, client),
            ).toThrow("bucket is required");
        });

        it("creates with required config", () => {
            const client = createMockS3Client();
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );
            expect(provider.getName()).toBe("s3");
        });

        it("applies default config values", () => {
            const client = createMockS3Client();
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );
            expect(provider).toBeDefined();
        });
    });

    describe("initialize", () => {
        it("verifies S3 connectivity via list", async () => {
            const client = createMockS3Client();
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );
            await provider.initialize();
            expect(client.list).toHaveBeenCalledWith({ maxKeys: 1 });
        });

        it("throws on connectivity failure", async () => {
            const client = createMockS3Client({
                list: mock(async () => {
                    throw new Error("Access Denied");
                }),
            });
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );
            await expect(provider.initialize()).rejects.toThrow(
                "S3 initialization failed: Access Denied",
            );
        });
    });

    describe("store", () => {
        it("writes file with correct key and options", async () => {
            const client = createMockS3Client();
            const provider = new S3StorageProvider(
                { bucket: "my-bucket", keyPrefix: "app/" },
                client,
            );
            const metadata = createTestMetadata();
            const config = createTestConfig();
            const file = new File(["data"], "test.png", { type: "image/png" });

            const result = await provider.store(file, metadata, config);

            expect(client.write).toHaveBeenCalled();
            const [key, body, opts] = client.write.mock.calls[0];
            expect(key).toBe("app/uploads/test-image.png");
            expect(body).toBeInstanceOf(File);
            expect(opts.type).toBe("image/png");
            expect(opts.acl).toBe("private");
            expect(result.path).toBe("app/uploads/test-image.png");
            expect(result.url).toBeTypeOf("string");
            expect(result.metadata?.bucket).toBe("my-bucket");
        });

        it("uses configured acl", async () => {
            const client = createMockS3Client();
            const provider = new S3StorageProvider(
                { bucket: "my-bucket", acl: "public-read" },
                client,
            );
            const file = new File(["data"], "test.png", { type: "image/png" });

            await provider.store(file, createTestMetadata(), createTestConfig());

            const [, , opts] = client.write.mock.calls[0];
            expect(opts.acl).toBe("public-read");
        });

        it("throws on write failure", async () => {
            const client = createMockS3Client({
                write: mock(async () => {
                    throw new Error("Write failed");
                }),
            });
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );
            const file = new File(["data"], "test.png", { type: "image/png" });

            await expect(
                provider.store(file, createTestMetadata(), createTestConfig()),
            ).rejects.toThrow("Failed to store file to S3");
        });
    });

    describe("delete", () => {
        it("deletes and returns true on success", async () => {
            const client = createMockS3Client();
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );

            const result = await provider.delete("uploads/file.png");
            expect(result).toBe(true);
            expect(client.delete).toHaveBeenCalledWith("uploads/file.png");
        });

        it("returns false on failure", async () => {
            const client = createMockS3Client({
                delete: mock(async () => {
                    throw new Error("Not found");
                }),
            });
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );

            const result = await provider.delete("uploads/file.png");
            expect(result).toBe(false);
        });

        it("sanitizes path traversal attempts", async () => {
            const client = createMockS3Client();
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );

            await provider.delete("../../../etc/passwd");
            const [key] = client.delete.mock.calls[0];
            expect(key).not.toContain("..");
        });
    });

    describe("getUrl", () => {
        it("returns presigned URL", async () => {
            const client = createMockS3Client();
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );

            const url = await provider.getUrl("uploads/file.png");
            expect(url).toContain("uploads/file.png");
            expect(client.presign).toHaveBeenCalled();
        });
    });

    describe("exists", () => {
        it("delegates to client.exists", async () => {
            const client = createMockS3Client();
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );

            const result = await provider.exists("uploads/file.png");
            expect(result).toBe(true);
            expect(client.exists).toHaveBeenCalledWith("uploads/file.png");
        });

        it("returns false on error", async () => {
            const client = createMockS3Client({
                exists: mock(async () => {
                    throw new Error("Network error");
                }),
            });
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );

            const result = await provider.exists("uploads/file.png");
            expect(result).toBe(false);
        });
    });

    describe("getMetadata", () => {
        it("returns metadata from stat", async () => {
            const client = createMockS3Client();
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );

            const meta = await provider.getMetadata("uploads/photo.png");
            expect(meta).not.toBeNull();
            expect(meta!.size).toBe(1024);
            expect(meta!.mimeType).toBe("image/png");
            expect(meta!.fileName).toBe("photo.png");
            expect(meta!.extension).toBe(".png");
        });

        it("returns null on error", async () => {
            const client = createMockS3Client({
                stat: mock(async () => {
                    throw new Error("Not found");
                }),
            });
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );

            const meta = await provider.getMetadata("uploads/missing.png");
            expect(meta).toBeNull();
        });
    });

    describe("list", () => {
        it("returns keys from paginated list", async () => {
            let callCount = 0;
            const client = createMockS3Client({
                list: mock(async () => {
                    callCount++;
                    if (callCount === 1) {
                        return {
                            contents: [
                                { key: "uploads/a.png", size: 100 },
                                { key: "uploads/b.png", size: 200 },
                            ],
                            isTruncated: true,
                            nextContinuationToken: "page2",
                            keyCount: 2,
                            maxKeys: 1000,
                            name: "test-bucket",
                        };
                    }
                    return {
                        contents: [{ key: "uploads/c.png", size: 300 }],
                        isTruncated: false,
                        keyCount: 1,
                        maxKeys: 1000,
                        name: "test-bucket",
                    };
                }),
            });
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );

            const keys = await provider.list("uploads");
            expect(keys).toEqual([
                "uploads/a.png",
                "uploads/b.png",
                "uploads/c.png",
            ]);
            expect(client.list).toHaveBeenCalledTimes(2);
        });

        it("returns empty array on error", async () => {
            const client = createMockS3Client({
                list: mock(async () => {
                    throw new Error("Forbidden");
                }),
            });
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );

            const keys = await provider.list("uploads");
            expect(keys).toEqual([]);
        });
    });

    describe("getStream", () => {
        it("returns a ReadableStream from S3File", async () => {
            const client = createMockS3Client();
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );

            const stream = await provider.getStream("uploads/file.png");
            expect(stream).toBeInstanceOf(ReadableStream);
            expect(client.file).toHaveBeenCalledWith("uploads/file.png");
        });
    });

    describe("copy", () => {
        it("reads source and writes to destination", async () => {
            const client = createMockS3Client();
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );

            const result = await provider.copy(
                "uploads/src.png",
                "uploads/dst.png",
            );
            expect(result).toBe(true);
            expect(client.file).toHaveBeenCalledWith("uploads/src.png");
            expect(client.stat).toHaveBeenCalledWith("uploads/src.png");
            expect(client.write).toHaveBeenCalled();
            const [destKey] = client.write.mock.calls[0];
            expect(destKey).toBe("uploads/dst.png");
        });

        it("returns false on failure", async () => {
            const client = createMockS3Client({
                file: mock(() => ({
                    arrayBuffer: async () => {
                        throw new Error("Read failed");
                    },
                })),
            });
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );

            const result = await provider.copy("src.png", "dst.png");
            expect(result).toBe(false);
        });
    });

    describe("move", () => {
        it("copies then deletes source", async () => {
            const client = createMockS3Client();
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );

            const result = await provider.move(
                "uploads/src.png",
                "uploads/dst.png",
            );
            expect(result).toBe(true);
            expect(client.write).toHaveBeenCalled();
            expect(client.delete).toHaveBeenCalledWith("uploads/src.png");
        });

        it("returns false if copy fails", async () => {
            const client = createMockS3Client({
                file: mock(() => ({
                    arrayBuffer: async () => {
                        throw new Error("Read failed");
                    },
                })),
            });
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );

            const result = await provider.move("src.png", "dst.png");
            expect(result).toBe(false);
            expect(client.delete).not.toHaveBeenCalled();
        });
    });

    describe("getStats", () => {
        it("sums files and sizes from list", async () => {
            const client = createMockS3Client({
                list: mock(async () => ({
                    contents: [
                        { key: "a.png", size: 100 },
                        { key: "b.png", size: 200 },
                    ],
                    isTruncated: false,
                    keyCount: 2,
                    maxKeys: 1000,
                    name: "test-bucket",
                })),
            });
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );

            const stats = await provider.getStats();
            expect(stats.totalFiles).toBe(2);
            expect(stats.totalSize).toBe(300);
        });
    });

    describe("cleanup", () => {
        it("is a no-op that resolves", async () => {
            const client = createMockS3Client();
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );
            await expect(provider.cleanup()).resolves.toBeUndefined();
        });
    });

    describe("resolveKey with keyPrefix", () => {
        it("prepends keyPrefix when missing from path", async () => {
            const client = createMockS3Client();
            const provider = new S3StorageProvider(
                { bucket: "my-bucket", keyPrefix: "app/" },
                client,
            );

            await provider.delete("uploads/file.png");
            const [key] = client.delete.mock.calls[0];
            expect(key).toBe("app/uploads/file.png");
        });

        it("does not double-prefix when path already has prefix", async () => {
            const client = createMockS3Client();
            const provider = new S3StorageProvider(
                { bucket: "my-bucket", keyPrefix: "app/" },
                client,
            );

            await provider.delete("app/uploads/file.png");
            const [key] = client.delete.mock.calls[0];
            expect(key).toBe("app/uploads/file.png");
        });

        it("normalizes keyPrefix to add trailing slash", () => {
            const client = createMockS3Client();
            const provider = new S3StorageProvider(
                { bucket: "my-bucket", keyPrefix: "app" },
                client,
            );

            // Verify via a store call that the key is correctly prefixed
            const file = new File(["data"], "test.png", { type: "image/png" });
            provider.store(file, createTestMetadata(), createTestConfig());
            const [key] = client.write.mock.calls[0];
            expect(key).toStartWith("app/");
        });
    });

    describe("config validation", () => {
        it("throws if presignExpiry is zero or negative", () => {
            const client = createMockS3Client();
            expect(
                () => new S3StorageProvider({ bucket: "my-bucket", presignExpiry: 0 }, client),
            ).toThrow("presignExpiry must be positive");
        });

        it("throws if publicPresignExpiry is zero or negative", () => {
            const client = createMockS3Client();
            expect(
                () => new S3StorageProvider({ bucket: "my-bucket", publicPresignExpiry: -1 }, client),
            ).toThrow("publicPresignExpiry must be positive");
        });
    });

    describe("sanitizePath security", () => {
        it("prevents nested path traversal bypass (....//)", async () => {
            const client = createMockS3Client();
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );

            await provider.delete("....//....//etc/passwd");
            const [key] = client.delete.mock.calls[0];
            // After iterative sanitization, no ".." sequences should remain
            expect(key).not.toContain("..");
        });

        it("handles deeply nested traversal patterns", async () => {
            const client = createMockS3Client();
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );

            await provider.delete("......///secret/file.txt");
            const [key] = client.delete.mock.calls[0];
            expect(key).not.toContain("..");
        });
    });

    describe("store error cleanup", () => {
        it("attempts to delete key on write failure", async () => {
            const client = createMockS3Client({
                write: mock(async () => {
                    throw new Error("Write failed");
                }),
            });
            const provider = new S3StorageProvider(
                { bucket: "my-bucket" },
                client,
            );
            const file = new File(["data"], "test.png", { type: "image/png" });

            await expect(
                provider.store(file, createTestMetadata(), createTestConfig()),
            ).rejects.toThrow("Failed to store file to S3");
            expect(client.delete).toHaveBeenCalled();
        });
    });
});
