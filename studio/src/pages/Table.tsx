import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useInView } from 'react-intersection-observer'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  type ColumnDef,
  flexRender,
  type SortingState,
} from '@tanstack/react-table'
import { Search, Trash2, Loader2 } from 'lucide-react'
import { fetchTableData, deleteTableRecord } from '../lib/api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { toast } from 'sonner'
import ReactJson from 'react-json-view'

interface TableRecord {
  [key: string]: any
}

export function Table() {
  const { name } = useParams<{ name: string }>()
  const [data, setData] = useState<TableRecord[]>([])
  const [columns, setColumns] = useState<ColumnDef<TableRecord>[]>([])
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [search, setSearch] = useState('')
  const [sorting, setSorting] = useState<SortingState>([])
  const [selectedRecords, setSelectedRecords] = useState<Set<string>>(new Set())
  const { ref, inView } = useInView()

  const loadMore = async (reset = false) => {
    if (loading || (!hasMore && !reset)) return

    try {
      setLoading(true)
      const offset = reset ? 0 : data.length
      const result = await fetchTableData(name!, { offset, limit: 50, search: search || undefined })

      if (reset) {
        setData(result.data)
        // Generate columns from the first record
        if (result.data.length > 0) {
          const sampleRecord = result.data[0]
          const newColumns: ColumnDef<TableRecord>[] = [
            {
              id: 'select',
              header: ({ table }) => (
                <input
                  type="checkbox"
                  checked={table.getIsAllRowsSelected()}
                  onChange={table.getToggleAllRowsSelectedHandler()}
                  className="rounded border-border"
                />
              ),
              cell: ({ row }) => (
                <input
                  type="checkbox"
                  checked={row.getIsSelected()}
                  onChange={row.getToggleSelectedHandler()}
                  className="rounded border-border"
                />
              ),
            },
            ...Object.keys(sampleRecord).map(key => ({
              accessorKey: key,
              header: key,
              // @ts-ignore
              cell: ({ getValue }) => {
                const value = getValue()
                if (typeof value === 'object' && value !== null) {
                  return (
                    <div className="max-w-xs">
                      <ReactJson
                        src={value}
                        collapsed={true}
                        enableClipboard
                        displayDataTypes={false}
                        displayObjectSize={false}
                        name={null}
                      />
                    </div>
                  )
                }
                return <span className="truncate max-w-xs block">{String(value)}</span>
              },
            })),
          ]
          setColumns(newColumns)
        }
      } else {
        setData(prev => [...prev, ...result.data])
      }

      setHasMore(result.hasMore)
    } catch (error) {
      toast.error('Failed to load table data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (name) {
      loadMore(true)
    }
  }, [name, search])

  useEffect(() => {
    if (inView && hasMore && !loading) {
      loadMore()
    }
  }, [inView, hasMore, loading])

  const handleDeleteSelected = async () => {
    if (selectedRecords.size === 0) return

    try {
      const promises = Array.from(selectedRecords).map(id =>
        deleteTableRecord(name!, id)
      )
      await Promise.all(promises)
      toast.success(`Deleted ${selectedRecords.size} records`)
      setSelectedRecords(new Set())
      loadMore(true)
    } catch (error) {
      toast.error('Failed to delete records')
    }
  }

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: {
      sorting,
      rowSelection: Object.fromEntries(Array.from(selectedRecords).map(id => [data.findIndex(d => d.id === id), true])),
    },
    onRowSelectionChange: (updater) => {
      const newSelection = typeof updater === 'function' ? updater(Object.fromEntries(Array.from(selectedRecords).map(id => [data.findIndex(d => d.id === id), true]))) : updater
      const newSelectedRecords = new Set<string>()
      Object.entries(newSelection).forEach(([index, selected]) => {
        if (selected) {
          const record = data[parseInt(index)]
          if (record && record.id) {
            newSelectedRecords.add(record.id)
          }
        }
      })
      setSelectedRecords(newSelectedRecords)
    },
  })

  if (!name) {
    return <div className="p-8">Table name not found</div>
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-primary mb-2">{name} Table</h1>
        <p className="text-muted-foreground">
          Browse and manage records in the {name} table
        </p>
      </div>

      <div className="flex items-center gap-4 mb-6">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search records..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>

        {selectedRecords.size > 0 && (
          <Button
            variant="destructive"
            onClick={handleDeleteSelected}
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
                          className={header.column.getCanSort() ? 'cursor-pointer select-none flex items-center gap-2' : ''}
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
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
                <tr key={row.id} className="border-b border-border hover:bg-muted/50">
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
          <div ref={ref} className="p-4 text-center">
            {loading ? (
              <div className="flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading more records...
              </div>
            ) : (
              <div className="text-muted-foreground">Scroll for more records</div>
            )}
          </div>
        )}

        {!loading && data.length === 0 && (
          <div className="p-8 text-center text-muted-foreground">
            No records found
          </div>
        )}
      </div>
    </div>
  )
}