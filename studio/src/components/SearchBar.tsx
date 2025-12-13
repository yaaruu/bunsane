import { Search, Trash2 } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { pluralize } from '../lib/utils'

interface SearchBarProps {
  search: string
  onSearchChange: (value: string) => void
  placeholder?: string
  selectedCount?: number
  onDelete?: () => void
  itemSingular?: string
  itemPlural?: string
}

export function SearchBar({
  search,
  onSearchChange,
  placeholder = 'Search...',
  selectedCount = 0,
  onDelete,
  itemSingular = 'record',
  itemPlural = 'records',
}: SearchBarProps) {
  return (
    <div className="flex items-center gap-4 mb-6">
      <div className="relative flex-1 max-w-sm">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={placeholder}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-10"
        />
      </div>

      {onDelete && selectedCount > 0 && (
        <Button
          variant="destructive"
          onClick={() => {
            if (
              window.confirm(
                `Are you sure you want to delete ${selectedCount} ${pluralize(selectedCount, itemSingular, itemPlural)}? This action cannot be undone.`
              )
            ) {
              onDelete()
            }
          }}
          className="flex items-center gap-2"
        >
          <Trash2 className="h-4 w-4" />
          Delete Selected ({selectedCount})
        </Button>
      )}
    </div>
  )
}
