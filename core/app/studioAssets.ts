import { existsSync } from "fs";
import * as path from "path";

/** Dist is present only when index.html exists. Bun.file() is truthy for missing paths. */
export function resolveStudioDist(distDir: string): string | null {
    if (!distDir) return null;
    const indexPath = path.join(distDir, "index.html");
    return existsSync(indexPath) ? distDir : null;
}

export function defaultStudioDistDir(): string {
    return path.join(import.meta.dirname, "..", "..", "studio", "dist");
}
