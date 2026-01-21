/**
 * Test component representing a product
 */
import { BaseComponent } from '../../../core/components/BaseComponent';
import { Component, CompData } from '../../../core/components/Decorators';

@Component
export class TestProduct extends BaseComponent {
    @CompData({ indexed: true })
    sku!: string;

    @CompData()
    name!: string;

    @CompData()
    price!: number;

    @CompData({ nullable: true })
    description?: string;

    @CompData()
    inStock!: boolean;
}
