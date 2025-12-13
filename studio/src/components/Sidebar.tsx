import { useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Database, Home, ChevronDown, ChevronRight } from 'lucide-react'
import { useStudioStore } from '../store/studio'
import { fetchTables } from '../lib/api'
import { cn } from '../lib/utils'

declare global {
  interface Window {
    bunsaneMetadata?: {
      archeTypes: Record<string, {
        fieldName: string
        componentName: string
        fieldLabel: string
      }[]>
    }
  }
}

export function Sidebar() {
  const location = useLocation()
  const { metadata, tables, setMetadata, setTables, setLoading, setError } = useStudioStore()

  useEffect(() => {
    // Load metadata from window
    if (window.bunsaneMetadata) {
      setMetadata(window.bunsaneMetadata)
    }

    // Load tables
    const loadTables = async () => {
      try {
        setLoading(true)
        const tablesData = await fetchTables()
        setTables(tablesData)
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to load tables')
      } finally {
        setLoading(false)
      }
    }

    loadTables()
  }, [setMetadata, setTables, setLoading, setError])

  const archeTypeNames = metadata ? Object.keys(metadata.archeTypes) : []

  return (
    <aside className="w-80 bg-card border-r border-border flex flex-col">
      <div className="p-6 border-b border-border">
        <h1 className="text-2xl font-bold text-primary">BunSane Studio</h1>
        <p className="text-sm text-muted-foreground mt-1">Database Management</p>
      </div>

      <nav className="flex-1 overflow-auto p-4">
        <div className="space-y-2">
          {/* Welcome */}
          <Link
            to="/"
            className={cn(
              "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
              location.pathname === "/"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            )}
          >
            <Home className="h-4 w-4" />
            Welcome
          </Link>

          {/* ArcheTypes */}
          <div className="space-y-1">
            <div className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-muted-foreground">
              <Database className="h-4 w-4" />
              ArcheTypes ({archeTypeNames.length})
            </div>
            <div className="ml-4 space-y-1">
              {archeTypeNames.map((archeTypeName) => (
                <Link
                  key={archeTypeName}
                  to={`/archetype/${archeTypeName}`}
                  className={cn(
                    "block px-3 py-2 rounded-md text-sm transition-colors",
                    location.pathname === `/archetype/${archeTypeName}`
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  {archeTypeName}
                </Link>
              ))}
            </div>
          </div>

          {/* Tables */}
          <div className="space-y-1">
            <div className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-muted-foreground">
              <Database className="h-4 w-4" />
              Tables ({tables.length})
            </div>
            <div className="ml-4 space-y-1">
              {tables.map((tableName) => (
                <Link
                  key={tableName}
                  to={`/table/${tableName}`}
                  className={cn(
                    "block px-3 py-2 rounded-md text-sm transition-colors",
                    location.pathname === `/table/${tableName}`
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  {tableName}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </nav>
    </aside>
  )
}