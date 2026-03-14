/**
 * Data generators for benchmark e-commerce components.
 *
 * Uses deterministic seeding for reproducible data generation.
 * Implements realistic distributions (power-law, exponential).
 */
import {
    USER_TIERS, USER_STATUSES, PRODUCT_STATUSES, ORDER_STATUSES,
    ORDER_ITEM_STATUSES, PAYMENT_METHODS, REGIONS, CATEGORIES,
    SUBCATEGORIES, BRANDS
} from './EcommerceComponents';
import type { RelationTracker } from './RelationTracker';

/**
 * Seeded random number generator (Mulberry32)
 */
export class SeededRandom {
    private state: number;

    constructor(seed: number) {
        this.state = seed;
    }

    next(): number {
        let t = this.state += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }

    nextInt(min: number, max: number): number {
        return Math.floor(this.next() * (max - min + 1)) + min;
    }

    pick<T>(arr: readonly T[]): T {
        return arr[Math.floor(this.next() * arr.length)]!;
    }

    pickWeighted<T>(arr: readonly T[], weights: number[]): T {
        const total = weights.reduce((a, b) => a + b, 0);
        let r = this.next() * total;
        for (let i = 0; i < arr.length; i++) {
            r -= weights[i]!;
            if (r <= 0) return arr[i]!;
        }
        return arr[arr.length - 1]!;
    }

    /**
     * Power-law distribution (Pareto-like)
     * Used for category popularity, user activity, etc.
     */
    powerLaw(min: number, max: number, alpha: number = 1.5): number {
        const u = this.next();
        const minP = Math.pow(min, 1 - alpha);
        const maxP = Math.pow(max, 1 - alpha);
        return Math.pow((maxP - minP) * u + minP, 1 / (1 - alpha));
    }

    /**
     * Exponential distribution
     * Used for order frequency, review counts, etc.
     */
    exponential(lambda: number = 1): number {
        return -Math.log(1 - this.next()) / lambda;
    }
}

const FIRST_NAMES = [
    'James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer', 'Michael', 'Linda',
    'William', 'Elizabeth', 'David', 'Barbara', 'Richard', 'Susan', 'Joseph', 'Jessica',
    'Thomas', 'Sarah', 'Charles', 'Karen', 'Christopher', 'Lisa', 'Daniel', 'Nancy',
    'Alex', 'Emma', 'Olivia', 'Liam', 'Noah', 'Ava', 'Sophia', 'Isabella'
];

const LAST_NAMES = [
    'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
    'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson',
    'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson', 'White'
];

const ADJECTIVES = [
    'Premium', 'Professional', 'Ultra', 'Classic', 'Essential', 'Advanced',
    'Pro', 'Elite', 'Basic', 'Standard', 'Deluxe', 'Supreme', 'Ultimate'
];

const PRODUCT_NOUNS = [
    'Widget', 'Device', 'Tool', 'Kit', 'Set', 'Pack', 'Bundle',
    'System', 'Unit', 'Module', 'Gear', 'Equipment', 'Accessory'
];

const REVIEW_TITLES = [
    'Great product!', 'Exactly what I needed', 'Highly recommended',
    'Good value', 'Works perfectly', 'Exceeded expectations',
    'Not bad', 'Could be better', 'Disappointed', 'Amazing quality',
    'Fast shipping', 'Would buy again', 'Perfect fit', 'Love it'
];

const REVIEW_CONTENT_TEMPLATES = [
    'This product is exactly what I was looking for. {adj} quality and {adj2} performance.',
    'I\'ve been using this for {weeks} weeks now and it\'s been {adj}.',
    'The {feature} is really {adj}. Would recommend to anyone looking for a {type}.',
    'Shipping was fast and the product arrived in perfect condition. Very {adj}.',
    'For the price, this is an {adj} deal. The {feature} works great.',
    'Had some issues initially but customer support was {adj}. Now it works perfectly.',
    'Compared to other {type}s I\'ve tried, this one is by far the most {adj}.',
    'The build quality is {adj}. Feels {adj2} in hand.'
];

/**
 * Generate user data
 */
export function generateUserData(index: number, rng: SeededRandom) {
    const firstName = rng.pick(FIRST_NAMES);
    const lastName = rng.pick(LAST_NAMES);
    const username = `${firstName.toLowerCase()}${lastName.toLowerCase()}${index}`;

    // Power-law distribution for tier (most users are free)
    const tierWeights = [0.6, 0.25, 0.12, 0.03]; // free, basic, premium, enterprise
    const tier = rng.pickWeighted(USER_TIERS, tierWeights);

    // Most users are active
    const statusWeights = [0.85, 0.12, 0.03];
    const status = rng.pickWeighted(USER_STATUSES, statusWeights);

    const createdAt = new Date(Date.now() - rng.nextInt(0, 365 * 2) * 24 * 60 * 60 * 1000);
    const hasLoggedIn = rng.next() > 0.1;
    const lastLoginAt = hasLoggedIn
        ? new Date(createdAt.getTime() + rng.nextInt(0, Date.now() - createdAt.getTime()))
        : null;

    return {
        email: `${username}@example.com`,
        username,
        firstName,
        lastName,
        status,
        tier,
        region: rng.pick(REGIONS),
        orderCount: Math.floor(rng.exponential(0.1)),
        totalSpent: Math.floor(rng.exponential(0.01) * 100),
        createdAt,
        lastLoginAt
    };
}

/**
 * Generate product data
 */
