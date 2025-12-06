import { useParams } from 'react-router-dom'
import { type ColumnDef } from '@tanstack/react-table'
import { useStudioStore } from '../store/studio'
import { fetchArcheTypeData, deleteArcheTypeRecord } from '../lib/api'
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
    deleteRecords: (ids) => Promise.all(ids.map(id => deleteArcheTypeRecord(name!, id))).then(() => {}),
    fetchErrorMessage: 'Failed to load archetype data',
    deleteErrorMessage: 'Failed to delete archetype records',
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
      description={`Browse and manage records for the ${name} archetype`}
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
    />
  )
}