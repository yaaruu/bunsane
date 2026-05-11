import { ComponentRegistry } from "../components";
import { logger as MainLogger } from "../Logger";
import { preparedStatementCache } from "../../database/PreparedStatementCache";
import db from "../../database";

const logger = MainLogger.child({ scope: "App" });

export async function warmUpPreparedStatementCache(_app: any): Promise<void> {
    const components = ComponentRegistry.getComponents();

    if (components.length === 0) {
        logger.trace("No components registered yet, skipping cache warm-up");
        return;
    }

    const commonQueries: Array<{ sql: string; key: string }> = [];

    commonQueries.push({
        sql: "SELECT COUNT(*) as count FROM (SELECT DISTINCT ec.entity_id as id FROM entity_components ec WHERE ec.deleted_at IS NULL) AS subquery",
        key: "count_all_entities",
    });

    for (let i = 0; i < Math.min(5, components.length); i++) {
        const component = components[i];
        if (component) {
            const { name } = component;
            const typeId = ComponentRegistry.getComponentId(name);
            if (typeId) {
                commonQueries.push({
                    sql: `SELECT DISTINCT ec.entity_id as id FROM entity_components ec WHERE ec.type_id = '${typeId}' AND ec.deleted_at IS NULL LIMIT 10`,
                    key: `find_${name.toLowerCase()}_sample`,
                });
            }
        }
    }

    if (components.length >= 2) {
        const typeIds = components
            .slice(0, 3)
            .map((component: { name: string; ctor: any }) =>
                ComponentRegistry.getComponentId(component.name)
            )
            .filter((id: string | undefined) => id)
            .join("','");

        if (typeIds) {
            commonQueries.push({
                sql: `SELECT DISTINCT ec.entity_id as id FROM entity_components ec WHERE ec.type_id IN ('${typeIds}') AND ec.deleted_at IS NULL LIMIT 10`,
                key: "find_multi_component_sample",
            });
        }
    }

    await preparedStatementCache.warmUp(commonQueries, db);
}
