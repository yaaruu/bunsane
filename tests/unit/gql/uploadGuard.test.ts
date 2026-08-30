/**
 * SEC-06: GraphQL upload guard.
 *
 * The old implementation validated only when `args[i] instanceof File` inside
 * an @UploadField wrapper — batch arrays, nested inputs and @Upload-without-
 * @UploadField all bypassed every size/type check. These pin the shared guard.
 */
import { describe, test, expect } from 'bun:test';
import 'reflect-metadata';
import { collectFiles, wrapUploadValidation, isUploadWrapped } from '../../../gql/uploadGuard';
import { UPLOAD_CONFIG_KEY } from '../../../gql/decorators/Upload';
import { ResolverBuilder } from '../../../gql/builders/ResolverBuilder';

function makeFile(name: string, bytes: number, type = 'image/png'): File {
    // Real PNG signature — FileValidator checks magic bytes vs declared MIME.
    const head = type === 'image/png' ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] : [];
    const body = new Uint8Array(Math.max(bytes, head.length));
    body.set(head, 0);
    return new File([body], name, { type });
}

/**
 * Mimic decorator application: metadata, then wrap AND WRITE THE DESCRIPTOR
 * BACK (a bare descriptor mutation is invisible to the prototype).
 */
function applyUploadGuard(
    target: any,
    key: string,
    paramIndex: number,
    config: Record<string, unknown>,
): void {
    Reflect.defineMetadata(UPLOAD_CONFIG_KEY, { [paramIndex]: config }, target, key);
    const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
    wrapUploadValidation(target, key, descriptor);
    Object.defineProperty(target, key, descriptor);
}

describe('collectFiles', () => {
    test('finds files in arrays', () => {
        const files = [makeFile('a.png', 5), makeFile('b.png', 5)];
        expect(collectFiles(files)).toHaveLength(2);
    });

    test('finds nested input files', () => {
        const input = { meta: { doc: makeFile('d.pdf', 5, 'application/pdf') }, count: 1 };
        expect(collectFiles(input)).toHaveLength(1);
    });

    test('ignores plain values and non-plain objects', () => {
        expect(collectFiles({ a: 1, b: 'x', c: null })).toHaveLength(0);
        class Service { }
        expect(collectFiles({ svc: new Service() })).toHaveLength(0);
    });

    test('depth cap prevents runaway walks', () => {
        let deep: any = makeFile('deep.png', 1);
        for (let i = 0; i < 10; i++) deep = { w: deep };
        // MAX_SWEEP_DEPTH is 4 — the file sits deeper than that.
        expect(collectFiles(deep)).toHaveLength(0);
    });
});

class GuardedService {
    /** Configured scalar param: 10-byte cap. */
    uploadOne(file: File) {
        // After the guard, `file` is the UploadResult, not the raw File —
        // that replacement is part of the legacy contract being preserved.
        return { ok: true, receivedName: (file as any).originalFileName ?? file.name };
    }

    /** Batch param. */
    uploadMany(files: File[]) { return files.length; }
}

applyUploadGuard(GuardedService.prototype, 'uploadOne', 0, {
    field: 'file',
    maxFileSize: 64,
    allowedMimeTypes: ['image/png'],
});
applyUploadGuard(GuardedService.prototype, 'uploadMany', 0, {
    field: 'files',
    maxFileSize: 64,
});

