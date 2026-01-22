/**
 * Benchmark execution engine for stress testing
 * Runs queries with statistical analysis
 */
import db from '../../database';

export interface BenchmarkResult {
    name: string;
    iterations: number;
    totalRecords: number;
    timings: {
        min: number;
        max: number;
        mean: number;
        median: number;
        p95: number;
        p99: number;
        stdDev: number;
    };
    rowsReturned: number;
    queriesPerSecond: number;
    memoryUsedMB: number;
    passed: boolean;
    target?: number;
}

export interface BenchmarkOptions {
    iterations?: number;
    warmupIterations?: number;
    targetP95?: number;
    collectMemory?: boolean;
}

export interface ConcurrentResult {
    name: string;
    concurrency: number;
    totalQueries: number;
    queriesPerSecond: number;
    avgLatency: number;
    errorRate: number;
}

export class BenchmarkRunner {
    private results: BenchmarkResult[] = [];

    async run(
        name: string,
        queryFn: () => Promise<any[]>,
        options: BenchmarkOptions = {}
    ): Promise<BenchmarkResult> {
        const {
            iterations = 20,
            warmupIterations = 3,
            targetP95,
            collectMemory = true
        } = options;

        // Warmup phase
        for (let i = 0; i < warmupIterations; i++) {
            await queryFn();
        }

        // Force GC if available
        if (typeof global.gc === 'function') {
            global.gc();
        }

        const times: number[] = [];
        let rowCount = 0;
        const memBefore = process.memoryUsage().heapUsed;

        // Benchmark phase
        for (let i = 0; i < iterations; i++) {
            const start = performance.now();
            const results = await queryFn();
            times.push(performance.now() - start);
            rowCount = Array.isArray(results) ? results.length : 0;
        }

        const memAfter = process.memoryUsage().heapUsed;
        const sortedTimes = [...times].sort((a, b) => a - b);

        const timings = {
            min: sortedTimes[0],
            max: sortedTimes[sortedTimes.length - 1],
            mean: times.reduce((a, b) => a + b) / times.length,
            median: sortedTimes[Math.floor(sortedTimes.length / 2)],
            p95: sortedTimes[Math.floor(sortedTimes.length * 0.95)] ?? sortedTimes[sortedTimes.length - 1],
            p99: sortedTimes[Math.floor(sortedTimes.length * 0.99)] ?? sortedTimes[sortedTimes.length - 1],
            stdDev: this.calculateStdDev(times)
        };

        const result: BenchmarkResult = {
            name,
            iterations,
            totalRecords: await this.getRecordCount(),
            timings,
            rowsReturned: rowCount,
            queriesPerSecond: 1000 / timings.mean,
            memoryUsedMB: collectMemory ? (memAfter - memBefore) / 1024 / 1024 : 0,
            passed: targetP95 ? timings.p95 <= targetP95 : true,
            target: targetP95
        };

        this.results.push(result);
        return result;
    }

    async runConcurrent(
        name: string,
        queryFn: () => Promise<any[]>,
        concurrency: number,
        duration: number = 10000
    ): Promise<ConcurrentResult> {
        const times: number[] = [];
        let errors = 0;
        const startTime = performance.now();

        const worker = async () => {
            while (performance.now() - startTime < duration) {
                const queryStart = performance.now();
                try {
                    await queryFn();
                    times.push(performance.now() - queryStart);
                } catch {
                    errors++;
                }
            }
        };

        await Promise.all(Array(concurrency).fill(null).map(() => worker()));

        const totalTime = performance.now() - startTime;

        return {
            name,
            concurrency,
            totalQueries: times.length + errors,
            queriesPerSecond: (times.length / totalTime) * 1000,
            avgLatency: times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0,
            errorRate: (times.length + errors) > 0 ? errors / (times.length + errors) : 0
        };
    }

    /**
     * Run a benchmark and print detailed results
     */
    async runWithOutput(
        name: string,
        queryFn: () => Promise<any[]>,
        options: BenchmarkOptions = {}
    ): Promise<BenchmarkResult> {
        console.log(`  Running: ${name}...`);
        const result = await this.run(name, queryFn, options);

        const status = result.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
        console.log(
            `    ${status} p50=${result.timings.median.toFixed(1)}ms ` +
            `p95=${result.timings.p95.toFixed(1)}ms ` +
            `rows=${result.rowsReturned} ` +
            `QPS=${result.queriesPerSecond.toFixed(0)}`
        );

        if (!result.passed && result.target) {
            console.log(`    Target: p95 <= ${result.target}ms`);
        }

        return result;
    }

    private calculateStdDev(values: number[]): number {
        if (values.length === 0) return 0;
        const mean = values.reduce((a, b) => a + b) / values.length;
        const squareDiffs = values.map(value => Math.pow(value - mean, 2));
        return Math.sqrt(squareDiffs.reduce((a, b) => a + b) / values.length);
    }

    private async getRecordCount(): Promise<number> {
        try {
            const result = await db`SELECT COUNT(*) as count FROM entities WHERE deleted_at IS NULL`;
            return parseInt(result[0].count);
        } catch {
            return 0;
        }
    }

    getResults(): BenchmarkResult[] {
        return [...this.results];
    }

    clearResults(): void {
        this.results = [];
    }

    /**
     * Get summary statistics
     */
    getSummary(): { passed: number; failed: number; total: number } {
        const passed = this.results.filter(r => r.passed).length;
        const failed = this.results.filter(r => !r.passed).length;
        return { passed, failed, total: this.results.length };
    }
}
