/**
 * E-commerce Components for Benchmark Testing
 *
 * Defines benchmark-specific components with indexed foreign keys
 * for testing query performance across relationships.
 */
import { BaseComponent } from '../../../core/components/BaseComponent';
import { Component, CompData } from '../../../core/components/Decorators';
import { IndexedField } from '../../../core/decorators/IndexedField';

/**
 * BenchUser - User profile component
 */
@Component
export class BenchUser extends BaseComponent {
    @CompData({ indexed: true })
    @IndexedField('btree')
    email!: string;

    @CompData({ indexed: true })
    @IndexedField('btree')
    username!: string;

    @CompData()
    firstName!: string;

    @CompData()
    lastName!: string;

    @CompData({ indexed: true })
    @IndexedField('btree')
    status!: 'active' | 'inactive' | 'suspended';

    @CompData({ indexed: true })
    @IndexedField('btree')
    tier!: 'free' | 'basic' | 'premium' | 'enterprise';

    @CompData()
    @IndexedField('btree')
    region!: string;

    @CompData()
    @IndexedField('numeric')
    orderCount!: number;

    @CompData()
    @IndexedField('numeric')
    totalSpent!: number;

    @CompData()
    @IndexedField('btree', true)
    createdAt!: Date;

    @CompData()
    @IndexedField('btree', true)
    lastLoginAt!: Date | null;
}

/**
 * BenchProduct - Product catalog component
 */
@Component
export class BenchProduct extends BaseComponent {
    @CompData({ indexed: true })
    @IndexedField('btree')
    sku!: string;

    @CompData({ indexed: true })
    @IndexedField('btree')
    name!: string;

    @CompData()
    description!: string;

    @CompData({ indexed: true })
    @IndexedField('btree')
    category!: string;

    @CompData()
    @IndexedField('btree')
    subcategory!: string;

    @CompData({ indexed: true })
    @IndexedField('btree')
    brand!: string;

    @CompData()
    @IndexedField('numeric')
    price!: number;

    @CompData()
    @IndexedField('numeric')
    cost!: number;

    @CompData()
    @IndexedField('numeric')
    stock!: number;

    @CompData({ indexed: true })
    @IndexedField('btree')
    status!: 'active' | 'inactive' | 'discontinued';

    @CompData()
    @IndexedField('numeric')
    rating!: number;

    @CompData()
    @IndexedField('numeric')
    reviewCount!: number;

    @CompData()
    @IndexedField('btree', true)
    createdAt!: Date;
}

/**
 * BenchOrder - Order transaction component
 */
@Component
export class BenchOrder extends BaseComponent {
    @CompData({ indexed: true })
    @IndexedField('btree')
    userId!: string;  // Foreign key to BenchUser entity

    @CompData({ indexed: true })
    @IndexedField('btree')
    orderNumber!: string;

    @CompData({ indexed: true })
    @IndexedField('btree')
    status!: 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';

    @CompData()
    @IndexedField('numeric')
    subtotal!: number;

    @CompData()
    @IndexedField('numeric')
    tax!: number;

    @CompData()
    @IndexedField('numeric')
    shipping!: number;

    @CompData()
    @IndexedField('numeric')
    total!: number;

    @CompData()
    @IndexedField('numeric')
    itemCount!: number;

    @CompData({ indexed: true })
    @IndexedField('btree')
    paymentMethod!: 'card' | 'paypal' | 'bank' | 'crypto';

    @CompData()
    @IndexedField('btree')
    shippingRegion!: string;

    @CompData()
    @IndexedField('btree', true)
    orderedAt!: Date;

    @CompData()
    @IndexedField('btree', true)
    shippedAt!: Date | null;

    @CompData()
    @IndexedField('btree', true)
    deliveredAt!: Date | null;
}

/**
 * BenchOrderItem - Line items in an order
 */
@Component
export class BenchOrderItem extends BaseComponent {
    @CompData({ indexed: true })
    @IndexedField('btree')
    orderId!: string;  // Foreign key to BenchOrder entity

