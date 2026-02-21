import { useState, useEffect } from 'react'
import { Loader2, AlertCircle, Layers, Database, ChevronDown, ChevronRight } from 'lucide-react'
import { PageContainer } from '../components/PageContainer'
import { PageHeader } from '../components/PageHeader'
import { fetchComponents, type ComponentTypeInfo } from '../lib/api'
import { toast } from 'sonner'

export function Components() {
  const [components, setComponents] = useState<ComponentTypeInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const data = await fetchComponents()
        setComponents(data)
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to fetch components'
        setError(message)
        toast.error(message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  return (
    <PageContainer>
      <PageHeader
        title="Component Types"
        description="All distinct component types in your ECS database with field shapes and entity counts."
      />

      {loading && (
        <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Loading components...</span>
        </div>
      )}

      {error && !loading && (
        <div className="flex items-center gap-2 text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-4 mb-6">
          <AlertCircle className="h-5 w-5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!loading && !error && components.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          <Layers className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p className="text-lg">No component types found</p>
        </div>
      )}

      {!loading && components.length > 0 && (
        <div className="space-y-3">
          {components.map((comp) => (
            <ComponentRow key={comp.name} component={comp} />
          ))}
        </div>
      )}
    </PageContainer>
  )
}

function ComponentRow({ component }: { component: ComponentTypeInfo }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-accent/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="font-semibold text-sm">{component.name}</span>
          <span className="text-xs text-muted-foreground">
            {component.entityCount.toLocaleString()} {component.entityCount === 1 ? 'entity' : 'entities'}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Database className="h-3 w-3" />
          <span className="font-mono">{component.partitionTable}</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border px-5 py-4">
          {component.fields.length > 0 ? (
            <div>
              <p className="text-xs text-muted-foreground mb-2 font-medium">
                JSONB Fields ({component.fields.length})
              </p>
              <div className="flex flex-wrap gap-2">
                {component.fields.map((field) => (
                  <span
                    key={field}
                    className="inline-block px-2.5 py-1 rounded-md bg-muted text-sm font-mono"
                  >
                    {field}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No field data available (component data may be empty or non-object).
            </p>
          )}
        </div>
      )}
    </div>
  )
}
