import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { type ColumnDef } from '@tanstack/react-table'
import { fetchTableData, deleteTableRecord } from '../lib/api'
import { DataTable } from '../components/DataTable'
import { useDataTable } from '../hooks/useDataTable'
import { createSelectColumn, createTextColumn } from '../utils/columnHelpers'

interface TableRecord {
  [key: string]: any
}

export function Table() {
  const { name } = useParams<{ name: string }>()
  const [columns, setColumns] = useState<ColumnDef<TableRecord>[]>([])

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
  } = useDataTable<TableRecord>({
    key: name || '',
    fetchData: (params) => fetchTableData(name!, params),
    deleteRecords: (ids) => Promise.all(ids.map(id => deleteTableRecord(name!, id))).then(() => {}),
    fetchErrorMessage: 'Failed to load table data',
    deleteErrorMessage: 'Failed to delete table records',
  })

  // Generate columns from the first data record
  useEffect(() => {
    if (data.length > 0 && columns.length === 0) {
      const sampleRecord = data[0]
      const newColumns: ColumnDef<TableRecord>[] = [
        createSelectColumn<TableRecord>(),
        ...Object.keys(sampleRecord).map(key =>
          createTextColumn<TableRecord>(key, key)
        ),
      ]
      setColumns(newColumns)
    }
  }, [data, columns.length])

  // Reset columns when table name changes
  useEffect(() => {
    setColumns([])
  }, [name])

  if (!name) {
    return <div className="p-8">Table name not found</div>
  }

  return (
    <DataTable
      title={`${name} Table`}
      description={`Browse and manage records in the ${name} table`}
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
      getRecordId={(record) => String(record.id)}
      loadMoreRef={loadMoreRef}
    />
  )
}