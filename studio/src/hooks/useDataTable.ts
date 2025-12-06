import { useEffect, useState } from 'react'
import { useInView } from 'react-intersection-observer'
import { type SortingState } from '@tanstack/react-table'
import { toast } from 'sonner'
import { pluralize } from '../lib/utils'

interface UseDataTableOptions<T> {
  /** Unique identifier for the data (e.g., table name, archetype name) */
  key: string
  /** Function to fetch data */
  fetchData: (params: { offset: number; limit: number; search?: string }) => Promise<{
    data: T[]
    hasMore: boolean
  }>
  /** Function to delete records by IDs */
  deleteRecords: (ids: string[]) => Promise<void>
  /** Optional: Custom error message for fetch failure */
  fetchErrorMessage?: string
  /** Optional: Custom error message for delete failure */
  deleteErrorMessage?: string
  /** Optional: Custom success message for delete (use {count} and {item} as placeholders) */
  deleteSuccessMessage?: string
  /** Optional: Singular form of the item type (e.g., "record", "entity") */
  itemSingular?: string
  /** Optional: Plural form of the item type (e.g., "records", "entities") */
  itemPlural?: string
}

export function useDataTable<T>({
  key,
  fetchData,
  deleteRecords,
  fetchErrorMessage = 'Failed to load data',
  deleteErrorMessage = 'Failed to delete records',
  deleteSuccessMessage = 'Deleted {count} {item}',
  itemSingular = 'record',
  itemPlural = 'records',
}: UseDataTableOptions<T>) {
  const [data, setData] = useState<T[]>([])
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
      const result = await fetchData({
        offset,
        limit: 50,
        search: search || undefined,
      })

      if (reset) {
        setData(result.data)
      } else {
        setData(prev => [...prev, ...result.data])
      }

      setHasMore(result.hasMore)
    } catch (error) {
      toast.error(fetchErrorMessage)
    } finally {
      setLoading(false)
    }
  }

  // Reset and load data when key or search changes
  useEffect(() => {
    if (key) {
      setData([])
      setHasMore(true)
      setSelectedRecords(new Set())
      loadMore(true)
    }
  }, [key, search])

  // Infinite scroll: load more when scroll observer is in view
  useEffect(() => {
    if (inView && hasMore && !loading) {
      loadMore()
    }
  }, [inView, hasMore, loading])

  const handleDelete = async () => {
    if (selectedRecords.size === 0) return

    try {
      await deleteRecords(Array.from(selectedRecords))
      const itemText = pluralize(selectedRecords.size, itemSingular, itemPlural)
      toast.success(deleteSuccessMessage.replace('{count}', selectedRecords.size.toString()).replace('{item}', itemText))
      setSelectedRecords(new Set())
      loadMore(true)
    } catch (error) {
      toast.error(deleteErrorMessage)
    }
  }

  return {
    // State
    data,
    loading,
    hasMore,
    search,
    sorting,
    selectedRecords,
    
    // Setters
    setSearch,
    setSorting,
    setSelectedRecords,
    setData,
    
    // Handlers
    handleDelete,
    
    // Refs
    loadMoreRef: ref,
  }
}
