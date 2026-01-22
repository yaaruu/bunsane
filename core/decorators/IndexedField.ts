import { getMetadataStorage } from '../metadata';

/**
 * Decorator to mark component fields that should have dedicated database indexes
 * This is used for frequently filtered fields to improve query performance
 *
 * @param indexType The type of index to create:
 *   - 'gin': GIN index for JSONB containment queries (default)
 *   - 'btree': BTREE index for equality and text comparisons
 *   - 'hash': HASH index for exact equality lookups
 *   - 'numeric': BTREE index with numeric cast for range queries (>, <, BETWEEN)
 * @param isDateField Whether this field contains date values (affects BTREE index casting)
 */
export function IndexedField(indexType: 'gin' | 'btree' | 'hash' | 'numeric' = 'gin', isDateField: boolean = false) {
    return function(target: any, propertyKey: string) {
        const storage = getMetadataStorage();
        const componentId = storage.getComponentId(target.constructor.name);

        storage.collectIndexedFieldMetadata({
            componentId,
            propertyKey,
            indexType,
            isDateField
        });
    };
}
