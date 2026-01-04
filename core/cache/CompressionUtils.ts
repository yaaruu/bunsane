import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Compression utilities for cache payloads. Automatically compresses data
 * over 1KB threshold to reduce memory usage and network transfer for Redis.
 *
 * Features:
 * - Gzip compression for payloads > 1KB
 * - Automatic compression/decompression
 * - Metadata tracking for compressed data
 * - Error handling with fallback to uncompressed data
 */
export class CompressionUtils {
  private static readonly COMPRESSION_THRESHOLD = 1024; // 1KB
  private static readonly COMPRESSION_PREFIX = '__COMPRESSED__';

  /**
   * Compresses data if it exceeds the threshold size
   */
  static async compress(data: any): Promise<any> {
    try {
      const serialized = JSON.stringify(data);
      const size = Buffer.byteLength(serialized, 'utf8');

      if (size <= this.COMPRESSION_THRESHOLD) {
        return data; // No compression needed
      }

      const compressed = await gzipAsync(serialized);
      const compressedData = compressed.toString('base64');

      // Return compressed data with metadata
      return {
        [this.COMPRESSION_PREFIX]: true,
        data: compressedData,
        originalSize: size,
        compressedSize: compressed.length
      };
    } catch (error) {
      // Fallback to uncompressed data on compression error
      console.warn('Compression failed, using uncompressed data:', error);
      return data;
    }
  }

  /**
   * Decompresses data if it was previously compressed
   */
  static async decompress(data: any): Promise<any> {
    try {
      // Check if data is compressed
      if (typeof data === 'object' && data !== null && data[this.COMPRESSION_PREFIX]) {
        const compressedBuffer = Buffer.from(data.data, 'base64');
        const decompressed = await gunzipAsync(compressedBuffer);
        return JSON.parse(decompressed.toString('utf8'));
      }

      // Data is not compressed
      return data;
    } catch (error) {
      // Fallback to original data on decompression error
      console.warn('Decompression failed, using original data:', error);
      return data;
    }
  }

  /**
   * Checks if data is compressed
   */
  static isCompressed(data: any): boolean {
    return typeof data === 'object' && data !== null && data[this.COMPRESSION_PREFIX] === true;
  }

  /**
   * Gets compression statistics for monitoring
   */
  static getCompressionStats(data: any): { compressed: boolean; originalSize?: number; compressedSize?: number; ratio?: number } {
    if (this.isCompressed(data)) {
      const originalSize = data.originalSize;
      const compressedSize = data.compressedSize;
      const ratio = originalSize > 0 ? compressedSize / originalSize : 0;

      return {
        compressed: true,
        originalSize,
        compressedSize,
        ratio
      };
    }

    return { compressed: false };
  }

  /**
   * Estimates if data would benefit from compression
   */
  static shouldCompress(data: any): boolean {
    try {
      const serialized = JSON.stringify(data);
      const size = Buffer.byteLength(serialized, 'utf8');
      return size > this.COMPRESSION_THRESHOLD;
    } catch {
      return false;
    }
  }
}