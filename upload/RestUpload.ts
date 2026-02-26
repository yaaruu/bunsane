import { UploadManager } from "./UploadManager";
import type {
    UploadConfiguration,
    UploadResult,
    UploadErrorCode,
} from "../types/upload.types";
import { logger as MainLogger } from "../core/Logger";

const logger = MainLogger.child({ scope: "RestUpload" });

export interface ParsedUpload {
    file: File;
    fieldName: string;
}

export interface RestUploadOptions {
    config?: Partial<UploadConfiguration>;
    storageProvider?: string;
    maxFiles?: number;
    fieldNames?: string[];
}

export interface RestUploadResult {
    success: boolean;
    files: UploadResult[];
    fields: Record<string, string>;
    totalFiles: number;
    successCount: number;
    failureCount: number;
}

export async function parseFormData(
    req: Request,
): Promise<{ files: ParsedUpload[]; fields: Record<string, string> }> {
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
        throw new Error(
            "Invalid Content-Type: expected multipart/form-data",
        );
    }

    const formData = await req.formData();
    const files: ParsedUpload[] = [];
    const fields: Record<string, string> = {};

    for (const [key, value] of formData.entries()) {
        if (typeof value !== "string") {
            files.push({ file: value as File, fieldName: key });
        } else {
            fields[key] = value;
        }
    }

    return { files, fields };
}

export async function handleUpload(
    req: Request,
    options: RestUploadOptions = {},
): Promise<RestUploadResult> {
    const { config, storageProvider, maxFiles, fieldNames } = options;

    logger.info("Processing REST upload");

    const { files: parsed, fields } = await parseFormData(req);

    const filtered = fieldNames
        ? parsed.filter((p) => fieldNames.includes(p.fieldName))
        : parsed;

    if (maxFiles !== undefined && filtered.length > maxFiles) {
        throw new Error(
            `Too many files: received ${filtered.length}, maximum is ${maxFiles}`,
        );
    }

    const manager = UploadManager.getInstance();
    const results: UploadResult[] = await Promise.all(
        filtered.map((p) =>
            manager.uploadFile(p.file, config, storageProvider),
        ),
    );

    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.length - successCount;

    logger.info(
        `REST upload complete: ${successCount} succeeded, ${failureCount} failed`,
    );

    return {
        success: failureCount === 0,
        files: results,
        fields,
        totalFiles: results.length,
        successCount,
        failureCount,
    };
}

export function uploadResponse(result: RestUploadResult): Response {
    const status =
        result.failureCount > 0 && result.successCount > 0
            ? 207
            : result.failureCount > 0
              ? 400
              : 200;

    return new Response(JSON.stringify(result), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

export function uploadErrorResponse(
    error: unknown,
    code: UploadErrorCode = "UPLOAD_FAILED",
    status: number = 400,
): Response {
    const message =
        error instanceof Error ? error.message : "Unknown upload error";

    return new Response(
        JSON.stringify({ error: message, code }),
        {
            status,
            headers: { "Content-Type": "application/json" },
        },
    );
}
