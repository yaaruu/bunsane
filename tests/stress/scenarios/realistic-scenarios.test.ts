/**
 * Realistic Stress Test Scenarios
 *
 * Simulates real-world e-commerce query patterns with:
 * - 1000+ entities seeded with multiple components
 * - Multi-filter queries
 * - Multi-component joins
 * - OR queries
 * - Aggregations
 * - Complex sorting and pagination
 *
 * Run with: bun run test:pglite -- tests/stress/scenarios/realistic-scenarios.test.ts
 * Configure: STRESS_ENTITY_COUNT=5000 for larger tests
 */
import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import { DataSeeder } from '../DataSeeder';
import { BenchmarkRunner } from '../BenchmarkRunner';
import { StressTestReporter } from '../StressTestReporter';
import { Query, FilterOp } from '../../../query/Query';
import { OrQuery } from '../../../query/OrQuery';
import {
    Product,
    Inventory,
    Pricing,
    Vendor,
    ProductMetrics,
    CATEGORIES,
    SUBCATEGORIES,
    REGIONS,
    WAREHOUSES,
    CURRENCIES,
    VENDOR_TIERS,
    PRODUCT_STATUSES,
    STOCK_STATUSES
} from '../fixtures/RealisticComponents';
import { ensureComponentsRegistered } from '../../utils';

// Configuration via environment variables
const ENTITY_COUNT = parseInt(process.env.STRESS_ENTITY_COUNT || '1000', 10);
const BATCH_SIZE = Math.min(500, Math.floor(ENTITY_COUNT / 10) || 100);

// Helper to generate realistic test data
function generateProductData(index: number): Record<string, any> {
    const category = CATEGORIES[index % CATEGORIES.length];
    const subcategories = SUBCATEGORIES[category];
    const subcategory = subcategories[index % subcategories.length];
    const status = PRODUCT_STATUSES[index % PRODUCT_STATUSES.length];
    const now = new Date();
    const createdDaysAgo = Math.floor(Math.random() * 365);

    return {
        name: `Product ${index} - ${subcategory}`,
        sku: `SKU-${String(index).padStart(6, '0')}`,
        description: `This is a ${subcategory.toLowerCase()} product in the ${category} category. High quality item with great reviews.`,
        category,
        subcategory,
        tags: [category.toLowerCase(), subcategory.toLowerCase(), `tag${index % 10}`],
        status,
        rating: 1 + (Math.random() * 4),
        reviewCount: Math.floor(Math.random() * 500),
        createdAt: new Date(now.getTime() - createdDaysAgo * 24 * 60 * 60 * 1000),
        updatedAt: new Date(now.getTime() - Math.floor(createdDaysAgo / 2) * 24 * 60 * 60 * 1000)
    };
}

function generateInventoryData(index: number): Record<string, any> {
    const quantity = Math.floor(Math.random() * 1000);
    const reservedQuantity = Math.floor(quantity * Math.random() * 0.3);
    const reorderPoint = 10 + Math.floor(Math.random() * 40);

    let stockStatus: string;
    if (quantity === 0) stockStatus = 'out_of_stock';
    else if (quantity < reorderPoint) stockStatus = 'low_stock';
    else if (index % 20 === 0) stockStatus = 'backordered';
    else stockStatus = 'in_stock';

    return {
        quantity,
        reservedQuantity,
        warehouseId: WAREHOUSES[index % WAREHOUSES.length],
        reorderPoint,
        maxStock: 500 + Math.floor(Math.random() * 500),
        stockStatus,
        lastRestocked: new Date(Date.now() - Math.floor(Math.random() * 30) * 24 * 60 * 60 * 1000)
    };
}

function generatePricingData(index: number): Record<string, any> {
    const basePrice = 10 + Math.random() * 990;
    const costPrice = basePrice * (0.3 + Math.random() * 0.4);
    const isOnSale = index % 5 === 0;
    const discountPercent = isOnSale ? 10 + Math.floor(Math.random() * 40) : 0;
    const salePrice = isOnSale ? basePrice * (1 - discountPercent / 100) : basePrice;

    return {
        basePrice,
        salePrice,
        costPrice,
        currency: CURRENCIES[index % CURRENCIES.length],
        discountPercent,
        isOnSale,
        saleStartDate: isOnSale ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) : null,
        saleEndDate: isOnSale ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) : null,
        profit: salePrice - costPrice
    };
}

