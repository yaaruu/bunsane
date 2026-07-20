import db from "../../database";
import { getMetadataStorage } from "../../core/metadata";
import { coerceProjectedValue } from "../../database/projection/projectEntity";
import type { ProjectedColumn } from "../../database/projection/types";
import type { RmHydrationPlan } from "./RmHydrationPlan";

export interface HydrationFieldDivergence {
    entityId: string;
    component: string;
    field: string;
    legacy: unknown;
    rm: unknown;
    legacyType: string;
    rmType: string;
    /** true when the values agree loosely but their JS types differ — the numeric-as-string canary. */
    typeOnly: boolean;
}

const jsType = (v: unknown): string => {
    if (v === null || v === undefined) return 'null';
    if (v instanceof Date) return 'Date';
    return typeof v;
};

/**
 * Compare a value served from the rm_ row against the value the legacy JSONB path would give.
 *
 * The rm side is passed through `coerceProjectedValue` first — exactly what the serving path
 * will do — so this comparison validates the coercion rules themselves rather than assuming
 * them. Notably it is what proves, or disproves, that numeric columns (which PG returns as
 * strings over the wire) come back as JS numbers.
 */
function compareValue(
    legacyRaw: unknown,
    rmRaw: unknown,
    col: ProjectedColumn,
    isDateField: boolean
): { equal: boolean; typeOnly: boolean; legacy: unknown; rm: unknown } {
    const rm = coerceProjectedValue(rmRaw, col.sqlType);

    // Legacy JSONB DROPS undefined, so an absent field reads back undefined while projection
    // stores NULL. Treat both as absent — the one intentional divergence, normalized here.
    let legacy: any = legacyRaw ?? null;
    if (isDateField && typeof legacy === 'string') legacy = new Date(legacy);

    if (legacy === null && rm === null) {
        return { equal: true, typeOnly: false, legacy, rm };
    }
    if (legacy === null || rm === null) {
        return { equal: false, typeOnly: false, legacy, rm };
    }

    if (legacy instanceof Date || rm instanceof Date) {
        const lt = legacy instanceof Date ? legacy.getTime() : new Date(legacy).getTime();
        const rt = rm instanceof Date ? rm.getTime() : new Date(rm as any).getTime();
        return { equal: lt === rt, typeOnly: false, legacy, rm };
    }

    const sameType = jsType(legacy) === jsType(rm);
    const strictEqual = legacy === rm;
    if (strictEqual) return { equal: true, typeOnly: false, legacy, rm };

    // Loosely equal but differently typed: values match, JS types drifted. Report it —
    // this is the failure mode that passes every `==` assertion and still breaks callers.
    const looselyEqual = String(legacy) === String(rm);
    if (looselyEqual && !sameType) {
        return { equal: false, typeOnly: true, legacy, rm };
    }

    return { equal: false, typeOnly: false, legacy, rm };
}

/**
 * Read the same entities through the legacy `components` path and diff every field the plan
 * would have hydrated from the row. Observation only — nothing served, nothing promoted.
 */
export async function compareHydrationParity(
    plan: RmHydrationPlan,
    rows: Array<Record<string, any>>
): Promise<HydrationFieldDivergence[]> {
    if (rows.length === 0 || plan.components.size === 0) return [];

    const storage = getMetadataStorage();
    const componentNames = [...plan.components.keys()];

    const typeIdByComponent = new Map<string, string>();
    for (const name of componentNames) {
        const typeId = storage.getComponentId(name);
        if (typeId) typeIdByComponent.set(name, typeId);
    }
    if (typeIdByComponent.size === 0) return [];

    const entityIds = rows.map(r => r.entity_id);
    const typeIds = [...typeIdByComponent.values()];

    const entityPh = entityIds.map((_, i) => `$${i + 1}`).join(', ');
    const typePh = typeIds.map((_, i) => `$${entityIds.length + i + 1}`).join(', ');
    const legacyRows: any[] = await db.unsafe(
        `SELECT entity_id, type_id, data FROM components
         WHERE entity_id IN (${entityPh}) AND type_id IN (${typePh}) AND deleted_at IS NULL`,
        [...entityIds, ...typeIds]
    );

    const legacyByKey = new Map<string, any>();
    for (const r of legacyRows) {
        const data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
        legacyByKey.set(`${r.entity_id}:${r.type_id}`, data ?? {});
    }

    // Date fields must be revived before comparison, same as the legacy loader does.
    const dateFields = new Set<string>();
    for (const [name, typeId] of typeIdByComponent) {
        for (const prop of storage.getComponentProperties(typeId)) {
            if (prop.propertyType === Date) dateFields.add(`${name}:${prop.propertyKey}`);
        }
    }

    const divergences: HydrationFieldDivergence[] = [];
    for (const row of rows) {
        for (const [componentName, columns] of plan.components) {
            const typeId = typeIdByComponent.get(componentName);
            if (!typeId) continue;
            const legacyData = legacyByKey.get(`${row.entity_id}:${typeId}`);
            if (!legacyData) continue; // membership divergence is the id-parity check's job

            for (const col of columns) {
                const isDate = dateFields.has(`${componentName}:${col.field}`);
                const cmp = compareValue(legacyData[col.field], row[col.columnName], col, isDate);
                if (cmp.equal) continue;
                divergences.push({
                    entityId: row.entity_id,
                    component: componentName,
                    field: col.field,
                    legacy: cmp.legacy,
                    rm: cmp.rm,
                    legacyType: jsType(cmp.legacy),
                    rmType: jsType(cmp.rm),
                    typeOnly: cmp.typeOnly,
                });
            }
        }
    }

    return divergences;
}
