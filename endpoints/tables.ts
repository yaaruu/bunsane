import db from "../database";
import type {
    StudioTableQueryParams,
    StudioTableResponse,
    DeleteTableRowsRequest,
    DeleteResponse,
    TableColumn,
    TableRowData,
} from "./types";

export async function handleStudioTableRequest(
    tableName: string,
    params: StudioTableQueryParams = {}
): Promise<Response> {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 1000);
    const offset = Math.max(params.offset ?? 0, 0);
    const searchTerm = params.search ?? "";

    try {
        const columnsResult = await db`
            SELECT 
                column_name,
                data_type,
                is_nullable,
                column_default
            FROM information_schema.columns
            WHERE table_name = ${tableName}
            AND table_schema = 'public'
            ORDER BY ordinal_position
        `;

        if (columnsResult.length === 0) {
            return new Response(
                JSON.stringify({ error: `Table '${tableName}' not found` }),
                {
                    status: 404,
                    headers: { "Content-Type": "application/json" },
                }
            );
        }

        const primaryKeyResult = await db`
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu 
                ON tc.constraint_name = kcu.constraint_name
                AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_name = ${tableName}
            AND tc.table_schema = 'public'
        `;
        const primaryKeyColumns = new Set(
            primaryKeyResult.map((row: { column_name: string }) => row.column_name)
        );

        const columns: TableColumn[] = columnsResult.map((col: {
            column_name: string;
            data_type: string;
            is_nullable: string;
        }) => ({
            name: col.column_name,
            type: col.data_type,
            nullable: col.is_nullable === "YES",
            primary: primaryKeyColumns.has(col.column_name),
        }));

        const textColumns = columnsResult
            .filter((col: { data_type: string }) =>
                ["character varying", "text", "varchar", "char", "uuid"].includes(col.data_type)
            )
            .map((col: { column_name: string }) => col.column_name);

        let rows: TableRowData[];
        let totalResult: { count: number }[];

        if (searchTerm && textColumns.length > 0) {
            const searchPattern = `%${searchTerm}%`;
            const searchConditions = textColumns
                .map((col: string) => `"${col}"::text ILIKE $1`)
                .join(" OR ");

            rows = await db.unsafe(
                `SELECT * FROM "${tableName}" 
                 WHERE ${searchConditions}
                 ORDER BY created_at DESC NULLS LAST
                 LIMIT $2 OFFSET $3`,
                [searchPattern, limit, offset]
            );

            totalResult = await db.unsafe(
                `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${searchConditions}`,
                [searchPattern]
            );
        } else {
            rows = await db.unsafe(
                `SELECT * FROM "${tableName}" 
                 ORDER BY created_at DESC NULLS LAST
                 LIMIT $1 OFFSET $2`,
                [limit, offset]
            );

            totalResult = await db.unsafe(
                `SELECT COUNT(*) as count FROM "${tableName}"`
            );
        }

        const total = Number(totalResult[0]?.count ?? 0);

        const responseData: StudioTableResponse = {
            name: tableName,
            columns,
            rows,
            total,
            limit,
            offset,
        };

        return new Response(JSON.stringify(responseData), {
            headers: { "Content-Type": "application/json" },
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        return new Response(
            JSON.stringify({ error: `Failed to fetch table data: ${errorMessage}` }),
            {
                status: 500,
                headers: { "Content-Type": "application/json" },
            }
        );
    }
}

export async function handleStudioTableDeleteRequest(
    tableName: string,
    requestBody: DeleteTableRowsRequest
): Promise<Response> {
    const { ids } = requestBody;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return new Response(
            JSON.stringify({ error: "ids array is required and must not be empty" }),
            {
                status: 400,
                headers: { "Content-Type": "application/json" },
            }
        );
    }

    try {
        const idPlaceholders = ids.map((_, index) => `$${index + 1}`).join(", ");

        await db.unsafe(
            `DELETE FROM "${tableName}" WHERE id IN (${idPlaceholders})`,
            ids
        );

        const deletedCount = ids.length;

        const responseData: DeleteResponse = {
            success: true,
            deletedCount,
            message: `Successfully deleted ${deletedCount} row(s) from ${tableName}`,
        };

        return new Response(JSON.stringify(responseData), {
            headers: { "Content-Type": "application/json" },
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        return new Response(
            JSON.stringify({ error: `Failed to delete rows: ${errorMessage}` }),
            {
                status: 500,
                headers: { "Content-Type": "application/json" },
            }
        );
    }
}

export async function handleGetTables(): Promise<Response> {
    try {
        // Fetch all tables except ECS tables
        const ecsTables = ['components', 'entities', 'entity_components', 'spatial_ref_sys'];
        const ecsTablePlaceholders = ecsTables.map((_, index) => `$${index + 1}`).join(", ");

        const result = await db.unsafe(
            `SELECT table_name
             FROM information_schema.tables
             WHERE table_schema = 'public'
             AND table_type = 'BASE TABLE'
             AND table_name NOT IN (${ecsTablePlaceholders})
             AND table_name NOT LIKE 'components_%'
             ORDER BY table_name`,
            ecsTables
        );

        const tables = result.map((row: { table_name: string }) => row.table_name);

        return new Response(JSON.stringify({ tables }), {
            headers: { "Content-Type": "application/json" },
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        return new Response(
            JSON.stringify({ error: `Failed to fetch tables: ${errorMessage}` }),
            {
                status: 500,
                headers: { "Content-Type": "application/json" },
            }
        );
    }
}