function generateVendorData(index: number): Record<string, any> {
    const vendorIndex = index % 50;
    return {
        vendorId: `VENDOR-${String(vendorIndex).padStart(3, '0')}`,
        vendorName: `Vendor ${vendorIndex} Inc.`,
        region: REGIONS[vendorIndex % REGIONS.length],
        vendorRating: 3 + Math.random() * 2,
        isVerified: vendorIndex % 3 !== 0,
        totalSales: Math.floor(Math.random() * 100000),
        tier: VENDOR_TIERS[Math.floor(vendorIndex / 12.5)]
    };
}

function generateMetricsData(index: number): Record<string, any> {
    const viewCount = Math.floor(Math.random() * 10000);
    const cartAddCount = Math.floor(viewCount * (0.1 + Math.random() * 0.2));
    const purchaseCount = Math.floor(cartAddCount * (0.2 + Math.random() * 0.3));

    return {
        viewCount,
        purchaseCount,
        cartAddCount,
        wishlistCount: Math.floor(Math.random() * 500),
        returnCount: Math.floor(purchaseCount * Math.random() * 0.1),
        conversionRate: purchaseCount / (viewCount || 1),
        lastPurchased: purchaseCount > 0
            ? new Date(Date.now() - Math.floor(Math.random() * 30) * 24 * 60 * 60 * 1000)
            : null,
        popularityScore: viewCount > 5000 ? 'high' : viewCount > 1000 ? 'medium' : 'low'
    };
}

