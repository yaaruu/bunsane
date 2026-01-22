/**
 * Stress test components with indexed fields for benchmarking
 */
import { BaseComponent } from '../../../core/components/BaseComponent';
import { Component, CompData } from '../../../core/components/Decorators';
import { IndexedField } from '../../../core/decorators/IndexedField';

@Component
export class StressUser extends BaseComponent {
    @CompData({ indexed: true })
    @IndexedField('btree')
    name!: string;

    @CompData({ indexed: true })
    @IndexedField('btree')
    email!: string;

    @CompData()
    @IndexedField('numeric')
    age!: number;

    @CompData()
    @IndexedField('btree')
    status!: string;

    @CompData()
    @IndexedField('numeric')
    score!: number;

    @CompData()
    @IndexedField('btree', true)
    createdAt!: Date;
}

@Component
export class StressProfile extends BaseComponent {
    @CompData()
    bio!: string;

    @CompData()
    avatarUrl!: string;

    @CompData()
    @IndexedField('gin')
    verified!: boolean;
}

@Component
export class StressSettings extends BaseComponent {
    @CompData()
    theme!: string;

    @CompData()
    notifications!: boolean;

    @CompData()
    language!: string;
}
