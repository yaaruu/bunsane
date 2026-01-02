#!/usr/bin/env node

/**
 * Load Testing Script for Bunsane Query Performance
 *
 * Tests concurrent query execution with 50 simultaneous requests
 * Measures response times, error rates, and system resource usage
 */

import { Query } from '../query/Query';
import { Entity } from '../core/Entity';
import { Component, CompData, ComponentRegistry, BaseComponent, type ComponentDataType } from "@/core/components";

// Test components for load testing
@Component
class LoadTestUser extends BaseComponent {
    @CompData()
    username!: string;

    @CompData()
    account_type!: string;
}

@Component
class LoadTestQuota extends BaseComponent {
    @CompData()
    account_id!: string;

    @CompData()
    usage!: number;

    @CompData()
    date!: string;
}

@Component
class LoadTestOrder extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    status!: string;

    @CompData()
    total_amount!: number;
}

interface LoadTestResult {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    averageResponseTime: number;
    minResponseTime: number;
    maxResponseTime: number;
    p50ResponseTime: number;
    p95ResponseTime: number;
    p99ResponseTime: number;
    errorRate: number;
    requestsPerSecond: number;
    totalDuration: number;
}

interface QueryExecutionResult {
    duration: number;
    success: boolean;
    error?: string;
    resultCount?: number;
}

