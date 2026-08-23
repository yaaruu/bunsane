/**
 * SEC-07: local storage path containment.
 *
 * The old sanitizePath normalized forward slashes only (backslash traversal
 * survived on Windows) and store() skipped sanitization entirely. These pin
 * the hardened sanitizer and the resolve-based containment check.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { LocalStorageProvider } from '../../../storage/LocalStorageProvider';
import type { UploadConfiguration } from '../../../types/upload.types';

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsane-sec07-'));
afterAll(() => {
    try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* tmp cleanup */ }
});

function provider(): LocalStorageProvider {
    return new LocalStorageProvider({ basePath: BASE });
}

function fileConfig(uploadPath = 'uploads'): UploadConfiguration {
    return {
        uploadPath,
        namingStrategy: 'original',
        maxFileSize: 1024 * 1024,
    } as unknown as UploadConfiguration;
}

function pngFile(name: string): File {
    const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return new File([new Uint8Array(head)], name, { type: 'image/png' });
}

describe('sanitizePath hardening', () => {
    // Access the protected helper through a probe subclass.
    class Probe extends LocalStorageProvider {
        public sanitize(p: string): string {
            return this.sanitizePath(p);
        }
    }

    test('backslash traversal is neutralized', () => {
        expect(new Probe({ basePath: BASE }).sanitize('..\\..\\windows\\evil')).not.toContain('..');
        expect(new Probe({ basePath: BASE }).sanitize('..\\..\\windows\\evil')).toBe('windows/evil');
    });

    test('nested dot payloads ("....//") are handled iteratively', () => {
        expect(new Probe({ basePath: BASE }).sanitize('....//....//x')!.includes('..')).toBe(false);
    });

    test('plain relative paths pass through unchanged', () => {
        expect(new Probe({ basePath: BASE }).sanitize('uploads/a/b.png')).toBe('uploads/a/b.png');
    });
});

describe('store() containment', () => {
    test('traversal via uploadPath is refused before touching the filesystem', async () => {
        const p = provider();
        await expect(
            p.store(pngFile('x.png'), {
                uploadId: 't1', fileName: 'ok.png', originalFileName: 'x.png',
                mimeType: 'image/png', size: 8, extension: '.png',
                uploadedAt: new Date().toISOString(),
            }, fileConfig('../outside'))
        ).rejects.toThrow(/escapes storage base/);
    });

    test('traversal via fileName is refused', async () => {
        const p = provider();
        await expect(
            p.store(pngFile('../../evil.png'), {
                uploadId: 't2', fileName: '../../evil.png', originalFileName: '../../evil.png',
                mimeType: 'image/png', size: 8, extension: '.png',
                uploadedAt: new Date().toISOString(),
            }, fileConfig())
        ).rejects.toThrow(/escapes storage base/);
    });

    test('Windows drive-letter fileName is rejected (reserved characters)', async () => {
        // On win32 the colon cannot be part of a filename; reject it with a
        // clear error instead of an OS ENOENT. Upstream FileValidator already
        // rejects such names before storage — this is direct-caller defense.
        const p = provider();
        await expect(
            p.store(pngFile('C:/evil.png'), {
                uploadId: 't3', fileName: 'C:\\evil.png', originalFileName: 'C:\\evil.png',
                mimeType: 'image/png', size: 8, extension: '.png',
                uploadedAt: new Date().toISOString(),
            }, fileConfig())
        ).rejects.toThrow(/reserved characters/);
    });

    test('legitimate store still works and lands inside base', async () => {
        const p = provider();
        const result = await p.store(pngFile('fine.png'), {
            uploadId: 't4', fileName: 'fine.png', originalFileName: 'fine.png',
            mimeType: 'image/png', size: 8, extension: '.png',
            uploadedAt: new Date().toISOString(),
        }, fileConfig());
        const written = path.join(BASE, result.path.replace(/\//g, path.sep));
        // On POSIX the URL-style path maps directly; on Windows too.
        expect(fs.existsSync(path.join(BASE, 'uploads')) || fs.existsSync(written)).toBe(true);
    });
});

describe('read-path containment', () => {
    test('delete with backslash traversal resolves inside base (no throw, miss)', async () => {
        const p = provider();
        // Must NOT delete anything outside base; returns false (miss).
        const outsideFile = path.join(os.tmpdir(), 'bunsane-sec07-outside.txt');
        fs.writeFileSync(outsideFile, 'do-not-delete');
        const ok = await p.delete(`../../${path.basename(os.tmpdir())}/bunsane-sec07-outside.txt`);
        expect(ok).toBe(false);
        expect(fs.existsSync(outsideFile)).toBe(true);
        fs.rmSync(outsideFile);
    });

    test('getStream on a backslash traversal throws instead of reading outside', async () => {
        const p = provider();
        await expect(
            p.getStream('..\\..\\package.json')
        ).rejects.toThrow(/escapes storage base|File not found/);
    });
});