describe('wrapUploadValidation', () => {
    test('valid configured upload is stored and replaced with the result', async () => {
        const svc = new GuardedService();
        const result = await (svc as any).uploadOne(makeFile('ok.png', 32));
        expect(result.ok).toBe(true);
        // Replacement proof: the service received the UploadResult.
        expect(result.receivedName).toBe('ok.png');
    });

    test('oversized configured upload is rejected with details', async () => {
        const svc = new GuardedService();
        await expect(
            (svc as any).uploadOne(makeFile('big.png', 512))
        ).rejects.toThrow(/Upload failed|exceeds maximum/i);
    });

    test('batch File[] entries are each processed', async () => {
        const svc = new GuardedService();
        const n = await (svc as any).uploadMany([
            makeFile('b1.png', 16),
            makeFile('b2.png', 16),
        ]);
        expect(n).toBe(2);
    });

    test('batch with one bad entry rejects the whole batch', async () => {
        const svc = new GuardedService();
        await expect(
            (svc as any).uploadMany([
                makeFile('good.png', 16),
                makeFile('bad.png', 4096),
            ])
        ).rejects.toThrow();
    });

    test('required config enforces presence', async () => {
        const tmp = { uploadOneTmp(file?: File) { return 'x'; } };
        applyUploadGuard(tmp, 'uploadOneTmp', 0, { field: 'f', required: true });
        await expect((tmp as any).uploadOneTmp(undefined)).rejects.toThrow(/Required upload/);
    });

    // SEC-06 (identity-based Pass 2): a File smuggled INSIDE a configured object
    // param was skipped by the old index-based Pass 2 (that index counted as
    // "configured", and Pass 1 never descends into the object). The sweep now
    // skips by File identity, so this reaches validation.
    test('oversized file nested inside a configured object param is still rejected', async () => {
        const tmp = { uploadInput(_input: { avatar: File }) { return 'ran'; } };
        applyUploadGuard(tmp, 'uploadInput', 0, { field: 'input', maxFileSize: 64 });
        await expect(
            (tmp as any).uploadInput({ avatar: makeFile('huge.bin', 999_999_999, 'application/octet-stream') })
        ).rejects.toThrow();
    });

    test('small file nested inside a configured object param passes', async () => {
        const tmp = { uploadInput2(_input: { avatar: File }) { return 'ran'; } };
        applyUploadGuard(tmp, 'uploadInput2', 0, { field: 'input', maxFileSize: 64 });
        const r = await (tmp as any).uploadInput2({ avatar: makeFile('tiny.png', 32) });
        expect(r).toBe('ran');
    });
});

describe('isUploadWrapped', () => {
    test('detects wrapped vs plain methods', () => {
        expect(isUploadWrapped(GuardedService.prototype.uploadOne)).toBe(true);
        expect(isUploadWrapped((x: unknown) => x)).toBe(false);
        expect(isUploadWrapped(undefined)).toBe(false);
        expect(isUploadWrapped(null)).toBe(false);
    });
});

describe('ResolverBuilder safety net', () => {
    test('nested unconfigured file is validate-only checked before the service runs', async () => {
        const rb = new ResolverBuilder();
        let serviceCalled = false;
        rb.addResolver({
            name: 'up',
            type: 'Mutation',
            service: {
                up: async (input: any) => { serviceCalled = true; return input; },
            },
            propertyKey: 'up',
            hasInput: true,
        });

        const resolver = rb.getResolvers().Mutation!['up']!;
        // The resolver wraps the raw rejection as "Internal error" (with the
        // original attached in extensions outside production).
        await expect(
            resolver(null, { input: { attachment: makeFile('huge.bin', 999_999_999, 'application/octet-stream') } }, {}, {})
        ).rejects.toThrow(/Internal error/);
        expect(serviceCalled).toBe(false);
    });

    test('small nested file passes the net untouched (validate-only, no storage)', async () => {
        const rb = new ResolverBuilder();
        let received: any = null;
        rb.addResolver({
            name: 'up2',
            type: 'Mutation',
            service: {
                up2: async (input: any) => { received = input; return 'done'; },
            },
            propertyKey: 'up2',
            hasInput: true,
        });

        const resolver = rb.getResolvers().Mutation!['up2']!;
        const result = await resolver(null, { input: { f: makeFile('tiny.png', 32) } }, {}, {});
        expect(result).toBe('done');
        // Resolver passes the INNER input object to the service.
        expect(received.f).toBeInstanceOf(File);
    });
});


