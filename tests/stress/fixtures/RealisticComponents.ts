/**
 * Realistic E-commerce Components for Stress Testing
 *
 * These components simulate a real-world e-commerce scenario with:
 * - Products with metadata
 * - Inventory tracking
 * - Pricing with discounts
 * - Vendor relationships
 * - Analytics/metrics
 */
import { BaseComponent } from '../../../core/components/BaseComponent';
import { Component, CompData } from '../../../core/components/Decorators';
import { IndexedField } from '../../../core/decorators/IndexedField';

/**
 * Product component - core product information
 */
@Component
export class Product extends BaseComponent {
    @CompData({ indexed: true })
    @IndexedField('btree')
    name!: string;

    @CompData({ indexed: true })
    @IndexedField('btree')
    sku!: string;

    @CompData()
    description!: string;

    @CompData({ indexed: true })
    @IndexedField('btree')
    category!: string;

    @CompData()
    @IndexedField('btree')
    subcategory!: string;

    @CompData()
    tags!: string[];

    @CompData({ indexed: true })
    @IndexedField('btree')
    status!: 'active' | 'inactive' | 'discontinued' | 'pending';

    @CompData()
    @IndexedField('numeric')
    rating!: number;

    @CompData()
    @IndexedField('numeric')
    reviewCount!: number;

    @CompData()
    @IndexedField('btree', true)
    createdAt!: Date;

    @CompData()
    @IndexedField('btree', true)
    updatedAt!: Date;
}

/**
 * Inventory component - stock tracking
 */
@Component
export class Inventory extends BaseComponent {
    @CompData()
    @IndexedField('numeric')
    quantity!: number;

    @CompData()
    @IndexedField('numeric')
    reservedQuantity!: number;

    @CompData()
    @IndexedField('btree')
    warehouseId!: string;

    @CompData()
    @IndexedField('numeric')
    reorderPoint!: number;

    @CompData()
    @IndexedField('numeric')
    maxStock!: number;

    @CompData({ indexed: true })
    @IndexedField('btree')
    stockStatus!: 'in_stock' | 'low_stock' | 'out_of_stock' | 'backordered';

    @CompData()
    @IndexedField('btree', true)
    lastRestocked!: Date;
}

/**
 * Pricing component - price and discount information
 */
@Component
export class Pricing extends BaseComponent {
    @CompData()
    @IndexedField('numeric')
    basePrice!: number;

    @CompData()
    @IndexedField('numeric')
    salePrice!: number;

    @CompData()
    @IndexedField('numeric')
    costPrice!: number;

    @CompData()
    @IndexedField('btree')
    currency!: string;

    @CompData()
    @IndexedField('numeric')
    discountPercent!: number;

    @CompData({ indexed: true })
    @IndexedField('gin')
    isOnSale!: boolean;

    @CompData()
    @IndexedField('btree', true)
    saleStartDate!: Date | null;

    @CompData()
    @IndexedField('btree', true)
    saleEndDate!: Date | null;

    @CompData()
    @IndexedField('numeric')
    profit!: number;
}

/**
 * Vendor component - supplier/seller information
 */
@Component
export class Vendor extends BaseComponent {
    @CompData({ indexed: true })
    @IndexedField('btree')
    vendorId!: string;

    @CompData({ indexed: true })
    @IndexedField('btree')
    vendorName!: string;

    @CompData()
    @IndexedField('btree')
    region!: string;

    @CompData()
    @IndexedField('numeric')
    vendorRating!: number;

    @CompData({ indexed: true })
    @IndexedField('gin')
    isVerified!: boolean;

    @CompData()
    @IndexedField('numeric')
    totalSales!: number;

    @CompData()
    @IndexedField('btree')
    tier!: 'bronze' | 'silver' | 'gold' | 'platinum';
}

/**
 * ProductMetrics component - analytics data
 */
@Component
export class ProductMetrics extends BaseComponent {
    @CompData()
    @IndexedField('numeric')
    viewCount!: number;

    @CompData()
    @IndexedField('numeric')
    purchaseCount!: number;

    @CompData()
    @IndexedField('numeric')
    cartAddCount!: number;

    @CompData()
    @IndexedField('numeric')
    wishlistCount!: number;

    @CompData()
    @IndexedField('numeric')
    returnCount!: number;

    @CompData()
    @IndexedField('numeric')
    conversionRate!: number;

    @CompData()
    @IndexedField('btree', true)
    lastPurchased!: Date | null;

    @CompData()
    @IndexedField('btree')
    popularityScore!: string;
}

// Categories for realistic data generation
export const CATEGORIES = [
    'Electronics', 'Clothing', 'Home & Garden', 'Sports', 'Books',
    'Toys', 'Beauty', 'Automotive', 'Food', 'Health'
] as const;

export const SUBCATEGORIES: Record<string, string[]> = {
    'Electronics': ['Smartphones', 'Laptops', 'Tablets', 'Accessories', 'Audio'],
    'Clothing': ['Men', 'Women', 'Kids', 'Shoes', 'Accessories'],
    'Home & Garden': ['Furniture', 'Decor', 'Kitchen', 'Garden', 'Bedding'],
    'Sports': ['Fitness', 'Outdoor', 'Team Sports', 'Water Sports', 'Winter'],
    'Books': ['Fiction', 'Non-Fiction', 'Technical', 'Children', 'Comics'],
    'Toys': ['Action Figures', 'Board Games', 'Educational', 'Outdoor', 'Puzzles'],
    'Beauty': ['Skincare', 'Makeup', 'Haircare', 'Fragrance', 'Tools'],
    'Automotive': ['Parts', 'Accessories', 'Tools', 'Care', 'Electronics'],
    'Food': ['Snacks', 'Beverages', 'Organic', 'International', 'Specialty'],
    'Health': ['Vitamins', 'Supplements', 'Personal Care', 'Medical', 'Fitness']
};

export const REGIONS = ['North', 'South', 'East', 'West', 'Central', 'International'];
export const WAREHOUSES = ['WH-001', 'WH-002', 'WH-003', 'WH-004', 'WH-005'];
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD'];
export const VENDOR_TIERS = ['bronze', 'silver', 'gold', 'platinum'] as const;
export const PRODUCT_STATUSES = ['active', 'inactive', 'discontinued', 'pending'] as const;
export const STOCK_STATUSES = ['in_stock', 'low_stock', 'out_of_stock', 'backordered'] as const;
