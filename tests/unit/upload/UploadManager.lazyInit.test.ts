/**
 * Importing the package must not register the local storage provider or log
 * "Registering storage provider: local". Registration waits for validate,
 * store, or getProvider. A custom "local" registered immediately after
 * getInstance() must still win (BUNSANE-007).
 */
import { describe, expect, test, beforeEach, spyOn } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { UploadManager } from "../../../upload/UploadManager";
import { LocalStorageProvider } from "../../../storage/LocalStorageProvider";

const repoRoot = path.resolve(import.meta.dir, "../../..");

function resetManager(): void {
    Reflect.set(UploadManager, "instance", undefined);
}

function registeredNames(manager: UploadManager): string[] {
    const map = Reflect.get(manager, "storageProviders") as Map<string, unknown>;
    return [...map.keys()];
}

function runImportProbe(): Promise<{ code: number; stdout: string; stderr: string }> {
    // Child process on purpose: a static import here would run under the test
    // preload, and the assertion is that evaluating the barrel itself does not
    // register a provider or log.
    const script = `
        const barrel = await import("./index.ts");
        const mgr = barrel.UploadManager.getInstance();
        const names = [...mgr.storageProviders.keys()];
        if (names.length !== 0) {
            console.error("REGISTERED " + names.join(","));
            process.exit(2);
        }
        console.log("OK");
    `;
    const { promise, resolve, reject } = Promise.withResolvers<{
        code: number;
        stdout: string;
        stderr: string;
    }>();
    const child = spawn(process.execPath, ["-e", script], {
        cwd: repoRoot,
        env: {
            ...process.env,
            LOG_LEVEL: "info",
            LOG_PRETTY: "false",
        },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
        resolve({ code: code ?? 1, stdout, stderr });
    });
    return promise;
}

describe("UploadManager lazy registration", () => {
    beforeEach(() => {
        resetManager();
    });

    test("importing the root barrel does not log or register a provider", async () => {
        const result = await runImportProbe();
        const combined = result.stdout + result.stderr;
        expect(combined).not.toContain("Registering storage provider");
        if (result.code !== 0) {
            throw new Error(
                `import probe exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
            );
        }
        expect(result.stdout.trim()).toBe("OK");
        expect(result.stderr).toBe("");
    }, 20_000);

    test("getInstance does not register; getStorageProvider does", () => {
        const manager = UploadManager.getInstance();
        expect(registeredNames(manager)).toEqual([]);
        const provider = manager.getStorageProvider();
        expect(provider).toBeInstanceOf(LocalStorageProvider);
        expect(registeredNames(manager)).toEqual(["local"]);
        expect(manager.getStorageProvider("local")).toBe(provider);
    });

    test("a custom local provider registered before first use is not clobbered", () => {
        const manager = UploadManager.getInstance();
        const custom = new LocalStorageProvider({ basePath: "/tmp/bunsane-lazy-custom" });
        manager.registerStorageProvider("local", custom);
        expect(manager.getStorageProvider("local")).toBe(custom);
        expect(registeredNames(manager)).toEqual(["local"]);
    });

    test("validateOnly is a real use and registers the default provider", async () => {
        const manager = UploadManager.getInstance();
        expect(registeredNames(manager)).toEqual([]);
        const file = new File([new Uint8Array([1, 2, 3])], "a.txt", { type: "text/plain" });
        const result = await manager.validateOnly(file, {
            allowedMimeTypes: [],
            allowedExtensions: [],
            validateFileSignature: false,
        });
        expect(result.valid).toBe(true);
        expect(registeredNames(manager)).toEqual(["local"]);
    });

    test("uploadFile registers the default provider before store", async () => {
        const store = spyOn(LocalStorageProvider.prototype, "store").mockResolvedValue({
            path: "uploads/a.txt",
            url: "/uploads/a.txt",
            metadata: {},
        });
        const manager = UploadManager.getInstance();
        expect(registeredNames(manager)).toEqual([]);
        const file = new File([new Uint8Array([1, 2, 3])], "a.txt", { type: "text/plain" });
        const result = await manager.uploadFile(file, {
            allowedMimeTypes: [],
            allowedExtensions: [],
            validateFileSignature: false,
        });
        expect(result.success).toBe(true);
        expect(store).toHaveBeenCalledTimes(1);
        expect(registeredNames(manager)).toEqual(["local"]);
        store.mockRestore();
    });
});
