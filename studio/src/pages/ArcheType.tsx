import { useParams } from 'react-router-dom'
import { type ColumnDef } from '@tanstack/react-table'
import { useStudioStore } from '../store/studio'
import { fetchArcheTypeData, deleteArcheTypeRecords } from '../lib/api'
import { PageContainer } from "../components/PageContainer";
import { PageHeader } from "../components/PageHeader";
import { SearchBar } from "../components/SearchBar";
import { DataTable } from '../components/DataTable'
import { useDataTable } from '../hooks/useDataTable'
import { createSelectColumn, createIdColumn, createTextColumn } from '../utils/columnHelpers'

interface ArcheTypeRecord {
  id: string
  [key: string]: any
}

export function ArcheType() {
  const { name } = useParams<{ name: string }>()
  const { metadata } = useStudioStore()

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
    key: name || '',
    fetchData: (params) => fetchArcheTypeData(name!, params) as Promise<{ data: ArcheTypeRecord[], hasMore: boolean }>,
    deleteRecords: (ids) => deleteArcheTypeRecords(name!, ids),
    fetchErrorMessage: 'Failed to load archetype entities',
    deleteErrorMessage: 'Failed to delete archetype entities',
    deleteSuccessMessage: 'Deleted {count} {item}',
    itemSingular: 'entity',
    itemPlural: 'entities',
  })

  const archeTypeFields = metadata?.archeTypes[name || ''] || []

  const columns: ColumnDef<ArcheTypeRecord>[] = [
    createSelectColumn<ArcheTypeRecord>(),
    createIdColumn<ArcheTypeRecord>(),
    ...archeTypeFields.map(field =>
      createTextColumn<ArcheTypeRecord>(
        field.componentName,
        field.fieldLabel || field.fieldName,
        { extractValue: true }
      )
    ),
  ]

  if (!name) {
    return <div className="p-8">Archetype name not found</div>
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
          <DataTable
              data={data}
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