/**
 * Test component representing an order
 */
import { BaseComponent } from '../../../core/components/BaseComponent';
import { Component, CompData } from '../../../core/components/Decorators';

@Component
export class TestOrder extends BaseComponent {
    @CompData({ indexed: true })
    orderNumber!: string;

    @CompData()
    total!: number;

    @CompData()
    status!: string;

    @CompData()
    createdAt!: Date;

    @CompData({ nullable: true })
    notes?: string;
}
