import { getMetadataStorage } from '../metadata';

/**
 * Decorator to mark component fields that should have dedicated database indexes
 * This is used for frequently filtered fields to improve query performance
 *
 * @param indexType The type of index to create ('gin' | 'btree' | 'hash')
 * @param isDateField Whether this field contains date values (affects BTREE index casting)
 */
export function IndexedField(indexType: 'gin' | 'btree' | 'hash' = 'gin', isDateField: boolean = false) {
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