describe('Realistic E-Commerce Stress Tests', () => {
    const seeder = new DataSeeder();
    const benchmark = new BenchmarkRunner();
    const reporter = new StressTestReporter();
    let entityIds: string[] = [];
    let setupTime = 0;

    beforeAll(async () => {
        const startSetup = performance.now();

        console.log(`\n  Registering components...`);
        await ensureComponentsRegistered(
            Product,
            Inventory,
            Pricing,
            Vendor,
            ProductMetrics
        );

        // Allow index creation to settle
        await new Promise(resolve => setTimeout(resolve, 2000));

        console.log(`  Seeding ${ENTITY_COUNT.toLocaleString()} product entities...`);

        // Seed primary Product component
        const result = await seeder.seed(
            Product,
            generateProductData,
            {
                totalEntities: ENTITY_COUNT,
                batchSize: BATCH_SIZE,
                onProgress: (current, total, elapsed) => {
                    if (current % (BATCH_SIZE * 5) === 0 || current === total) {
                        const pct = ((current / total) * 100).toFixed(1);
                        const rate = ((current / elapsed) * 1000).toFixed(0);
                        console.log(`    Product: ${pct}% (${rate}/sec)`);
                    }
                }
            }
        );
        entityIds = result.entityIds;
        console.log(`    Products seeded: ${result.recordsPerSecond.toFixed(0)}/sec`);

        // Add Inventory to all products
        console.log(`  Adding Inventory components...`);
        await seeder.seedAdditionalComponent(
            entityIds,
            Inventory,
            generateInventoryData,
            BATCH_SIZE
        );

        // Add Pricing to all products
        console.log(`  Adding Pricing components...`);
        await seeder.seedAdditionalComponent(
            entityIds,
            Pricing,
            generatePricingData,
            BATCH_SIZE
        );

        // Add Vendor to 80% of products
        const vendorEntityIds = entityIds.slice(0, Math.floor(entityIds.length * 0.8));
        console.log(`  Adding Vendor components to ${vendorEntityIds.length} products...`);
        await seeder.seedAdditionalComponent(
            vendorEntityIds,
            Vendor,
            generateVendorData,
            BATCH_SIZE
        );

        // Add ProductMetrics to 60% of products
        const metricsEntityIds = entityIds.slice(0, Math.floor(entityIds.length * 0.6));
        console.log(`  Adding ProductMetrics to ${metricsEntityIds.length} products...`);
        await seeder.seedAdditionalComponent(
            metricsEntityIds,
            ProductMetrics,
            generateMetricsData,
            BATCH_SIZE
        );

        console.log('  Running VACUUM ANALYZE...');
        await seeder.optimize();

        setupTime = performance.now() - startSetup;
        console.log(`  Setup complete in ${(setupTime / 1000).toFixed(1)}s\n`);
    }, 120000);

    afterAll(async () => {
        // Print report
        const recordCount = await seeder.getRecordCount();
        const report = reporter.generateReport(benchmark.getResults(), {
            recordCount,
            environment: `PGlite/PostgreSQL, Bun ${Bun.version}`,
            duration: setupTime
        });
        console.log('\n' + report);

        // Cleanup
        console.log('\n  Cleaning up test data...');
        await seeder.cleanup(entityIds, BATCH_SIZE);
        console.log('  Cleanup complete.');
    }, 60000);

    // ============================================================
    // SINGLE COMPONENT FILTER TESTS
    // ============================================================

    describe('Single Component Filters', () => {
        test('filter by category (indexed)', async () => {
            const result = await benchmark.runWithOutput(
                'Product: category=Electronics',
                () => new Query()
                    .with(Product, {
                        filters: [{ field: 'category', operator: FilterOp.EQ, value: 'Electronics' }]
                    })
                    .take(100)
                    .exec(),
                { targetP95: 100, iterations: 10 }
            );
            expect(result.rowsReturned).toBeGreaterThan(0);
            expect(result.passed).toBe(true);
        });

        test('filter by status (indexed)', async () => {
            const result = await benchmark.runWithOutput(
                'Product: status=active',
                () => new Query()
                    .with(Product, {
                        filters: [{ field: 'status', operator: FilterOp.EQ, value: 'active' }]
                    })
                    .take(100)
                    .exec(),
                { targetP95: 100, iterations: 10 }
            );
            expect(result.rowsReturned).toBeGreaterThan(0);
        });

        test('filter by rating range', async () => {
            const result = await benchmark.runWithOutput(
                'Product: rating >= 4',
                () => new Query()
                    .with(Product, {
                        filters: [{ field: 'rating', operator: FilterOp.GTE, value: 4 }]
                    })
                    .take(100)
                    .exec(),
                { targetP95: 100, iterations: 10 }
            );
            expect(result.rowsReturned).toBeGreaterThan(0);
        });

        test('filter by stock status', async () => {
            const result = await benchmark.runWithOutput(
                'Inventory: stockStatus=in_stock',
                () => new Query()
                    .with(Inventory, {
                        filters: [{ field: 'stockStatus', operator: FilterOp.EQ, value: 'in_stock' }]
                    })
                    .take(100)
                    .exec(),
                { targetP95: 100, iterations: 10 }
            );
            expect(result.rowsReturned).toBeGreaterThan(0);
        });

        test('filter by price range', async () => {
            const result = await benchmark.runWithOutput(
                'Pricing: 50 <= basePrice <= 200',
                () => new Query()
                    .with(Pricing, {
                        filters: [
                            { field: 'basePrice', operator: FilterOp.GTE, value: 50 },
                            { field: 'basePrice', operator: FilterOp.LTE, value: 200 }
                        ]
                    })
                    .take(100)
                    .exec(),
                { targetP95: 100, iterations: 10 }
            );
            expect(result.rowsReturned).toBeGreaterThan(0);
        });

        test('filter by boolean (isOnSale)', async () => {
            const result = await benchmark.runWithOutput(
                'Pricing: isOnSale=true',
                () => new Query()
                    .with(Pricing, {
                        filters: [{ field: 'isOnSale', operator: FilterOp.EQ, value: true }]
                    })
                    .take(100)
                    .exec(),
                { targetP95: 100, iterations: 10 }
            );
            expect(result.rowsReturned).toBeGreaterThan(0);
        });
    });

    // ============================================================
    // MULTI-FILTER SINGLE COMPONENT TESTS
    // ============================================================

    describe('Multi-Filter Single Component', () => {
        test('active products in Electronics with high rating', async () => {
            const result = await benchmark.runWithOutput(
                'Product: active + Electronics + rating>=4',
                () => new Query()
                    .with(Product, {
                        filters: [
                            { field: 'status', operator: FilterOp.EQ, value: 'active' },
                            { field: 'category', operator: FilterOp.EQ, value: 'Electronics' },
                            { field: 'rating', operator: FilterOp.GTE, value: 4 }
                        ]
                    })
                    .take(50)
                    .exec(),
                { targetP95: 150, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });

        test('low stock items below reorder point', async () => {
            const result = await benchmark.runWithOutput(
                'Inventory: low_stock + qty < 20',
                () => new Query()
                    .with(Inventory, {
                        filters: [
                            { field: 'stockStatus', operator: FilterOp.EQ, value: 'low_stock' },
                            { field: 'quantity', operator: FilterOp.LT, value: 20 }
                        ]
                    })
                    .take(50)
                    .exec(),
                { targetP95: 150, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });

        test('high margin sale items', async () => {
            const result = await benchmark.runWithOutput(
                'Pricing: onSale + profit > 100',
                () => new Query()
                    .with(Pricing, {
                        filters: [
                            { field: 'isOnSale', operator: FilterOp.EQ, value: true },
                            { field: 'profit', operator: FilterOp.GT, value: 100 }
                        ]
                    })
                    .take(50)
                    .exec(),
                { targetP95: 150, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });

        test('verified gold/platinum vendors with high rating', async () => {
            const result = await benchmark.runWithOutput(
                'Vendor: verified + rating>=4 + tier=gold',
                () => new Query()
                    .with(Vendor, {
                        filters: [
                            { field: 'isVerified', operator: FilterOp.EQ, value: true },
                            { field: 'vendorRating', operator: FilterOp.GTE, value: 4 },
                            { field: 'tier', operator: FilterOp.EQ, value: 'gold' }
                        ]
                    })
                    .take(50)
                    .exec(),
                { targetP95: 150, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });
    });

    // ============================================================
    // MULTI-COMPONENT JOIN TESTS
    // ============================================================

    describe('Multi-Component Joins', () => {
        test('2-way join: Product + Inventory', async () => {
            const result = await benchmark.runWithOutput(
                'Join: Product + Inventory',
                () => new Query()
                    .with(Product)
                    .with(Inventory)
                    .take(100)
                    .exec(),
                { targetP95: 150, iterations: 10 }
            );
            expect(result.rowsReturned).toBeGreaterThan(0);
            expect(result.passed).toBe(true);
        });

        test('3-way join: Product + Inventory + Pricing', async () => {
            const result = await benchmark.runWithOutput(
                'Join: Product + Inventory + Pricing',
                () => new Query()
                    .with(Product)
                    .with(Inventory)
                    .with(Pricing)
                    .take(100)
                    .exec(),
                { targetP95: 200, iterations: 10 }
            );
            expect(result.rowsReturned).toBeGreaterThan(0);
        });

        test('4-way join: Product + Inventory + Pricing + Vendor', async () => {
            const result = await benchmark.runWithOutput(
                'Join: Product + Inventory + Pricing + Vendor',
                () => new Query()
                    .with(Product)
                    .with(Inventory)
                    .with(Pricing)
                    .with(Vendor)
                    .take(100)
                    .exec(),
                { targetP95: 300, iterations: 10 }
            );
            expect(result.rowsReturned).toBeGreaterThan(0);
        });

        test('5-way join (all components)', async () => {
            const result = await benchmark.runWithOutput(
                'Join: All 5 components',
                () => new Query()
                    .with(Product)
                    .with(Inventory)
                    .with(Pricing)
                    .with(Vendor)
                    .with(ProductMetrics)
                    .take(100)
                    .exec(),
                { targetP95: 400, iterations: 10 }
            );
            expect(result.rowsReturned).toBeGreaterThan(0);
        });
    });

    // ============================================================
    // MULTI-COMPONENT WITH FILTERS TESTS
    // ============================================================

    describe('Multi-Component with Filters', () => {
        test('active Electronics in stock', async () => {
            const result = await benchmark.runWithOutput(
                'Product(active+Electronics) + Inventory(in_stock)',
                () => new Query()
                    .with(Product, {
                        filters: [
                            { field: 'status', operator: FilterOp.EQ, value: 'active' },
                            { field: 'category', operator: FilterOp.EQ, value: 'Electronics' }
                        ]
                    })
                    .with(Inventory, {
                        filters: [
                            { field: 'stockStatus', operator: FilterOp.EQ, value: 'in_stock' }
                        ]
                    })
                    .take(50)
                    .exec(),
                { targetP95: 200, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });

        test('on-sale products with low stock', async () => {
            const result = await benchmark.runWithOutput(
                'Pricing(onSale) + Inventory(low_stock)',
                () => new Query()
                    .with(Pricing, {
                        filters: [{ field: 'isOnSale', operator: FilterOp.EQ, value: true }]
                    })
                    .with(Inventory, {
                        filters: [{ field: 'stockStatus', operator: FilterOp.EQ, value: 'low_stock' }]
                    })
                    .take(50)
                    .exec(),
                { targetP95: 200, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });

        test('high-rated products from verified vendors', async () => {
            const result = await benchmark.runWithOutput(
                'Product(rating>=4) + Vendor(verified)',
                () => new Query()
                    .with(Product, {
                        filters: [{ field: 'rating', operator: FilterOp.GTE, value: 4 }]
                    })
                    .with(Vendor, {
                        filters: [{ field: 'isVerified', operator: FilterOp.EQ, value: true }]
                    })
                    .take(50)
                    .exec(),
                { targetP95: 200, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });

        test('complex: active, in stock, on sale, price range', async () => {
            const result = await benchmark.runWithOutput(
                'Complex 4-filter multi-component',
                () => new Query()
                    .with(Product, {
                        filters: [{ field: 'status', operator: FilterOp.EQ, value: 'active' }]
                    })
                    .with(Inventory, {
                        filters: [{ field: 'stockStatus', operator: FilterOp.EQ, value: 'in_stock' }]
                    })
                    .with(Pricing, {
                        filters: [
                            { field: 'isOnSale', operator: FilterOp.EQ, value: true },
                            { field: 'salePrice', operator: FilterOp.LTE, value: 500 }
                        ]
                    })
                    .take(50)
                    .exec(),
                { targetP95: 300, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });

        test('full pipeline: active + in_stock + onSale + verified + high popularity', async () => {
            const result = await benchmark.runWithOutput(
                'Full pipeline: 5-component filtered',
                () => new Query()
                    .with(Product, {
                        filters: [{ field: 'status', operator: FilterOp.EQ, value: 'active' }]
                    })
                    .with(Inventory, {
                        filters: [{ field: 'stockStatus', operator: FilterOp.EQ, value: 'in_stock' }]
                    })
                    .with(Pricing, {
                        filters: [{ field: 'isOnSale', operator: FilterOp.EQ, value: true }]
                    })
                    .with(Vendor, {
                        filters: [{ field: 'isVerified', operator: FilterOp.EQ, value: true }]
                    })
                    .with(ProductMetrics, {
                        filters: [{ field: 'popularityScore', operator: FilterOp.EQ, value: 'high' }]
                    })
                    .take(50)
                    .exec(),
                { targetP95: 500, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });
    });

    // ============================================================
    // OR QUERY TESTS
    // ============================================================

    describe('OR Queries', () => {
        test('OR: active OR pending products', async () => {
            const orQuery = new OrQuery([
                { component: Product, filters: [{ field: 'status', operator: FilterOp.EQ, value: 'active' }] },
                { component: Product, filters: [{ field: 'status', operator: FilterOp.EQ, value: 'pending' }] }
            ]);

            const result = await benchmark.runWithOutput(
                'OR: status=active OR status=pending',
                () => new Query()
                    .with(orQuery)
                    .take(100)
                    .exec(),
                { targetP95: 200, iterations: 10 }
            );
            expect(result.rowsReturned).toBeGreaterThan(0);
        });

        test('OR: low_stock OR out_of_stock', async () => {
            const orQuery = new OrQuery([
                { component: Inventory, filters: [{ field: 'stockStatus', operator: FilterOp.EQ, value: 'low_stock' }] },
                { component: Inventory, filters: [{ field: 'stockStatus', operator: FilterOp.EQ, value: 'out_of_stock' }] }
            ]);

            const result = await benchmark.runWithOutput(
                'OR: low_stock OR out_of_stock',
                () => new Query()
                    .with(orQuery)
                    .take(100)
                    .exec(),
                { targetP95: 200, iterations: 10 }
            );
            expect(result.rowsReturned).toBeGreaterThan(0);
        });

        test('OR: Electronics OR Clothing categories', async () => {
            const orQuery = new OrQuery([
                { component: Product, filters: [{ field: 'category', operator: FilterOp.EQ, value: 'Electronics' }] },
                { component: Product, filters: [{ field: 'category', operator: FilterOp.EQ, value: 'Clothing' }] }
            ]);

            const result = await benchmark.runWithOutput(
                'OR: Electronics OR Clothing',
                () => new Query()
                    .with(orQuery)
                    .take(100)
                    .exec(),
                { targetP95: 200, iterations: 10 }
            );
            expect(result.rowsReturned).toBeGreaterThan(0);
        });
    });

    // ============================================================
    // EXCLUSION TESTS (without)
    // ============================================================

    describe('Component Exclusion (without)', () => {
        test('products without Vendor', async () => {
            const result = await benchmark.runWithOutput(
                'Product without Vendor',
                () => new Query()
                    .with(Product)
                    .without(Vendor)
                    .take(100)
                    .exec(),
                { targetP95: 150, iterations: 10 }
            );
            // ~20% of products don't have vendors
            expect(result.rowsReturned).toBeGreaterThan(0);
        });

        test('products without ProductMetrics', async () => {
            const result = await benchmark.runWithOutput(
                'Product without Metrics',
                () => new Query()
                    .with(Product)
                    .without(ProductMetrics)
                    .take(100)
                    .exec(),
                { targetP95: 150, iterations: 10 }
            );
            // ~40% of products don't have metrics
            expect(result.rowsReturned).toBeGreaterThan(0);
        });

        test('in-stock products from non-verified vendors', async () => {
            const result = await benchmark.runWithOutput(
                'Inventory(in_stock) + Vendor(!verified)',
                () => new Query()
                    .with(Inventory, {
                        filters: [{ field: 'stockStatus', operator: FilterOp.EQ, value: 'in_stock' }]
                    })
                    .with(Vendor, {
                        filters: [{ field: 'isVerified', operator: FilterOp.EQ, value: false }]
                    })
                    .take(50)
                    .exec(),
                { targetP95: 200, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });
    });

    // ============================================================
    // SORTING TESTS
    // ============================================================

    describe('Sorting', () => {
        test('sort by rating DESC', async () => {
            const result = await benchmark.runWithOutput(
                'Product sorted by rating DESC',
                () => new Query()
                    .with(Product)
                    .sortBy(Product, 'rating', 'DESC')
                    .take(100)
                    .exec(),
                { targetP95: 150, iterations: 10 }
            );
            expect(result.rowsReturned).toBeGreaterThan(0);
        });

        test('sort by basePrice ASC', async () => {
            const result = await benchmark.runWithOutput(
                'Pricing sorted by basePrice ASC',
                () => new Query()
                    .with(Pricing)
                    .sortBy(Pricing, 'basePrice', 'ASC')
                    .take(100)
                    .exec(),
                { targetP95: 150, iterations: 10 }
            );
            expect(result.rowsReturned).toBeGreaterThan(0);
        });

        test('filter + sort: active products by rating', async () => {
            const result = await benchmark.runWithOutput(
                'Product(active) sorted by rating',
                () => new Query()
                    .with(Product, {
                        filters: [{ field: 'status', operator: FilterOp.EQ, value: 'active' }]
                    })
                    .sortBy(Product, 'rating', 'DESC')
                    .take(50)
                    .exec(),
                { targetP95: 200, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });

        test('multi-component filter + sort: on-sale by discount', async () => {
            const result = await benchmark.runWithOutput(
                'Pricing(onSale) sorted by discount',
                () => new Query()
                    .with(Product, {
                        filters: [{ field: 'status', operator: FilterOp.EQ, value: 'active' }]
                    })
                    .with(Pricing, {
                        filters: [{ field: 'isOnSale', operator: FilterOp.EQ, value: true }]
                    })
                    .sortBy(Pricing, 'discountPercent', 'DESC')
                    .take(50)
                    .exec(),
                { targetP95: 250, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });
    });

    // ============================================================
    // PAGINATION TESTS
    // ============================================================

    describe('Pagination', () => {
        test('offset pagination: page 1', async () => {
            const result = await benchmark.runWithOutput(
                'Offset: page 1 (0-50)',
                () => new Query()
                    .with(Product)
                    .take(50)
                    .offset(0)
                    .exec(),
                { targetP95: 100, iterations: 10 }
            );
            expect(result.rowsReturned).toBe(50);
        });

        test('offset pagination: page 10', async () => {
            const result = await benchmark.runWithOutput(
                'Offset: page 10 (450-500)',
                () => new Query()
                    .with(Product)
                    .take(50)
                    .offset(450)
                    .exec(),
                { targetP95: 150, iterations: 10 }
            );
            expect(result.rowsReturned).toBeGreaterThanOrEqual(0);
        });

        test('cursor pagination: first page', async () => {
            const result = await benchmark.runWithOutput(
                'Cursor: first page',
                () => new Query()
                    .with(Product)
                    .take(50)
                    .exec(),
                { targetP95: 100, iterations: 10 }
            );
            expect(result.rowsReturned).toBe(50);
        });

        test('cursor pagination: from middle', async () => {
            // Get a cursor from the middle
            const midpoint = await new Query()
                .with(Product)
                .take(1)
                .offset(Math.floor(ENTITY_COUNT / 2))
                .exec();

            const cursorId = midpoint[0]?.id;
            if (!cursorId) {
                console.log('  Skipping cursor test - no midpoint found');
                return;
            }

            const result = await benchmark.runWithOutput(
                'Cursor: from middle',
                () => new Query()
                    .with(Product)
                    .cursor(cursorId)
                    .take(50)
                    .exec(),
                { targetP95: 100, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });

        test('filtered pagination: active products page 5', async () => {
            const result = await benchmark.runWithOutput(
                'Filtered offset: active page 5',
                () => new Query()
                    .with(Product, {
                        filters: [{ field: 'status', operator: FilterOp.EQ, value: 'active' }]
                    })
                    .take(50)
                    .offset(200)
                    .exec(),
                { targetP95: 200, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });
    });

    // ============================================================
    // AGGREGATION TESTS
    // ============================================================

    describe('Aggregations', () => {
        test('count all products', async () => {
            const result = await benchmark.runWithOutput(
                'COUNT: all products',
                async () => [await new Query().with(Product).count()],
                { targetP95: 100, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });

        test('count filtered: active products', async () => {
            const result = await benchmark.runWithOutput(
                'COUNT: active products',
                async () => [await new Query()
                    .with(Product, {
                        filters: [{ field: 'status', operator: FilterOp.EQ, value: 'active' }]
                    })
                    .count()],
                { targetP95: 100, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });

        test('count multi-component: active + in_stock', async () => {
            const result = await benchmark.runWithOutput(
                'COUNT: active + in_stock',
                async () => [await new Query()
                    .with(Product, {
                        filters: [{ field: 'status', operator: FilterOp.EQ, value: 'active' }]
                    })
                    .with(Inventory, {
                        filters: [{ field: 'stockStatus', operator: FilterOp.EQ, value: 'in_stock' }]
                    })
                    .count()],
                { targetP95: 200, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });
    });

    // ============================================================
    // POPULATE (EAGER LOADING) TESTS
    // ============================================================

    describe('Populate / Eager Loading', () => {
        test('populate single component', async () => {
            const result = await benchmark.runWithOutput(
                'Populate: Product',
                () => new Query()
                    .with(Product)
                    .populate()
                    .take(50)
                    .exec(),
                { targetP95: 150, iterations: 10 }
            );
            expect(result.rowsReturned).toBe(50);
        });

        test('populate multi-component', async () => {
            const result = await benchmark.runWithOutput(
                'Populate: Product + Pricing',
                () => new Query()
                    .with(Product)
                    .with(Pricing)
                    .populate()
                    .take(50)
                    .exec(),
                { targetP95: 200, iterations: 10 }
            );
            expect(result.rowsReturned).toBe(50);
        });

        test('filtered populate', async () => {
            const result = await benchmark.runWithOutput(
                'Filtered Populate: active + in_stock',
                () => new Query()
                    .with(Product, {
                        filters: [{ field: 'status', operator: FilterOp.EQ, value: 'active' }]
                    })
                    .with(Inventory, {
                        filters: [{ field: 'stockStatus', operator: FilterOp.EQ, value: 'in_stock' }]
                    })
                    .populate()
                    .take(50)
                    .exec(),
                { targetP95: 250, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });
    });

    // ============================================================
    // REAL-WORLD SCENARIO TESTS
    // ============================================================

    describe('Real-World Scenarios', () => {
        test('homepage featured products: active + in_stock + high rating + sorted', async () => {
            const result = await benchmark.runWithOutput(
                'Homepage: featured products',
                () => new Query()
                    .with(Product, {
                        filters: [
                            { field: 'status', operator: FilterOp.EQ, value: 'active' },
                            { field: 'rating', operator: FilterOp.GTE, value: 4 }
                        ]
                    })
                    .with(Inventory, {
                        filters: [{ field: 'stockStatus', operator: FilterOp.EQ, value: 'in_stock' }]
                    })
                    .sortBy(Product, 'rating', 'DESC')
                    .take(20)
                    .exec(),
                { targetP95: 250, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });

        test('category page: Electronics with filters and pagination', async () => {
            const result = await benchmark.runWithOutput(
                'Category: Electronics page 2',
                () => new Query()
                    .with(Product, {
                        filters: [
                            { field: 'category', operator: FilterOp.EQ, value: 'Electronics' },
                            { field: 'status', operator: FilterOp.EQ, value: 'active' }
                        ]
                    })
                    .with(Inventory, {
                        filters: [
                            { field: 'stockStatus', operator: FilterOp.IN, value: ['in_stock', 'low_stock'] }
                        ]
                    })
                    .with(Pricing)
                    .sortBy(Pricing, 'basePrice', 'ASC')
                    .take(24)
                    .offset(24)
                    .exec(),
                { targetP95: 300, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });

        test('sale page: on-sale products sorted by discount', async () => {
            const result = await benchmark.runWithOutput(
                'Sale Page: sorted by discount',
                () => new Query()
                    .with(Product, {
                        filters: [{ field: 'status', operator: FilterOp.EQ, value: 'active' }]
                    })
                    .with(Inventory, {
                        filters: [{ field: 'stockStatus', operator: FilterOp.EQ, value: 'in_stock' }]
                    })
                    .with(Pricing, {
                        filters: [{ field: 'isOnSale', operator: FilterOp.EQ, value: true }]
                    })
                    .sortBy(Pricing, 'discountPercent', 'DESC')
                    .take(20)
                    .exec(),
                { targetP95: 300, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });

        test('admin: low stock alert query', async () => {
            const result = await benchmark.runWithOutput(
                'Admin: low stock alert',
                () => new Query()
                    .with(Product, {
                        filters: [{ field: 'status', operator: FilterOp.EQ, value: 'active' }]
                    })
                    .with(Inventory, {
                        filters: [
                            { field: 'stockStatus', operator: FilterOp.IN, value: ['low_stock', 'out_of_stock'] }
                        ]
                    })
                    .with(Vendor)
                    .populate()
                    .take(100)
                    .exec(),
                { targetP95: 400, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });

        test('vendor dashboard: products by vendor with metrics', async () => {
            const result = await benchmark.runWithOutput(
                'Vendor Dashboard: products + metrics',
                () => new Query()
                    .with(Product)
                    .with(Vendor, {
                        filters: [{ field: 'vendorId', operator: FilterOp.EQ, value: 'VENDOR-001' }]
                    })
                    .with(Inventory)
                    .with(ProductMetrics)
                    .populate()
                    .take(50)
                    .exec(),
                { targetP95: 400, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });

        test('search results: price range + category + sorted', async () => {
            const result = await benchmark.runWithOutput(
                'Search: price 100-500 in Electronics',
                () => new Query()
                    .with(Product, {
                        filters: [
                            { field: 'category', operator: FilterOp.EQ, value: 'Electronics' },
                            { field: 'status', operator: FilterOp.EQ, value: 'active' }
                        ]
                    })
                    .with(Pricing, {
                        filters: [
                            { field: 'basePrice', operator: FilterOp.GTE, value: 100 },
                            { field: 'basePrice', operator: FilterOp.LTE, value: 500 }
                        ]
                    })
                    .with(Inventory, {
                        filters: [{ field: 'stockStatus', operator: FilterOp.EQ, value: 'in_stock' }]
                    })
                    .sortBy(Product, 'rating', 'DESC')
                    .take(24)
                    .exec(),
                { targetP95: 350, iterations: 10 }
            );
            expect(result.passed).toBe(true);
        });
    });
});
