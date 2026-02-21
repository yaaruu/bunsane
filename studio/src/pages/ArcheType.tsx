import { useParams } from "react-router-dom";
import { type ColumnDef } from "@tanstack/react-table";
import { useStudioStore } from "../store/studio";
import { useArcheTypeSettings } from "../store/archeTypeSettings";
import { fetchArcheTypeData, deleteArcheTypeRecords } from "../lib/api";
import { PageContainer } from "../components/PageContainer";
import { SearchBar } from "../components/SearchBar";
import { DataTable } from "../components/DataTable";
import { Checkbox } from "../components/ui/checkbox";
import { useDataTable } from "../hooks/useDataTable";
import {
    createSelectColumn,
    createIdColumn,
    createTextColumn,
} from "../utils/columnHelpers";
import { useMemo } from "react";
import { cn } from "../lib/utils";

interface ArcheTypeRecord {
    id: string;
    _deleted_at?: string | null;
    [key: string]: any;
}

function findIndicatorName(
    archeTypeName: string,
    fields: { componentName: string }[]
): string | null {
    if (fields.length === 0) return null;
    const names = fields.map((f) => f.componentName);
    const lower = archeTypeName.toLowerCase();

    return (
        names.find((n) => n.toLowerCase() === `${lower}tag`) ??
        names.find((n) => n.toLowerCase() === `${lower}id`) ??
        names.find((n) => n.toLowerCase().startsWith(lower)) ??
        names.find((n) => n.toLowerCase().includes(lower)) ??
        names[0] ??
        null
    );
}

export function ArcheType() {
    const { name } = useParams<{ name: string }>();
    const { metadata } = useStudioStore();
    const {
        useRealDbFieldName,
        autoExpandRow,
        showDeleted,
        setUseRealDbFieldName,
        setAutoExpandRow,
        setShowDeleted,
    } = useArcheTypeSettings();

    const fetchKey = `${name || ""}:${showDeleted}`;

    const {
        data,
        loading,
        hasMore,
        total,
        search,
        sorting,
        selectedRecords,
        setSearch,
        setSorting,
        setSelectedRecords,
        handleDelete,
        loadMoreRef,
    } = useDataTable<ArcheTypeRecord>({
        key: fetchKey,
        fetchData: (params) =>
            fetchArcheTypeData(name!, {
                ...params,
                include_deleted: showDeleted,
            }) as Promise<{
                data: ArcheTypeRecord[];
                hasMore: boolean;
                total?: number;
            }>,
        deleteRecords: (ids) => deleteArcheTypeRecords(name!, ids),
        fetchErrorMessage: "Failed to load archetype entities",
        deleteErrorMessage: "Failed to delete archetype entities",
        deleteSuccessMessage: "Deleted {count} {item}",
        itemSingular: "entity",
        itemPlural: "entities",
    });

    const archeTypeFields = metadata?.archeTypes[name || ""] || [];
    const indicatorName = useMemo(
        () => (name ? findIndicatorName(name, archeTypeFields) : null),
        [name, archeTypeFields]
    );

    // Preprocess data: transform Tag component values to "true" when useRealDbFieldName is enabled
    const preprocessedData = useMemo(() => {
        if (useRealDbFieldName) return data;

        return data.map((record) => {
            const newRecord = { ...record };
            archeTypeFields.forEach((field) => {
                if (field.componentName.endsWith("Tag")) {
                    newRecord[field.componentName] = "true";
                }
            });
            return newRecord;
        });
    }, [data, useRealDbFieldName, archeTypeFields]);

    const columns: ColumnDef<ArcheTypeRecord>[] = useMemo(
        () => [
            createSelectColumn<ArcheTypeRecord>(),
            createIdColumn<ArcheTypeRecord>({ linkToEntity: true }),
            ...archeTypeFields.map((field) => {
                const isTagComponent = field.componentName.endsWith("Tag");
                const shouldExtractValue = !(
                    useRealDbFieldName && isTagComponent
                );

                return createTextColumn<ArcheTypeRecord>(
                    field.componentName,
                    useRealDbFieldName
                        ? field.componentName
                        : field.fieldLabel || field.fieldName,
                    { extractValue: shouldExtractValue, autoExpandRow }
                );
            }),
        ],
        [archeTypeFields, useRealDbFieldName, autoExpandRow]
    );

    const getRowClassName = (record: ArcheTypeRecord) =>
        record._deleted_at ? "opacity-50 bg-destructive/5" : "";

    if (!name) {
        return <div className="p-8">Archetype name not found</div>;
    }

    return (
        <PageContainer>
            {/* Header with total count */}
            <div className="mb-6">
                <div className="flex items-baseline gap-3 mb-1">
                    <h1 className="text-3xl font-bold text-primary">{name}</h1>
                    {total !== null && (
                        <span className="text-lg text-muted-foreground font-mono tabular-nums">
                            {total.toLocaleString()} {total === 1 ? "entity" : "entities"}
                        </span>
                    )}
                </div>
                <p className="text-muted-foreground mb-4">
                    Browse and manage entities for the {name} archetype
                </p>

                {/* Component composition */}
                {archeTypeFields.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                        {archeTypeFields.map((field) => {
                            const isIndicator =
                                field.componentName === indicatorName;
                            const isOptional = !!field.nullable;

                            return (
                                <span
                                    key={field.componentName}
                                    className={cn(
                                        "inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border",
                                        isIndicator
                                            ? "bg-primary/15 text-primary border-primary/30"
                                            : isOptional
                                              ? "bg-muted/50 text-muted-foreground border-border border-dashed"
                                              : "bg-muted text-foreground border-border"
                                    )}
                                    title={
                                        isIndicator
                                            ? "Indicator component"
                                            : isOptional
                                              ? "Optional component"
                                              : "Required component"
                                    }
                                >
                                    {field.componentName}
                                    {isOptional && (
                                        <span className="text-muted-foreground">?</span>
                                    )}
                                </span>
                            );
                        })}
                    </div>
                )}
            </div>

            <SearchBar
                search={search}
                onSearchChange={setSearch}
                placeholder="Search entities..."
                selectedCount={selectedRecords.size}
                onDelete={handleDelete}
                itemSingular="entity"
                itemPlural="entities"
            />
            <div className="flex items-center gap-6 mb-4">
                <Checkbox
                    id="show-db-field-name"
                    label="Show real DB field name"
                    checked={useRealDbFieldName}
                    onChange={(e) => setUseRealDbFieldName(e.target.checked)}
                />
                <Checkbox
                    id="auto-expand-row"
                    label="Auto expand row"
                    checked={autoExpandRow}
                    onChange={(e) => setAutoExpandRow(e.target.checked)}
                />
                <Checkbox
                    id="show-deleted"
                    label="Show deleted"
                    checked={showDeleted}
                    onChange={(e) => setShowDeleted(e.target.checked)}
                />
            </div>
            <DataTable
                data={preprocessedData}
                columns={columns}
                loading={loading}
                hasMore={hasMore}
                sorting={sorting}
                onSortingChange={setSorting}
                selectedRecords={selectedRecords}
                onSelectionChange={setSelectedRecords}
                getRecordId={(record) => record.id}
                loadMoreRef={loadMoreRef}
                emptyMessage="No entities found"
                loadingMessage="Loading more entities..."
                getRowClassName={getRowClassName}
            />
        </PageContainer>
    );
}
