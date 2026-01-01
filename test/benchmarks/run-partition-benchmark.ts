#!/usr/bin/env node

/**
 * Partition Strategy Benchmark Runner
 *
 * Runs comprehensive benchmarks comparing LIST vs HASH partitioning strategies.
 * This script can be run from command line or as part of CI/CD pipelines.
 */

// Load environment variables from .env.test BEFORE importing any modules that use the database
import * as fs from 'fs';
import * as path from 'path';

const possibleEnvPaths = [
    path.join(process.cwd(), '.env.test'),
    path.join(process.cwd(), '..', 'buroq-api', '.env.test'),
    path.join(process.cwd(), '..', '..', 'YPW', 'Buroq2025', 'buroq-api', '.env.test')
];

for (const envPath of possibleEnvPaths) {
    if (fs.existsSync(envPath)) {
        console.log(`📄 Loading environment from ${path.relative(process.cwd(), envPath)}`);
        const envContent = fs.readFileSync(envPath, 'utf8');
        const loadedVars: string[] = [];
        for (const line of envContent.split('\n')) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                const [key, ...valueParts] = trimmed.split('=');
                if (key && valueParts.length > 0) {
                    const value = valueParts.join('=').replace(/^["']|["']$/g, ''); // Remove quotes
                    const cleanKey = key.trim();
                    process.env[cleanKey] = value;
                    loadedVars.push(cleanKey);
                }
            }
        }
        console.log(`📋 Loaded environment variables: ${loadedVars.join(', ')}`);
        console.log(`🔗 POSTGRES_HOST: ${process.env.POSTGRES_HOST || 'undefined'}`);
        console.log(`🔗 POSTGRES_DB: ${process.env.POSTGRES_DB || 'undefined'}`);
        console.log(`🔗 POSTGRES_USER: ${process.env.POSTGRES_USER || 'undefined'}`);
        break; // Load from first found file
    }
}

// Now import modules that depend on environment variables (dynamically to ensure env vars are loaded)
let benchmarkUtils: any = null;

async function getBenchmarkUtils() {
    if (!benchmarkUtils) {
        benchmarkUtils = await import('./partition-benchmark-utils');
    }
    return benchmarkUtils;
}

interface BenchmarkConfig {
    entityCount: number;
    componentCount: number;
    outputFile?: string;
    strategies: Array<{
        strategy: 'list' | 'hash';
        useDirectPartition: boolean;
        name: string;
    }>;
    strategiesSpecified?: boolean;
}

const DEFAULT_CONFIG: BenchmarkConfig = {
    entityCount: 1000,
    componentCount: 100, // Now we have 100 component types available (Comp1-Comp100)
    strategies: [
        { strategy: 'list', useDirectPartition: false, name: 'LIST' },
        { strategy: 'list', useDirectPartition: true, name: 'LIST+Direct' },
        { strategy: 'hash', useDirectPartition: false, name: 'HASH' }
    ]
};

/**
 * Parse command line arguments
 */
