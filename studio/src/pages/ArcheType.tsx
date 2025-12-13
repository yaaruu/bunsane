import { useParams } from "react-router-dom";
import { type ColumnDef } from "@tanstack/react-table";
import { useStudioStore } from "../store/studio";
import { useArcheTypeSettings } from "../store/archeTypeSettings";
import { fetchArcheTypeData, deleteArcheTypeRecords } from "../lib/api";
import { PageContainer } from "../components/PageContainer";
import { PageHeader } from "../components/PageHeader";
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

interface ArcheTypeRecord {
    id: string;
    [key: string]: any;
}

export function ArcheType() {
    const { name } = useParams<{ name: string }>();
    const { metadata } = useStudioStore();
    const {
        useRealDbFieldName,
        autoExpandRow,
        setUseRealDbFieldName,
        setAutoExpandRow,
    } = useArcheTypeSettings();

    const {
        data,
        loading,
        hasMore,
        search,
        sorting,
        selectedRecords,
        setSearch,
        setSorting,
        setSelectedRecords,
        handleDelete,
        loadMoreRef,
    } = useDataTable<ArcheTypeRecord>({
        key: name || "",
        fetchData: (params) =>
            fetchArcheTypeData(name!, params) as Promise<{
                data: ArcheTypeRecord[];
                hasMore: boolean;
            }>,
        deleteRecords: (ids) => deleteArcheTypeRecords(name!, ids),
        fetchErrorMessage: "Failed to load archetype entities",
        deleteErrorMessage: "Failed to delete archetype entities",
        deleteSuccessMessage: "Deleted {count} {item}",
        itemSingular: "entity",
        itemPlural: "entities",
    });

    const archeTypeFields = metadata?.archeTypes[name || ""] || [];

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
            createIdColumn<ArcheTypeRecord>(),
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

    if (!name) {
        return <div className="p-8">Archetype name not found</div>;
    }

    return (
        <PageContainer>
            <PageHeader
                title={`${name} Archetype`}
                description={`Browse and manage entities for the ${name} archetype`}
            />
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
            />
        </PageContainer>
    );
}