export function generateProductData(index: number, rng: SeededRandom) {
    const category = rng.pick(CATEGORIES);
    const subcategories = SUBCATEGORIES[category] || ['General'];
    const subcategory = rng.pick(subcategories);
    const brand = rng.pick(BRANDS);

    const adjective = rng.pick(ADJECTIVES);
    const noun = rng.pick(PRODUCT_NOUNS);
    const name = `${brand} ${adjective} ${noun} ${subcategory}`;
    const sku = `${category.substring(0, 3).toUpperCase()}-${index.toString().padStart(6, '0')}`;

    const basePrice = Math.floor(rng.powerLaw(10, 1000, 1.2));
    const cost = Math.floor(basePrice * (0.3 + rng.next() * 0.3));

    // Power-law for stock (most products have moderate stock)
    const stock = Math.floor(rng.powerLaw(0, 1000, 1.5));

    const statusWeights = [0.85, 0.10, 0.05];
    const status = rng.pickWeighted(PRODUCT_STATUSES, statusWeights);

    return {
        sku,
        name,
        description: `${name} - High quality ${subcategory.toLowerCase()} from ${brand}. Features include premium materials and excellent craftsmanship.`,
        category,
        subcategory,
        brand,
        price: basePrice,
        cost,
        stock,
        status,
        rating: Math.round((3 + rng.next() * 2) * 10) / 10, // 3.0 - 5.0
        reviewCount: Math.floor(rng.exponential(0.05)),
        createdAt: new Date(Date.now() - rng.nextInt(0, 365 * 3) * 24 * 60 * 60 * 1000)
    };
}

/**
 * Generate order data
 */
export function generateOrderData(
    index: number,
    rng: SeededRandom,
    tracker: RelationTracker
) {
    const userId = tracker.getRandomUserId(rng);
    const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}-${index.toString().padStart(6, '0')}`;

    // Most orders are delivered
    const statusWeights = [0.05, 0.10, 0.15, 0.60, 0.07, 0.03];
    const status = rng.pickWeighted(ORDER_STATUSES, statusWeights);

    const subtotal = Math.floor(rng.powerLaw(20, 500, 1.3));
    const tax = Math.floor(subtotal * 0.08);
    const shipping = subtotal > 50 ? 0 : Math.floor(5 + rng.next() * 10);
    const total = subtotal + tax + shipping;

    const orderedAt = new Date(Date.now() - rng.nextInt(0, 365) * 24 * 60 * 60 * 1000);
    const isShipped = ['shipped', 'delivered'].includes(status);
    const shippedAt = isShipped
        ? new Date(orderedAt.getTime() + rng.nextInt(1, 5) * 24 * 60 * 60 * 1000)
        : null;
    const deliveredAt = status === 'delivered' && shippedAt
        ? new Date(shippedAt.getTime() + rng.nextInt(1, 7) * 24 * 60 * 60 * 1000)
        : null;

    return {
        userId,
        orderNumber,
        status,
        subtotal,
        tax,
        shipping,
        total,
        itemCount: rng.nextInt(1, 5),
        paymentMethod: rng.pick(PAYMENT_METHODS),
        shippingRegion: rng.pick(REGIONS),
        orderedAt,
        shippedAt,
        deliveredAt
    };
}

/**
 * Generate order item data
 */
export function generateOrderItemData(
    index: number,
    rng: SeededRandom,
    tracker: RelationTracker,
    orderId?: string,
    orderUserId?: string
) {
    const resolvedOrderId = orderId || tracker.getRandomOrderId(rng);
    const productId = tracker.getRandomProductId(rng);
    const userId = orderUserId || tracker.getOrderUserId(resolvedOrderId) || tracker.getRandomUserId(rng);

    const quantity = rng.nextInt(1, 3);
    const unitPrice = Math.floor(rng.powerLaw(10, 200, 1.3));
    const discount = rng.next() < 0.3 ? Math.floor(unitPrice * rng.next() * 0.3) : 0;
    const total = (unitPrice - discount) * quantity;

    const statusWeights = [0.10, 0.80, 0.07, 0.03];
    const status = rng.pickWeighted(ORDER_ITEM_STATUSES, statusWeights);

    return {
        orderId: resolvedOrderId,
        productId,
        userId,
        quantity,
        unitPrice,
        discount,
        total,
        status
    };
}

/**
 * Generate review data
 */
export function generateReviewData(
    index: number,
    rng: SeededRandom,
    tracker: RelationTracker
) {
    const productId = tracker.getRandomProductId(rng);
    const userId = tracker.getRandomUserId(rng);

    // Rating distribution skewed toward positive
    const ratingWeights = [0.05, 0.08, 0.15, 0.32, 0.40]; // 1-5 stars
    const rating = rng.pickWeighted([1, 2, 3, 4, 5], ratingWeights);

    const title = rng.pick(REVIEW_TITLES);
    const template = rng.pick(REVIEW_CONTENT_TEMPLATES);
    const content = template
        .replace('{adj}', rng.pick(['excellent', 'great', 'good', 'decent', 'amazing']))
        .replace('{adj2}', rng.pick(['solid', 'reliable', 'impressive', 'premium']))
        .replace('{weeks}', String(rng.nextInt(1, 12)))
        .replace('{feature}', rng.pick(['design', 'build quality', 'performance', 'value']))
        .replace('{type}', rng.pick(['product', 'item', 'device']));

    return {
        productId,
        userId,
        rating,
        title,
        content,
        verified: rng.next() > 0.3,
        helpfulCount: Math.floor(rng.exponential(0.2)),
        createdAt: new Date(Date.now() - rng.nextInt(0, 365) * 24 * 60 * 60 * 1000)
    };
}
