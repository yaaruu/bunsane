/**
 * Test archetype for user entities
 */
import { BaseArcheType, ArcheType, ArcheTypeField } from '../../../core/ArcheType';
import { TestUser } from '../components/TestUser';
import { TestOrder } from '../components/TestOrder';

@ArcheType({ name: 'TestUserArchetype' })
export class TestUserArchetype extends BaseArcheType {
    @ArcheTypeField(TestUser)
    user!: TestUser;
}

@ArcheType({ name: 'TestUserWithOrdersArchetype' })
export class TestUserWithOrdersArchetype extends BaseArcheType {
    @ArcheTypeField(TestUser)
    user!: TestUser;

    @ArcheTypeField(TestOrder)
    order!: TestOrder;
}
