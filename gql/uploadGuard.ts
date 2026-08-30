/**
 * SEC-06: shared upload-validation guard for GraphQL resolvers.
 *
 * Before this module, validation only ran inside @UploadField's method
 * wrapper and only when `args[i] instanceof File` was true at the top level.
 * Three bypasses fell out of that:
 *
 *  1. `@Upload` without `@UploadField` — metadata recorded, nothing enforced.
 *  2. Batch uploads (`File[]`) — an array fails `instanceof File`.
 *  3. Files nested in input objects — never looked at.
 *
 * The guard below is applied by BOTH decorators (idempotently) and sweeps the
 * whole argument graph, so every File that reaches a service method has
 * passed FileValidator under the operation's config.
 */
import "reflect-metadata";
import { logger as MainLogger } from "../core/Logger";
import { UploadManager } from "../upload";
import type { UploadDecoratorConfig } from "../types/upload.types";

const logger = MainLogger.child({ scope: "UploadGuard" });

export const UPLOAD_CONFIG_KEY = Symbol("upload:config");
/** Marks an already-wrapped method so stacked decorators don't double-wrap. */
const WRAPPED_KEY = Symbol("upload:wrapped");

/** Max depth when sweeping arguments for stray Files. */
const MAX_SWEEP_DEPTH = 4;

function isFile(value: unknown): value is File {
    return typeof File !== "undefined" && value instanceof File;
}

function looksLikeFile(value: unknown): value is File {
    // Cross-realm / bundled-File tolerance: duck-type as a fallback.
    return (
        isFile(value) ||
        (typeof value === "object" &&
            value !== null &&
            typeof (value as any).stream === "function" &&
            typeof (value as any).name === "string" &&
            typeof (value as any).size === "number")
    );
}

/**
 * Collect every File reachable from `value` through plain objects/arrays,
 * up to MAX_SWEEP_DEPTH. Does not descend into class instances other than
 * File itself (services, dates, maps stay untouched).
 */
export function collectFiles(value: unknown, depth: number = 0): File[] {
    if (depth > MAX_SWEEP_DEPTH) return [];
    if (looksLikeFile(value)) return [value];
    if (Array.isArray(value)) {
        const out: File[] = [];
        for (const item of value) out.push(...collectFiles(item, depth + 1));
        return out;
    }
    if (typeof value === "object" && value !== null) {
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) return [];
        const out: File[] = [];
        for (const key of Object.keys(value)) {
            out.push(...collectFiles((value as any)[key], depth + 1));
        }
        return out;
    }
    return [];
}

async function validateOnly(file: File, config?: Partial<UploadDecoratorConfig>): Promise<void> {
    const result = await UploadManager.getInstance().validateOnly(file, config as any);
    if (!result.valid) {
        throw new Error(
            `Upload rejected for '${file.name}': ${result.errors.join(", ")}`
        );
    }
}

/**
 * Resolver-level safety net (SEC-06): validate-only sweep over every argument
 * of a resolver invocation. Applied by ResolverBuilder to Query/Mutation
 * resolvers so files that reach the service through ANY path — including
 * methods with no upload decorators at all — have passed validation.
 */
export async function sweepValidateArgs(args: unknown[]): Promise<void> {
    for (const arg of args) {
        const files = collectFiles(arg);
        for (const file of files) {
            logger.trace(`Sweep-validating unconfigured upload: ${file.name}`);
            await validateOnly(file);
        }
    }
}

/**
 * Wrap a service method so that:
 *  - configured parameter positions are processed exactly like the legacy
 *    @UploadField wrapper did (validate + store + replace with the result),
 *    now including File[] batches;
 *  - every OTHER File found anywhere in the arguments is validate-only
 *    checked against the merged defaults, closing bypasses 1–3 above.
 */
export function wrapUploadValidation(
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
): PropertyDescriptor {
    const original = descriptor.value;
    if ((original as any)?.[WRAPPED_KEY]) return descriptor;

    const wrapped = async function (this: any, ...args: any[]) {
        const uploadManager = UploadManager.getInstance();
        const uploadMetadata: Record<string, any> =
            Reflect.getMetadata(UPLOAD_CONFIG_KEY, target, propertyKey) ?? {};

        // Files that Pass 1 actually stored under a per-param config. Pass 2
        // skips these by IDENTITY, not by parameter index — an index-based skip
        // waves through a File nested INSIDE a configured object param (e.g.
        // `@Upload() input: { avatar: File }`, where Pass 1 sees a non-File
        // object and consumes nothing), leaving that File unvalidated.
        const consumed = new WeakSet<object>();

        // Pass 1 — configured positions: validate + store + replace (legacy
        // semantics, extended to arrays).
        for (const [paramIndexRaw, rawConfig] of Object.entries(uploadMetadata)) {
            const paramIdx = parseInt(paramIndexRaw);
            const config = rawConfig as any;
            const slot = args[paramIdx];

            if (Array.isArray(slot)) {
                const processed: unknown[] = [];
                let sawFile = false;
                for (const entry of slot) {
                    if (looksLikeFile(entry)) {
                        sawFile = true;
                        consumed.add(entry);
                        const result = await uploadManager.uploadFile(entry, config);
                        if (!result.success) {
                            throw new Error(
                                config.validationMessage ||
                                result.error?.message ||
                                "Upload failed"
                            );
                        }
                        processed.push(result);
                    } else {
                        processed.push(entry);
                    }
                }
                if (sawFile) args[paramIdx] = processed;
                else if (config.required) {
                    throw new Error(`Required upload file missing for parameter ${paramIdx}`);
                }
                continue;
            }

            if (looksLikeFile(slot)) {
                logger.info(`Processing upload for parameter ${paramIdx} in ${target.constructor?.name}.${propertyKey}`);
                consumed.add(slot);
                const result = await uploadManager.uploadFile(slot, config);
                if (!result.success) {
                    throw new Error(
                        config.validationMessage ||
                        result.error?.message ||
                        "Upload failed"
                    );
                }
                args[paramIdx] = result;
                continue;
            }

            if (config.required) {
                throw new Error(`Required upload file missing for parameter ${paramIdx}`);
            }
        }

        // Pass 2 — sweep EVERY argument (including configured indices, whose
        // nested Files Pass 1 does not reach) and validate-only any File that
        // Pass 1 did not already store. Skipping by identity, so a File stored
        // under its own permissive config is not re-checked against the global
        // defaults, while a File smuggled inside a configured object param is.
        for (let i = 0; i < args.length; i++) {
            const files = collectFiles(args[i]);
            for (const file of files) {
                if (consumed.has(file)) continue;
                await validateOnly(file);
            }
        }

        return original.apply(this, args);
    };

    (wrapped as any)[WRAPPED_KEY] = true;
    descriptor.value = wrapped;
    return descriptor;
}

/**
 * True when `fn` is a method already wrapped by `wrapUploadValidation` (i.e. it
 * carries an @Upload / @UploadField decorator). The resolver-level sweep uses
 * this to skip methods the wrapper already covers completely — running both
 * would re-validate a configured file against the GLOBAL defaults and falsely
 * reject an upload the method's own (more permissive) config allows. (SEC-06)
 */
export function isUploadWrapped(fn: unknown): boolean {
    return typeof fn === "function" && (fn as any)[WRAPPED_KEY] === true;
}
