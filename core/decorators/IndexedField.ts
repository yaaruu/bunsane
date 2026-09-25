import { getMetadataStorage } from '../metadata';

/**
 * Marks a component field for a dedicated database index.
 *
 * @param indexType
 *   - 'gin': GIN index on `data->field` for JSONB containment (default). Not a sort key.
 *   - 'btree': key index `(<key expr>, entity_id) WHERE deleted_at IS NULL`. Serves equality, sort, and keyset in either direction.
 *   - 'hash': HASH index on `data->>'field'` for exact equality. Not a sort key.
 *   - 'numeric': key index on `bunsane_num_v1(data->>'field')`. Non-numeric text is NULL, never a cast error.
 *   - 'fulltext': GIN tsvector index. Not a sort key.
 * @param isDateField Recorded on the field. It does not change the index expression:
 *   btree and numeric are key indexes, and a date is indexed as text (`data->>'field'`), same as any other btree key.
 */
export function IndexedField(indexType: 'gin' | 'btree' | 'hash' | 'numeric' | 'fulltext' = 'gin', isDateField: boolean = false) {
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
