/**
 * Test component representing a user
 */
import { BaseComponent } from '../../../core/components/BaseComponent';
import { Component, CompData } from '../../../core/components/Decorators';

@Component
export class TestUser extends BaseComponent {
    @CompData({ indexed: true })
    name!: string;

    @CompData({ indexed: true })
    email!: string;

    @CompData()
    age!: number;

    @CompData({ nullable: true })
    bio?: string;
}