    @CompData({ indexed: true })
    @IndexedField('btree')
    productId!: string;  // Foreign key to BenchProduct entity

    @CompData({ indexed: true })
    @IndexedField('btree')
    userId!: string;  // Denormalized for faster user order queries

    @CompData()
    @IndexedField('numeric')
    quantity!: number;

    @CompData()
    @IndexedField('numeric')
    unitPrice!: number;

    @CompData()
    @IndexedField('numeric')
    discount!: number;

    @CompData()
    @IndexedField('numeric')
    total!: number;

    @CompData()
    @IndexedField('btree')
    status!: 'pending' | 'fulfilled' | 'returned' | 'refunded';
}

/**
 * BenchReview - Product review component
 */
@Component
export class BenchReview extends BaseComponent {
    @CompData({ indexed: true })
    @IndexedField('btree')
    productId!: string;  // Foreign key to BenchProduct entity

    @CompData({ indexed: true })
    @IndexedField('btree')
    userId!: string;  // Foreign key to BenchUser entity

    @CompData()
    @IndexedField('numeric')
    rating!: number;  // 1-5

    @CompData()
    title!: string;

    @CompData()
    content!: string;

    @CompData({ indexed: true })
    @IndexedField('gin')
    verified!: boolean;

    @CompData()
    @IndexedField('numeric')
    helpfulCount!: number;

    @CompData()
    @IndexedField('btree', true)
    createdAt!: Date;
}

// Constants for data generation
export const USER_TIERS = ['free', 'basic', 'premium', 'enterprise'] as const;
export const USER_STATUSES = ['active', 'inactive', 'suspended'] as const;
export const PRODUCT_STATUSES = ['active', 'inactive', 'discontinued'] as const;
export const ORDER_STATUSES = ['pending', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'] as const;
export const ORDER_ITEM_STATUSES = ['pending', 'fulfilled', 'returned', 'refunded'] as const;
export const PAYMENT_METHODS = ['card', 'paypal', 'bank', 'crypto'] as const;

export const REGIONS = [
    'North America', 'Europe', 'Asia Pacific', 'Latin America',
    'Middle East', 'Africa', 'Oceania'
];

export const CATEGORIES = [
    'Electronics', 'Clothing', 'Home & Garden', 'Sports', 'Books',
    'Toys', 'Beauty', 'Automotive', 'Food', 'Health'
];

export const SUBCATEGORIES: Record<string, string[]> = {
    'Electronics': ['Smartphones', 'Laptops', 'Tablets', 'Accessories', 'Audio', 'Cameras'],
    'Clothing': ['Men', 'Women', 'Kids', 'Shoes', 'Accessories', 'Athletic'],
    'Home & Garden': ['Furniture', 'Decor', 'Kitchen', 'Garden', 'Bedding', 'Lighting'],
    'Sports': ['Fitness', 'Outdoor', 'Team Sports', 'Water Sports', 'Winter', 'Cycling'],
    'Books': ['Fiction', 'Non-Fiction', 'Technical', 'Children', 'Comics', 'Academic'],
    'Toys': ['Action Figures', 'Board Games', 'Educational', 'Outdoor', 'Puzzles', 'Dolls'],
    'Beauty': ['Skincare', 'Makeup', 'Haircare', 'Fragrance', 'Tools', 'Mens'],
    'Automotive': ['Parts', 'Accessories', 'Tools', 'Care', 'Electronics', 'Safety'],
    'Food': ['Snacks', 'Beverages', 'Organic', 'International', 'Specialty', 'Supplements'],
    'Health': ['Vitamins', 'Supplements', 'Personal Care', 'Medical', 'Fitness', 'Wellness']
};

export const BRANDS = [
    'TechCorp', 'StyleMax', 'HomeEssentials', 'SportPro', 'BookHouse',
    'ToyWorld', 'BeautyGlow', 'AutoParts', 'FreshFoods', 'HealthPlus',
    'GadgetZone', 'FashionHub', 'ComfortLiving', 'ActiveLife', 'PageTurner'
];