function parseArgs(): BenchmarkConfig {
    const args = process.argv.slice(2);
    const config = { ...DEFAULT_CONFIG };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const nextArg = args[i + 1];

        switch (arg) {
            case '--entities':
            case '-e':
                if (nextArg && !isNaN(parseInt(nextArg))) {
                    config.entityCount = parseInt(nextArg);
                    i++; // Skip next arg
                }
                break;
            case '--components':
            case '-c':
                if (nextArg && !isNaN(parseInt(nextArg))) {
                    config.componentCount = parseInt(nextArg);
                    i++; // Skip next arg
                }
                break;
            case '--output':
            case '-o':
                if (nextArg) {
                    config.outputFile = nextArg;
                    i++; // Skip next arg
                }
                break;
            case '--strategy':
            case '-s':
                if (nextArg) {
                    const strategyName = nextArg.toLowerCase();
                    if (strategyName === 'all') {
                        config.strategies = [
                            { strategy: 'list', useDirectPartition: false, name: 'LIST' },
                            { strategy: 'list', useDirectPartition: true, name: 'LIST+Direct' },
                            { strategy: 'hash', useDirectPartition: false, name: 'HASH' }
                        ];
                        config.strategiesSpecified = true;
                    } else {
                        // Initialize strategies array if not already specified
                        if (!config.strategiesSpecified) {
                            config.strategies = [];
                            config.strategiesSpecified = true;
                        }

                        if (strategyName === 'list') {
                            config.strategies.push({ strategy: 'list', useDirectPartition: false, name: 'LIST' });
                        } else if (strategyName === 'list-direct') {
                            config.strategies.push({ strategy: 'list', useDirectPartition: true, name: 'LIST+Direct' });
                        } else if (strategyName === 'hash') {
                            config.strategies.push({ strategy: 'hash', useDirectPartition: false, name: 'HASH' });
                        } else {
                            console.error(`Unknown strategy: ${nextArg}. Use: list, list-direct, hash, or all`);
                            process.exit(1);
                        }
                    }
                    i++; // Skip next arg
                }
                break;
            case '--help':
            case '-h':
                printUsage();
                process.exit(0);
                break;
        }
    }

    return config;
}

/**
 * Print usage information
 */
function printUsage(): void {
    console.log(`
Partition Strategy Benchmark Runner

Usage: bun run test/benchmarks/run-partition-benchmark.ts [options]

Options:
  -e, --entities <count>    Number of entities to generate for testing (default: 1000)
  -c, --components <count>  Number of component types to generate (default: 25)
  -s, --strategy <type>     Strategy to test: list, list-direct, hash, or all (default: all)
  -o, --output <file>       Output file for results (optional)
  -h, --help                Show this help message

Examples:
  bun run test/benchmarks/run-partition-benchmark.ts
  bun run test/benchmarks/run-partition-benchmark.ts --entities 5000 --components 50 --strategy list
  bun run test/benchmarks/run-partition-benchmark.ts --components 100 --output results.json

Strategies:
  list          LIST partitioning with parent table queries
  list-direct   LIST partitioning with direct partition table access
  hash          HASH partitioning (baseline)
  all           Run all strategies (default)
`);
}

/**
 * Save results to file
 */
