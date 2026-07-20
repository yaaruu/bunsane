/**
 * Out-of-band `components` write-path audit (RFC section 6.3)
 *
 * Canonical path (through core/entity/saveEntity.ts - will receive the P2 projection hook):
 * - core/entity/saveEntity.ts:214  DELETE FROM components ... type_id IN ...  (doSave: replace)
 * - core/entity/saveEntity.ts:272  INSERT INTO components ...                 (doSave: insert)
 * - core/entity/saveEntity.ts:298  INSERT INTO components ... ON CONFLICT DO UPDATE (doSave: update)
 * - core/entity/saveEntity.ts:337  DELETE FROM components WHERE entity_id ...  (doDelete: hard delete)
 * - core/entity/saveEntity.ts:341  UPDATE components SET deleted_at ...        (doDelete: soft delete)
 *
 * OUT-OF-BAND (bypass Entity.save/doDelete - MUST be routed or declared projection-incompatible in P2):
 * - core/components/BaseComponent.ts:114-125  insert(trx, entity_id): direct `INSERT INTO components`
 *     - public single-component write surface; bypasses the Entity.save projection hook.
 * - core/components/BaseComponent.ts:127-132  update(trx): direct `UPDATE components SET data`
 *     - public single-component write surface; bypasses the projection hook.
 * - endpoints/archetypes.ts:323-326  REST bulk-delete endpoint: `DELETE FROM components WHERE entity_id IN (...)`
 *     then DELETE FROM entities. Hard delete with NO soft-delete and NO doDelete hook - will bypass
 *     projection delete maintenance entirely.
 *
 * Test/seed-only (NOT production write paths; listed for completeness, not a maintenance concern):
 * - tests/stress/DataSeeder.ts:84,137 ; tests/benchmark/scripts/generate-db.ts:142 ;
 *   tests/perf/p0-ceiling-proof.test.ts:136,157 ; plus various integration tests that directly
 *   UPDATE/DELETE components.
 */
import { getMetadataStorage } from '../../core/metadata';
import { computeShapeHash } from './ShapeHasher';
import type { ProjectedColumn, ProjectionDescriptor, ProjectionSqlType } from './types';

const snakeCase = (input: string): string => {
    let name = input;
    if (name !== 'Component' && name.endsWith('Component')) {
        name = name.slice(0, -'Component'.length);
    }
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .toLowerCase();
};

const mapSqlType = (prop: { propertyType?: any }): ProjectionSqlType => {
    if (prop.propertyType === Number) return 'numeric';
    if (prop.propertyType === Date) return 'timestamptz';
    if (prop.propertyType === Boolean) return 'boolean';
    return 'text';
};

type MetadataStorageLike = ReturnType<typeof getMetadataStorage>;

/**
 * The single projectability predicate. `deriveProjectedColumns` (which columns exist) and
 * `fullyColumnarComponents` (which components are safe to hydrate FROM those columns) MUST
 * agree exactly — if they drift, a component whose field was silently skipped here would be
 * served from rm_ with that field missing. Keep this the only place the rule is expressed.
 */
const isProjectableProp = (prop: { arrayOf?: any; isPrimitive?: boolean; isEnum?: boolean }): boolean => {
    if (prop.arrayOf) return false;
    return prop.isPrimitive === true || prop.isEnum === true;
};

const archetypeComponentNames = (
    archetypeName: string,
    storage: MetadataStorageLike
): string[] => {
    const metaComponentNames = storage.archetypes.find(a => a.name === archetypeName)?.componentNames;
    if (metaComponentNames && metaComponentNames.length > 0) return metaComponentNames;

    const fields = storage.archetypes_field_map.get(archetypeName) || [];
    return Array.from(
        new Set(fields.map(field => field.component?.name).filter(Boolean))
    ) as string[];
};

export const deriveProjectedColumns = (
    archetypeName: string,
    storage: MetadataStorageLike = getMetadataStorage()
): ProjectedColumn[] => {
    const componentNames = archetypeComponentNames(archetypeName, storage);

    const columns: ProjectedColumn[] = [];
    for (const componentName of componentNames) {
        const typeId = storage.getComponentId(componentName);
        for (const prop of storage.getComponentProperties(typeId)) {
            if (!isProjectableProp(prop)) continue;
            const isScalarEnum = prop.isEnum === true;
            const sqlType = isScalarEnum ? 'text' : mapSqlType(prop);

            columns.push({
                component: componentName,
                field: prop.propertyKey,
                sqlType,
                columnName: `${snakeCase(componentName)}_${snakeCase(prop.propertyKey)}`,
            });
        }
    }

    return columns.sort((a, b) => {
        const componentCmp = a.component.localeCompare(b.component);
        if (componentCmp !== 0) return componentCmp;
        return a.field.localeCompare(b.field);
    });
};

/**
 * F1 gate — components whose ENTIRE `@CompData` surface is projected, i.e. safe to rebuild
 * from an `rm_` row alone.
 *
 * Coverage matches at COMPONENT-SET level (`SurfacePlanner.isCovered`) while projection is
 * lossy at FIELD level: a component with one scalar and one array field passes coverage but
 * has no column for the array. Hydrating it from the row would silently yield a component
 * missing that field. Only components listed here may be served from `rm_`; everything else
 * falls back to the `components` read PER COMPONENT (not per query).
 *
 * A component with zero projectable fields is NOT fully columnar (it emits no columns and
 * drops out of the descriptor set entirely).
 */
export const fullyColumnarComponents = (
    archetypeName: string,
    storage: MetadataStorageLike = getMetadataStorage()
): Set<string> => {
    const result = new Set<string>();
    for (const componentName of archetypeComponentNames(archetypeName, storage)) {
        const typeId = storage.getComponentId(componentName);
        const props = storage.getComponentProperties(typeId);
        if (props.length === 0) continue;
        if (props.every(isProjectableProp)) result.add(componentName);
    }
    return result;
};

export const deriveProjectionDescriptor = (
    archetypeName: string,
    storage: MetadataStorageLike = getMetadataStorage()
): ProjectionDescriptor => {
    const columns = deriveProjectedColumns(archetypeName, storage);
    return {
        archetype: archetypeName,
        columns,
        shapeHash: computeShapeHash(columns),
        shapeVersion: 1,
    };
};

