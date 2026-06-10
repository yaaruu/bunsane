import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { UploadManager } from "../../../upload/UploadManager";
import { LocalStorageProvider } from "../../../storage/LocalStorageProvider";
import type { StorageResult } from "../../../types/upload.types";

/**
 * BUNSANE-007 — registering a custom provider under the default "local" key
 * immediately after getInstance() must NOT be clobbered by the default provider.
 *
 * Pre-fix: the constructor's async initializeDefaultProviders() suspended on
 * `await localProvider.initialize()`, registering the default "local" provider
 * in a LATER microtask — after the consumer's synchronous override — so the
 * default `./public` provider always won.
 */
describe("UploadManager — default provider registration race (BUNSANE-007)", () => {
    beforeEach(() => {
        // Singleton persists across tests; reset for a clean construction.
        (UploadManager as any).instance = undefined;
    });

    function pngFile(): File {
        // Valid PNG magic bytes so default-config signature validation passes.
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
        return new File([bytes], "test.png", { type: "image/png" });
    }

    it("keeps a custom 'local' provider registered immediately after getInstance()", () => {
        const manager = UploadManager.getInstance();
        const custom = new LocalStorageProvider({ basePath: "/tmp/bunsane-custom-root" });
        manager.registerStorageProvider("local", custom);

        // Override must win synchronously — no deferred default registration.
        expect(manager.getStorageProvider("local")).toBe(custom);
    });

    it("uploads through the custom 'local' provider, not the default ./public one", async () => {
        const manager = UploadManager.getInstance();

        const custom = new LocalStorageProvider({ basePath: "/tmp/bunsane-custom-root" });
        const storeSpy = spyOn(custom, "store").mockResolvedValue({
            path: "uploads/test.png",
            url: "/uploads/test.png",
            metadata: {},
        } as StorageResult);

        manager.registerStorageProvider("local", custom);

        const result = await manager.uploadFile(pngFile(), {
            // Keep the test focused on provider selection, not validation rules.
            validateFileSignature: false,
            allowedMimeTypes: [],
            allowedExtensions: [],
        });

        expect(result.success).toBe(true);
        expect(storeSpy).toHaveBeenCalledTimes(1);
        // The provider the file was stored through is the consumer's, by identity.
        expect(manager.getStorageProvider("local")).toBe(custom);
    });
});
