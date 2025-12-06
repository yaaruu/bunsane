import { useParams } from 'react-router-dom'
import { type ColumnDef } from '@tanstack/react-table'
import { useStudioStore } from '../store/studio'
import { fetchArcheTypeData, deleteArcheTypeRecords } from '../lib/api'
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
    <DataTable
      title={`${name} Archetype`}
      description={`Browse and manage entities for the ${name} archetype`}
      data={data}
      columns={columns}
      loading={loading}
      hasMore={hasMore}
      search={search}
      onSearchChange={setSearch}
      sorting={sorting}
      onSortingChange={setSorting}
      selectedRecords={selectedRecords}
      onSelectionChange={setSelectedRecords}
      onDelete={handleDelete}
      getRecordId={(record) => record.id}
      loadMoreRef={loadMoreRef}
      isArcheType
    />
  )
}