function saveResults(results: BenchmarkResult[], outputFile: string): void {
    try {
        const outputDir = path.dirname(outputFile);
        // Only create directory if it's not the current directory
        if (outputDir !== '.' && !fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const output = {
            timestamp: new Date().toISOString(),
            config: config,
            results: results
        };

        fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
        console.log(`\n📁 Results saved to: ${outputFile}`);
    } catch (error) {
        console.error(`❌ Failed to save results:`, error);
    }
}

/**
 * Generate performance summary
 */

/**
 * Print summary to console
 */
async function printSummary(results: any[]): Promise<void> {
    console.log('\n' + '='.repeat(80));
    console.log('🎯 BENCHMARK SUMMARY');
    console.log('='.repeat(80));

    // Generate summary using dynamic import
    const { formatBenchmarkResults } = await getBenchmarkUtils();
    console.log('\n' + formatBenchmarkResults(results));

    // Calculate summary stats inline
    if (results.length === 0) {
        console.log('No benchmark results to summarize');
        return;
    }

    const summary: any = {};

    // Group by query type
    const byQueryType = new Map<string, any[]>();
    for (const result of results) {
        const key = result.queryType;
        if (!byQueryType.has(key)) {
            byQueryType.set(key, []);
        }
        byQueryType.get(key)!.push(result);
    }

    // Calculate best performer for each query type
    for (const [queryType, queryResults] of byQueryType) {
        if (queryResults.length === 0) continue;

        const bestResult = queryResults.reduce((best, current) =>
            current.totalTimeMs < best.totalTimeMs ? current : best
        );

        const worstResult = queryResults.reduce((worst, current) =>
            current.totalTimeMs > worst.totalTimeMs ? current : worst
        );

        const improvement = ((worstResult.totalTimeMs - bestResult.totalTimeMs) / worstResult.totalTimeMs) * 100;

        summary[queryType] = {
            bestStrategy: bestResult.strategy + (bestResult.useDirectPartition ? '+Direct' : ''),
            bestTime: bestResult.totalTimeMs,
            worstTime: worstResult.totalTimeMs,
            improvement: improvement,
            winner: bestResult.strategy + (bestResult.useDirectPartition ? '+Direct' : '')
        };
    }

    // Overall winner
    const allResults = Array.from(byQueryType.values()).flat();
    const overallBest = allResults.reduce((best, current) =>
        current.totalTimeMs < best.totalTimeMs ? current : best
    );

    summary.overall = {
        bestStrategy: overallBest.strategy + (overallBest.useDirectPartition ? '+Direct' : ''),
        averageTime: allResults.reduce((sum, r) => sum + r.totalTimeMs, 0) / allResults.length,
        totalQueries: allResults.length
    };

    console.log(`\n🏆 Overall Winner: ${summary.overall.bestStrategy}`);
    console.log(`📊 Average Query Time: ${summary.overall.averageTime.toFixed(2)}ms`);
    console.log(`🔢 Total Queries Run: ${summary.overall.totalQueries}`);

    console.log('\n📈 Per-Query Performance:');
    console.log('-'.repeat(60));

    for (const [queryType, stats] of Object.entries(summary)) {
        if (queryType === 'overall') continue;
        console.log(`${queryType.padEnd(25)} | ${stats.winner.padEnd(12)} | ${stats.improvement.toFixed(1).padStart(6)}% faster`);
    }

    console.log('\n' + '='.repeat(80));
}

/**
 * Main benchmark runner
 */
async function main(): Promise<void> {
    console.log('🚀 Starting Partition Strategy Benchmark Suite');
    console.log('='.repeat(60));

    const config = parseArgs();

    console.log(`📊 Configuration:`);
    console.log(`   Entities: ${config.entityCount}`);
    console.log(`   Components: ${config.componentCount}`);
    console.log(`   Strategies: ${config.strategies.map(s => s.name).join(', ')}`);
    console.log(`   Output: ${config.outputFile || 'console only'}`);
    console.log('');

    const allResults: BenchmarkResult[] = [];

    // Run benchmarks for each strategy
    for (const strategyConfig of config.strategies) {
        console.log(`\n🔬 Testing ${strategyConfig.name} Strategy`);
        console.log('-'.repeat(40));

        try {
            const startTime = Date.now();
            const { runBenchmarkSuite } = await getBenchmarkUtils();
            const results = await runBenchmarkSuite(
                strategyConfig.strategy,
                strategyConfig.useDirectPartition,
                config.entityCount,
                config.componentCount
            );
            const duration = Date.now() - startTime;

            allResults.push(...results);

            console.log(`✅ ${strategyConfig.name} completed in ${(duration / 1000).toFixed(1)}s`);
            console.log(`   ${results.length} scenarios tested`);
            console.log(`   Sample result: ${results[0]?.strategy} ${results[0]?.useDirectPartition}`);

        } catch (error) {
            console.error(`❌ ${strategyConfig.name} failed:`, error);
        }
    }

    // Display formatted results
    console.log('\n📊 DETAILED RESULTS');
    console.log('='.repeat(80));
    const { formatBenchmarkResults } = await getBenchmarkUtils();
    console.log(formatBenchmarkResults(allResults));

    // Print summary
    await printSummary(allResults);

    // Save results if requested
    if (config.outputFile) {
        saveResults(allResults, config.outputFile);
    }

    console.log('\n🎉 Benchmark suite completed!');
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

// Run the benchmark
if (require.main === module) {
    main().catch((error) => {
        console.error('💥 Benchmark failed:', error);
        process.exit(1);
    });
}

export { main as runPartitionBenchmark };
