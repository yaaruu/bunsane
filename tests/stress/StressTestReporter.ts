/**
 * Report generator for stress test results
 */
import type { BenchmarkResult, ConcurrentResult } from './BenchmarkRunner';

export interface ReportMetadata {
    recordCount: number;
    environment: string;
    duration?: number;
}

export class StressTestReporter {
    generateReport(
        results: BenchmarkResult[],
        metadata: ReportMetadata
    ): string {
        const lines: string[] = [];

        lines.push('='.repeat(70));
        lines.push('              BunSane Stress Test Report');
        lines.push('='.repeat(70));
        lines.push(`Date: ${new Date().toISOString()}`);
        lines.push(`Records: ${metadata.recordCount.toLocaleString()}`);
        lines.push(`Environment: ${metadata.environment}`);
        if (metadata.duration) {
            lines.push(`Duration: ${(metadata.duration / 1000).toFixed(1)}s`);
        }
        lines.push('');
        lines.push('Query Performance:');
        lines.push('-'.repeat(70));
        lines.push(
            this.padRight('Query', 35) +
            this.padLeft('p50', 10) +
            this.padLeft('p95', 10) +
            this.padLeft('QPS', 8) +
            this.padLeft('Status', 7)
        );
        lines.push('-'.repeat(70));

        for (const result of results) {
            const status = result.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
            lines.push(
                this.padRight(this.truncate(result.name, 34), 35) +
                this.padLeft(`${result.timings.median.toFixed(1)}ms`, 10) +
                this.padLeft(`${result.timings.p95.toFixed(1)}ms`, 10) +
                this.padLeft(`${result.queriesPerSecond.toFixed(0)}`, 8) +
                this.padLeft(status, 7)
            );
        }

        lines.push('-'.repeat(70));
        lines.push('');

        // Summary
        const passed = results.filter(r => r.passed).length;
        const failed = results.filter(r => !r.passed).length;

        lines.push(`Summary: ${passed} passed, ${failed} failed`);

        if (failed > 0) {
            lines.push('');
            lines.push('Failed benchmarks:');
            for (const result of results.filter(r => !r.passed)) {
                lines.push(
                    `  - ${result.name}: p95=${result.timings.p95.toFixed(1)}ms ` +
                    `(target: ${result.target}ms)`
                );
            }
        }

        // Recommendations based on results
        const recommendations = this.generateRecommendations(results);
        if (recommendations.length > 0) {
            lines.push('');
            lines.push('Recommendations:');
            for (const rec of recommendations) {
                lines.push(`  - ${rec}`);
            }
        }

        return lines.join('\n');
    }

    generateConcurrentReport(
        results: ConcurrentResult[],
        metadata: ReportMetadata
    ): string {
        const lines: string[] = [];

        lines.push('='.repeat(70));
        lines.push('          BunSane Concurrent Load Test Report');
        lines.push('='.repeat(70));
        lines.push(`Date: ${new Date().toISOString()}`);
        lines.push(`Records: ${metadata.recordCount.toLocaleString()}`);
        lines.push(`Environment: ${metadata.environment}`);
        lines.push('');
        lines.push('Concurrent Performance:');
        lines.push('-'.repeat(70));
        lines.push(
            this.padRight('Query', 25) +
            this.padLeft('Concurrency', 12) +
            this.padLeft('QPS', 10) +
            this.padLeft('Avg Latency', 12) +
            this.padLeft('Errors', 8)
        );
        lines.push('-'.repeat(70));

        for (const result of results) {
            lines.push(
                this.padRight(this.truncate(result.name, 24), 25) +
                this.padLeft(`${result.concurrency}`, 12) +
                this.padLeft(`${result.queriesPerSecond.toFixed(0)}`, 10) +
                this.padLeft(`${result.avgLatency.toFixed(1)}ms`, 12) +
                this.padLeft(`${(result.errorRate * 100).toFixed(1)}%`, 8)
            );
        }

        lines.push('-'.repeat(70));

        return lines.join('\n');
    }

    generateMarkdownReport(
        results: BenchmarkResult[],
        metadata: ReportMetadata
    ): string {
        const lines: string[] = [];

        lines.push('# BunSane Stress Test Report');
        lines.push('');
        lines.push(`**Date:** ${new Date().toISOString()}`);
        lines.push(`**Records:** ${metadata.recordCount.toLocaleString()}`);
        lines.push(`**Environment:** ${metadata.environment}`);
        lines.push('');
        lines.push('## Query Performance');
        lines.push('');
        lines.push('| Query | p50 | p95 | p99 | QPS | Status |');
        lines.push('|-------|-----|-----|-----|-----|--------|');

        for (const result of results) {
            const status = result.passed ? 'PASS' : 'FAIL';
            lines.push(
                `| ${result.name} | ` +
                `${result.timings.median.toFixed(1)}ms | ` +
                `${result.timings.p95.toFixed(1)}ms | ` +
                `${result.timings.p99.toFixed(1)}ms | ` +
                `${result.queriesPerSecond.toFixed(0)} | ` +
                `${status} |`
            );
        }

        lines.push('');

        // Summary
        const passed = results.filter(r => r.passed).length;
        const failed = results.filter(r => !r.passed).length;

        lines.push('## Summary');
        lines.push('');
        lines.push(`- **Passed:** ${passed}`);
        lines.push(`- **Failed:** ${failed}`);
        lines.push(`- **Total:** ${results.length}`);

        if (failed > 0) {
            lines.push('');
            lines.push('### Failed Benchmarks');
            lines.push('');
            for (const result of results.filter(r => !r.passed)) {
                lines.push(
                    `- **${result.name}**: p95=${result.timings.p95.toFixed(1)}ms ` +
                    `(target: ${result.target}ms)`
                );
            }
        }

        return lines.join('\n');
    }

    private generateRecommendations(results: BenchmarkResult[]): string[] {
        const recommendations: string[] = [];

        // Check for slow non-indexed queries
        const slowQueries = results.filter(r => r.timings.p95 > 500);
        if (slowQueries.length > 0) {
            recommendations.push(
                `${slowQueries.length} queries have p95 > 500ms - consider adding indexes`
            );
        }

        // Check for high memory usage
        const highMemory = results.filter(r => r.memoryUsedMB > 100);
        if (highMemory.length > 0) {
            recommendations.push(
                `${highMemory.length} queries use >100MB memory - consider pagination or streaming`
            );
        }

        // Check for low QPS
        const lowQps = results.filter(r => r.queriesPerSecond < 10);
        if (lowQps.length > 0) {
            recommendations.push(
                `${lowQps.length} queries have QPS < 10 - investigate query plans with EXPLAIN ANALYZE`
            );
        }

        // Check for high variance
        const highVariance = results.filter(r => r.timings.stdDev > r.timings.mean * 0.5);
        if (highVariance.length > 0) {
            recommendations.push(
                `${highVariance.length} queries show high variance - may indicate cache miss issues`
            );
        }

        return recommendations;
    }

    private padRight(str: string, len: number): string {
        return str.padEnd(len);
    }

    private padLeft(str: string, len: number): string {
        return str.padStart(len);
    }

    private truncate(str: string, maxLen: number): string {
        if (str.length <= maxLen) return str;
        return str.slice(0, maxLen - 3) + '...';
    }
}
