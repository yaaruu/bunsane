/**
 * Tracks entity IDs during benchmark seeding for foreign key references.
 *
 * Provides methods to retrieve random IDs for establishing relationships
 * between entities (User -> Order -> OrderItem, Product -> Review, etc.)
 */
import type { SeededRandom } from './EcommerceDataGenerators';

export class RelationTracker {
    private userIds: string[] = [];
    private productIds: string[] = [];
    private orderIds: string[] = [];
    private orderUserMap: Map<string, string> = new Map();

    /**
     * Add a user ID to the tracker
     */
    addUser(entityId: string): void {
        this.userIds.push(entityId);
    }

    /**
     * Add multiple user IDs
     */
    addUsers(entityIds: string[]): void {
        this.userIds.push(...entityIds);
    }

    /**
     * Add a product ID to the tracker
     */
    addProduct(entityId: string): void {
        this.productIds.push(entityId);
    }

    /**
     * Add multiple product IDs
     */
    addProducts(entityIds: string[]): void {
        this.productIds.push(...entityIds);
    }

    /**
     * Add an order ID with its associated user ID
     */
    addOrder(entityId: string, userId: string): void {
        this.orderIds.push(entityId);
        this.orderUserMap.set(entityId, userId);
    }

    /**
     * Add multiple order IDs (without user mapping - use addOrder for relationship tracking)
     */
    addOrders(entityIds: string[]): void {
        this.orderIds.push(...entityIds);
    }

    /**
     * Get a random user ID using the provided RNG
     */
    getRandomUserId(rng: SeededRandom): string {
        if (this.userIds.length === 0) {
            throw new Error('No user IDs available. Seed users first.');
        }
        return this.userIds[Math.floor(rng.next() * this.userIds.length)]!;
    }

    /**
     * Get a random product ID using the provided RNG
     */
    getRandomProductId(rng: SeededRandom): string {
        if (this.productIds.length === 0) {
            throw new Error('No product IDs available. Seed products first.');
        }
        return this.productIds[Math.floor(rng.next() * this.productIds.length)]!;
    }

    /**
     * Get a random order ID using the provided RNG
     */
    getRandomOrderId(rng: SeededRandom): string {
        if (this.orderIds.length === 0) {
            throw new Error('No order IDs available. Seed orders first.');
        }
        return this.orderIds[Math.floor(rng.next() * this.orderIds.length)]!;
    }

    /**
     * Get the user ID associated with an order
     */
    getOrderUserId(orderId: string): string | undefined {
        return this.orderUserMap.get(orderId);
    }

    /**
     * Get user IDs with power-law distribution (some users more active)
     */
    getActiveUserId(rng: SeededRandom): string {
        if (this.userIds.length === 0) {
            throw new Error('No user IDs available. Seed users first.');
        }
        // Power-law: top 20% of users are selected 80% of the time
        const idx = Math.floor(Math.pow(rng.next(), 2) * this.userIds.length);
        return this.userIds[idx]!;
    }

    /**
     * Get product IDs with power-law distribution (popular products)
     */
    getPopularProductId(rng: SeededRandom): string {
        if (this.productIds.length === 0) {
            throw new Error('No product IDs available. Seed products first.');
        }
        const idx = Math.floor(Math.pow(rng.next(), 1.5) * this.productIds.length);
        return this.productIds[idx]!;
    }

    /**
     * Get counts for reporting
     */
    getCounts(): { users: number; products: number; orders: number } {
        return {
            users: this.userIds.length,
            products: this.productIds.length,
            orders: this.orderIds.length
        };
    }

    /**
     * Get all user IDs (for batch operations)
     */
    getAllUserIds(): string[] {
        return [...this.userIds];
    }

    /**
     * Get all product IDs (for batch operations)
     */
    getAllProductIds(): string[] {
        return [...this.productIds];
    }

    /**
     * Get all order IDs (for batch operations)
     */
    getAllOrderIds(): string[] {
        return [...this.orderIds];
    }

    /**
     * Clear all tracked IDs
     */
    clear(): void {
        this.userIds = [];
        this.productIds = [];
        this.orderIds = [];
        this.orderUserMap.clear();
    }
}