async function runLoadTest(concurrentRequests: number = 50, durationSeconds: number = 60): Promise<LoadTestResult> {
    console.log(`🚀 Starting load test with ${concurrentRequests} concurrent requests for ${durationSeconds} seconds`);

    // Ensure components are registered
    await ComponentRegistry.ensureComponentsRegistered();

    const results: QueryExecutionResult[] = [];
    const startTime = Date.now();
    const endTime = startTime + (durationSeconds * 1000);

    // Query patterns to test
    const queryPatterns = [
        // Simple single component query
        () => new Query().with(LoadTestUser, Query.filters(
            Query.filter('account_type', Query.filterOp.EQ, 'premium')
        )),

        // Multi-component query with filters
        () => new Query().with(LoadTestUser, Query.filters(
            Query.filter('account_type', Query.filterOp.EQ, 'premium')
        )).with(LoadTestQuota, Query.filters(
            Query.filter('usage', Query.filterOp.GT, 100)
        )),

        // Complex query with date ranges
        () => new Query().with(LoadTestQuota, Query.filters(
            Query.filter('date', Query.filterOp.GTE, '2025-01-01'),
            Query.filter('date', Query.filterOp.LT, '2025-12-31'),
            Query.filter('usage', Query.filterOp.GT, 50)
        )),

        // Count query
        () => new Query().with(LoadTestOrder, Query.filters(
            Query.filter('status', Query.filterOp.EQ, 'completed')
        )),

        // Query with sorting and limiting
        () => new Query().with(LoadTestOrder, Query.filters(
            Query.filter('total_amount', Query.filterOp.GT, 100)
        )).take(10)
    ];

        // Worker function for each concurrent request
    const runQueryWorker = async (workerId: number): Promise<void> => {
        while (Date.now() < endTime) {
            try {
                const queryPattern = queryPatterns[Math.floor(Math.random() * queryPatterns.length)];
                if (!queryPattern) continue;

                const query = queryPattern();                const queryStart = performance.now();
                const queryResult = await query.exec();
                const queryEnd = performance.now();

                results.push({
                    duration: queryEnd - queryStart,
                    success: true,
                    resultCount: Array.isArray(queryResult) ? queryResult.length : 1
                });

            } catch (error) {
                results.push({
                    duration: 0,
                    success: false,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }

            // Small delay to prevent overwhelming the system
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    };

    // Start concurrent workers
    console.log(`📊 Starting ${concurrentRequests} concurrent workers...`);
    const workers = Array.from({ length: concurrentRequests }, (_, i) =>
        runQueryWorker(i)
    );

    // Wait for all workers to complete
    await Promise.all(workers);

    const actualDuration = (Date.now() - startTime) / 1000;
    console.log(`✅ Load test completed in ${actualDuration.toFixed(2)} seconds`);

    // Calculate statistics
    const successfulResults = results.filter(r => r.success);
    const failedResults = results.filter(r => !r.success);

    const responseTimes = successfulResults.map(r => r.duration).sort((a, b) => a - b);

    const calculatePercentile = (arr: number[], percentile: number): number => {
        if (arr.length === 0) return 0;
        const index = Math.ceil((percentile / 100) * arr.length) - 1;
        const safeIndex = Math.max(0, Math.min(index, arr.length - 1));
        return arr[safeIndex]!;
    };

    const result: LoadTestResult = {
        totalRequests: results.length,
        successfulRequests: successfulResults.length,
        failedRequests: failedResults.length,
        averageResponseTime: responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length,
        minResponseTime: Math.min(...responseTimes),
        maxResponseTime: Math.max(...responseTimes),
        p50ResponseTime: calculatePercentile(responseTimes, 50),
        p95ResponseTime: calculatePercentile(responseTimes, 95),
        p99ResponseTime: calculatePercentile(responseTimes, 99),
        errorRate: (failedResults.length / results.length) * 100,
        requestsPerSecond: results.length / actualDuration,
        totalDuration: actualDuration
    };

    return result;
}

function printLoadTestResults(result: LoadTestResult): void {
    console.log('\n📈 Load Test Results:');
    console.log('='.repeat(50));
    console.log(`Total Requests: ${result.totalRequests.toLocaleString()}`);
    console.log(`Successful Requests: ${result.successfulRequests.toLocaleString()}`);
    console.log(`Failed Requests: ${result.failedRequests.toLocaleString()}`);
    console.log(`Error Rate: ${result.errorRate.toFixed(2)}%`);
    console.log(`Requests/Second: ${result.requestsPerSecond.toFixed(2)}`);
    console.log(`Total Duration: ${result.totalDuration.toFixed(2)}s`);
    console.log('');

    console.log('Response Time Statistics:');
    console.log(`Average: ${result.averageResponseTime.toFixed(2)}ms`);
    console.log(`Min: ${result.minResponseTime.toFixed(2)}ms`);
    console.log(`Max: ${result.maxResponseTime.toFixed(2)}ms`);
    console.log(`50th Percentile (P50): ${result.p50ResponseTime.toFixed(2)}ms`);
    console.log(`95th Percentile (P95): ${result.p95ResponseTime.toFixed(2)}ms`);
    console.log(`99th Percentile (P99): ${result.p99ResponseTime.toFixed(2)}ms`);

    // Performance assessment
    console.log('\n🎯 Performance Assessment:');
    if (result.errorRate > 5) {
        console.log('❌ High error rate detected (>5%)');
    } else if (result.errorRate > 1) {
        console.log('⚠️  Moderate error rate detected (1-5%)');
    } else {
        console.log('✅ Low error rate (<1%)');
    }

    if (result.p95ResponseTime > 100) {
        console.log('❌ High latency detected (P95 > 100ms)');
    } else if (result.p95ResponseTime > 50) {
        console.log('⚠️  Moderate latency detected (P95 50-100ms)');
    } else {
        console.log('✅ Good latency (P95 < 50ms)');
    }

    if (result.requestsPerSecond < 10) {
        console.log('❌ Low throughput detected (< 10 req/s)');
    } else if (result.requestsPerSecond < 50) {
        console.log('⚠️  Moderate throughput (10-50 req/s)');
    } else {
        console.log('✅ Good throughput (> 50 req/s)');
    }
}

async function runConcurrentLoadTest(): Promise<void> {
    try {
        const result = await runLoadTest(50, 30); // 50 concurrent, 30 seconds
        printLoadTestResults(result);

        // Check cache statistics
        const cacheStats = (await import('../query/Query')).Query.getCacheStats();
        console.log('\n💾 Cache Statistics:');
        console.log(`Statements Cached: ${cacheStats.totalStatements}`);
        console.log(`Cache Size: ${cacheStats.currentSize}`);
        console.log(`Hit Rate: ${cacheStats.hitRate ? (cacheStats.hitRate * 100).toFixed(2) : 'N/A'}%`);

    } catch (error) {
        console.error('💥 Load test failed:', error);
        process.exit(1);
    }
}

// Run the load test
if (require.main === module) {
    runConcurrentLoadTest()
        .then(() => {
            console.log('\n🏁 Load testing completed');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 Load testing failed:', error);
            process.exit(1);
        });
}

export { runLoadTest };
export type { LoadTestResult };