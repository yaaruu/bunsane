import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import {
    parseFormData,
    handleUpload,
    uploadResponse,
    uploadErrorResponse,
} from "../../../upload/RestUpload";
import { UploadManager } from "../../../upload/UploadManager";
import type { UploadResult } from "../../../types/upload.types";

function createMultipartRequest(
    files: { name: string; content: string; type: string; fieldName?: string }[],
    fields?: Record<string, string>,
): Request {
    const formData = new FormData();
    for (const f of files) {
        const file = new File([f.content], f.name, { type: f.type });
        formData.append(f.fieldName ?? "file", file);
    }
    if (fields) {
        for (const [k, v] of Object.entries(fields)) {
            formData.append(k, v);
        }
    }
    return new Request("http://localhost/upload", {
        method: "POST",
        body: formData,
    });
}

describe("parseFormData", () => {
    it("extracts files and text fields", async () => {
        const req = createMultipartRequest(
            [{ name: "photo.png", content: "imagedata", type: "image/png" }],
            { description: "My photo", tag: "avatar" },
        );

        const { files, fields } = await parseFormData(req);
        expect(files).toHaveLength(1);
        expect(files[0]!.file.name).toBe("photo.png");
        expect(files[0]!.fieldName).toBe("file");
        expect(fields["description"]).toBe("My photo");
        expect(fields["tag"]).toBe("avatar");
    });

    it("handles multiple files", async () => {
        const req = createMultipartRequest([
            { name: "a.png", content: "a", type: "image/png", fieldName: "photos" },
            { name: "b.jpg", content: "b", type: "image/jpeg", fieldName: "photos" },
        ]);

        const { files } = await parseFormData(req);
        expect(files).toHaveLength(2);
        expect(files[0]!.file.name).toBe("a.png");
        expect(files[1]!.file.name).toBe("b.jpg");
    });

    it("throws for non-multipart Content-Type", async () => {
        const req = new Request("http://localhost/upload", {
            method: "POST",
            body: JSON.stringify({ data: "test" }),
            headers: { "Content-Type": "application/json" },
        });

        await expect(parseFormData(req)).rejects.toThrow(
            "Invalid Content-Type: expected multipart/form-data",
        );
    });

    it("returns empty files array when no files in form", async () => {
        const formData = new FormData();
        formData.append("name", "test");
        const req = new Request("http://localhost/upload", {
            method: "POST",
            body: formData,
        });

        const { files, fields } = await parseFormData(req);
        expect(files).toHaveLength(0);
        expect(fields.name).toBe("test");
    });
});

describe("handleUpload", () => {
    const successResult: UploadResult = {
        success: true,
        uploadId: "uid-1",
        fileName: "test.png",
        originalFileName: "photo.png",
        mimeType: "image/png",
        size: 1024,
        path: "uploads/test.png",
        url: "/uploads/test.png",
    };

    const failResult: UploadResult = {
        success: false,
        error: {
            uploadId: "uid-2",
            code: "VALIDATION_FAILED",
            message: "File too large",
        },
    };

    let uploadFileSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        uploadFileSpy = spyOn(
            UploadManager.getInstance(),
            "uploadFile",
        ).mockResolvedValue(successResult);
        uploadFileSpy.mockClear();
    });

    it("pipes files through UploadManager", async () => {
        const req = createMultipartRequest([
            { name: "photo.png", content: "data", type: "image/png" },
        ]);

        const result = await handleUpload(req);
        expect(result.success).toBe(true);
        expect(result.totalFiles).toBe(1);
        expect(result.successCount).toBe(1);
        expect(result.failureCount).toBe(0);
        expect(result.files).toHaveLength(1);
        expect(uploadFileSpy).toHaveBeenCalledTimes(1);
    });

    it("enforces maxFiles limit", async () => {
        const req = createMultipartRequest([
            { name: "a.png", content: "a", type: "image/png" },
            { name: "b.png", content: "b", type: "image/png" },
            { name: "c.png", content: "c", type: "image/png" },
        ]);

        await expect(handleUpload(req, { maxFiles: 2 })).rejects.toThrow(
            "Too many files: received 3, maximum is 2",
        );
    });

    it("filters by fieldNames", async () => {
        const req = createMultipartRequest([
            { name: "a.png", content: "a", type: "image/png", fieldName: "avatar" },
            { name: "b.png", content: "b", type: "image/png", fieldName: "banner" },
        ]);

        const result = await handleUpload(req, { fieldNames: ["avatar"] });
        expect(result.totalFiles).toBe(1);
        expect(uploadFileSpy).toHaveBeenCalledTimes(1);
    });

    it("passes config and storageProvider to UploadManager", async () => {
        const req = createMultipartRequest([
            { name: "a.png", content: "a", type: "image/png" },
        ]);
        const config = { maxFileSize: 5_000_000 };

        await handleUpload(req, { config, storageProvider: "s3" });
        expect(uploadFileSpy).toHaveBeenCalledWith(
            expect.any(File),
            config,
            "s3",
        );
    });

    it("reports partial failures correctly", async () => {
        let callCount = 0;
        uploadFileSpy.mockImplementation(async () => {
            callCount++;
            return callCount === 1 ? successResult : failResult;
        });

        const req = createMultipartRequest([
            { name: "a.png", content: "a", type: "image/png" },
            { name: "b.png", content: "b", type: "image/png" },
        ]);

        const result = await handleUpload(req);
        expect(result.success).toBe(false);
        expect(result.successCount).toBe(1);
        expect(result.failureCount).toBe(1);
    });

    it("includes text fields in result", async () => {
        const req = createMultipartRequest(
            [{ name: "a.png", content: "a", type: "image/png" }],
            { title: "My Upload" },
        );

        const result = await handleUpload(req);
        expect(result.fields.title).toBe("My Upload");
    });
});

describe("uploadResponse", () => {
    it("returns 200 for all-success", () => {
        const result = {
            success: true,
            files: [],
            fields: {},
            totalFiles: 2,
            successCount: 2,
            failureCount: 0,
        };

        const res = uploadResponse(result);
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("application/json");
    });

    it("returns 207 for partial success", () => {
        const result = {
            success: false,
            files: [],
            fields: {},
            totalFiles: 2,
            successCount: 1,
            failureCount: 1,
        };

        const res = uploadResponse(result);
        expect(res.status).toBe(207);
    });

    it("returns 400 when all failed", () => {
        const result = {
            success: false,
            files: [],
            fields: {},
            totalFiles: 2,
            successCount: 0,
            failureCount: 2,
        };

        const res = uploadResponse(result);
        expect(res.status).toBe(400);
    });
});

describe("uploadErrorResponse", () => {
    it("returns error JSON with default status", async () => {
        const res = uploadErrorResponse(new Error("Bad file"));
        expect(res.status).toBe(400);

        const body = await res.json();
        expect(body.error).toBe("Bad file");
        expect(body.code).toBe("UPLOAD_FAILED");
    });

    it("uses custom code and status", async () => {
        const res = uploadErrorResponse(
            new Error("Too big"),
            "FILE_TOO_LARGE",
            413,
        );
        expect(res.status).toBe(413);

        const body = await res.json();
        expect(body.code).toBe("FILE_TOO_LARGE");
    });

    it("handles non-Error values", async () => {
        const res = uploadErrorResponse("something went wrong");
        const body = await res.json();
        expect(body.error).toBe("Unknown upload error");
    });
});
