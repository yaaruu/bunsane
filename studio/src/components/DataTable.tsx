import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  type ColumnDef,
  flexRender,
  type SortingState,
} from '@tanstack/react-table'
import { Search, Trash2, Loader2 } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { pluralize } from '../lib/utils'

interface DataTableProps<T> {
  title: string
  description: string
  data: T[]
  columns: ColumnDef<T>[]
  loading: boolean
  hasMore: boolean
  search: string
  onSearchChange: (value: string) => void
  sorting: SortingState
  onSortingChange: (updater: SortingState | ((old: SortingState) => SortingState)) => void
  selectedRecords: Set<string>
  onSelectionChange: (selected: Set<string>) => void
  onDelete?: () => void
  getRecordId: (record: T) => string
  loadMoreRef: (node?: Element | null) => void
  isArcheType?: boolean
}

export function DataTable<T extends Record<string, any>>({
  title,
  description,
  data,
  columns,
  loading,
  hasMore,
  search,
  onSearchChange,
  sorting,
  onSortingChange,
  selectedRecords,
  onSelectionChange,
  onDelete,
  getRecordId,
  loadMoreRef,
  isArcheType = false,
}: DataTableProps<T>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange,
    state: {
      sorting,
      rowSelection: Object.fromEntries(
        Array.from(selectedRecords).map(id => [
          data.findIndex(d => getRecordId(d) === id),
          true,
        ])
      ),
    },
    onRowSelectionChange: (updater) => {
      const currentSelection = Object.fromEntries(
        Array.from(selectedRecords).map(id => [
          data.findIndex(d => getRecordId(d) === id),
          true,
        ])
      )
      const newSelection =
        typeof updater === 'function' ? updater(currentSelection) : updater
      const newSelectedRecords = new Set<string>()
      Object.entries(newSelection).forEach(([index, selected]) => {
        if (selected) {
          const record = data[parseInt(index)]
          if (record) {
            newSelectedRecords.add(getRecordId(record))
          }
        }
      })
      onSelectionChange(newSelectedRecords)
    },
  })

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-primary mb-2">{title}</h1>
        <p className="text-muted-foreground">{description}</p>
      </div>

      <div className="flex items-center gap-4 mb-6">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={`Search ${isArcheType ? "entities" : "records"}...`}
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-10"
          />
        </div>

        {onDelete && selectedRecords.size > 0 && (
          <Button
            variant="destructive"
            onClick={() => {
              if (window.confirm(`Are you sure you want to delete ${selectedRecords.size} ${pluralize(selectedRecords.size, isArcheType ? 'entity' : 'record', isArcheType ? 'entities' : 'records')}? This action cannot be undone.`)) {
                onDelete()
              }
            }}
            className="flex items-center gap-2"
          >
            <Trash2 className="h-4 w-4" />
            Delete Selected ({selectedRecords.size})
          </Button>
        )}
      </div>

      <div className="bg-card rounded-lg border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-muted/50">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      className="px-4 py-3 text-left text-sm font-medium text-muted-foreground border-b border-border"
                    >
                      {header.isPlaceholder ? null : (
                        <div
                          className={
                            header.column.getCanSort()
                              ? 'cursor-pointer select-none flex items-center gap-2'
                              : ''
                          }
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                          {{
                            asc: '↑',
                            desc: '↓',
                          }[header.column.getIsSorted() as string] ?? null}
                        </div>
                      )}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-border hover:bg-muted/50"
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-4 py-3 text-sm">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {(loading || hasMore) && (
          <div ref={loadMoreRef} className="p-4 text-center">
            {loading ? (
              <div className="flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading more {isArcheType ? "entities" : "records"}...
              </div>
            ) : (
              <div className="text-muted-foreground">Scroll for more {isArcheType ? "entities" : "records"} </div>
            )}
          </div>
        )}

        {!loading && data.length === 0 && (
          <div className="p-8 text-center text-muted-foreground">
            No {isArcheType ? "entities" : "records"} found
          </div>
        )}
      </div>
    </div>
  )
}
