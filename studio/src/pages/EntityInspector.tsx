import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { Search, Loader2, AlertCircle, Clock, Hash, Trash2 } from 'lucide-react'
import ReactJson from 'react-json-view'
import { PageContainer } from '../components/PageContainer'
import { PageHeader } from '../components/PageHeader'
import { Input } from '../components/ui/input'
import { Button } from '../components/ui/button'
import {
  fetchEntity,
  fetchEntities,
  type EntityInspectorData,
  type EntityListItem,
} from '../lib/api'
import { useStudioStore, type Metadata } from '../store/studio'
import { cn } from '../lib/utils'
import { toast } from 'sonner'

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString()
}

function deriveArchetypes(
  componentNames: string[],
  metadata: Metadata | null
): { name: string; path: string }[] {
  if (!metadata?.archeTypes) return []

  const activeNames = new Set(componentNames)
  const matches: { name: string; path: string }[] = []

  for (const [name, fields] of Object.entries(metadata.archeTypes)) {
    const required = fields
      .filter((f) => !f.nullable)
      .map((f) => f.componentName)
    if (required.length > 0 && required.every((c) => activeNames.has(c))) {
      matches.push({ name, path: `/archetype/${name}` })
    }
  }

  return matches
}

export function EntityInspector() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { metadata } = useStudioStore()

  const [searchInput, setSearchInput] = useState(id ?? '')
  const [data, setData] = useState<EntityInspectorData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadEntity = async (entityId: string) => {
    setLoading(true)
    setError(null)
    setData(null)
    try {
      const result = await fetchEntity(entityId)
      setData(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch entity'
      setError(message)
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (id) {
      setSearchInput(id)
      loadEntity(id)
    }
  }, [id])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = searchInput.trim()
    if (!trimmed) return
    navigate(`/entity/${trimmed}`)
  }

  const activeComponents = data
    ? data.components.filter((c) => !c.deleted_at)
    : []
  const deletedComponents = data
    ? data.components.filter((c) => c.deleted_at)
    : []

  const archetypes = data
    ? deriveArchetypes(
        activeComponents.map((c) => c.name),
        metadata
      )
    : []

  return (
    <PageContainer>
      <PageHeader
        title="Entity Inspector"
        description="Look up an entity by ID to see all its components and metadata."
      />

      {/* Search bar */}
      <form onSubmit={handleSubmit} className="flex gap-2 mb-8 max-w-2xl">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Paste entity UUID..."
            className="pl-9 font-mono"
          />
        </div>
        <Button type="submit" disabled={loading || !searchInput.trim()}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Inspect'}
        </Button>
      </form>

      {/* Loading */}
      {loading && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Loading entity...</span>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="flex items-center gap-2 text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-4">
          <AlertCircle className="h-5 w-5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Results */}
      {data && !loading && (
        <div className="space-y-6">
          {/* Entity metadata card */}
          <div className="border border-border rounded-lg p-6 bg-card">
            <h2 className="text-lg font-semibold mb-4">Entity</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">ID</p>
                <p className="font-mono text-sm break-all">{data.entity.id}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                  <Clock className="h-3 w-3" /> Created
                </p>
                <p className="text-sm">{formatDate(data.entity.created_at)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                  <Clock className="h-3 w-3" /> Updated
                </p>
                <p className="text-sm">{formatDate(data.entity.updated_at)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                  <Trash2 className="h-3 w-3" /> Deleted
                </p>
                {data.entity.deleted_at ? (
                  <span className="inline-flex items-center gap-1 text-sm text-destructive font-medium">
                    {formatDate(data.entity.deleted_at)}
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground">-</span>
                )}
              </div>
            </div>
          </div>

          {/* Archetype membership */}
          {archetypes.length > 0 && (
            <div className="border border-border rounded-lg p-6 bg-card">
              <h2 className="text-lg font-semibold mb-3">Archetype Membership</h2>
              <div className="flex flex-wrap gap-2">
                {archetypes.map((a) => (
                  <Link
                    key={a.name}
                    to={a.path}
                    className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                  >
                    {a.name}
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Active components */}
          <div>
            <h2 className="text-lg font-semibold mb-3">
              Components ({activeComponents.length})
            </h2>
            {activeComponents.length === 0 ? (
              <p className="text-muted-foreground text-sm">No active components.</p>
            ) : (
              <div className="space-y-3">
                {activeComponents.map((comp) => (
                  <ComponentCard key={comp.id} component={comp} />
                ))}
              </div>
            )}
          </div>

          {/* Deleted components */}
          {deletedComponents.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold mb-3 text-destructive">
                Deleted Components ({deletedComponents.length})
              </h2>
              <div className="space-y-3">
                {deletedComponents.map((comp) => (
                  <ComponentCard key={comp.id} component={comp} deleted />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Entity list (browse) shown when no entity is selected */}
      {!id && <EntityList />}
    </PageContainer>
  )
}

const PAGE_SIZE = 50

function EntityList() {
  const navigate = useNavigate()
  const [entities, setEntities] = useState<EntityListItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDeleted, setShowDeleted] = useState(false)

  const load = async (offset: number, replace: boolean) => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchEntities({
        limit: PAGE_SIZE,
        offset,
        include_deleted: showDeleted,
      })
      setEntities((prev) =>
        replace ? result.entities : [...prev, ...result.entities]
      )
      setTotal(result.total)
      setHasMore(result.hasMore)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load entities'
      setError(message)
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load(0, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDeleted])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">
          Entities
          <span className="ml-2 text-sm text-muted-foreground font-mono tabular-nums">
            {total.toLocaleString()} total
          </span>
        </h2>
        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(e) => setShowDeleted(e.target.checked)}
            className="rounded border-border"
          />
          Show deleted
        </label>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-4">
          <AlertCircle className="h-5 w-5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {entities.length === 0 && !loading && !error ? (
        <div className="text-center py-16 text-muted-foreground">
          <Search className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p className="text-lg">No entities found</p>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="text-left font-medium px-4 py-2">ID</th>
                <th className="text-left font-medium px-4 py-2">Components</th>
                <th className="text-left font-medium px-4 py-2">Created</th>
                <th className="text-left font-medium px-4 py-2">Updated</th>
              </tr>
            </thead>
            <tbody>
              {entities.map((e) => (
                <tr
                  key={e.id}
                  onClick={() => navigate(`/entity/${e.id}`)}
                  className={cn(
                    'border-t border-border cursor-pointer hover:bg-accent/50 transition-colors',
                    e.deleted_at && 'opacity-50'
                  )}
                >
                  <td className="px-4 py-2 font-mono text-xs text-primary">
                    {e.id}
                    {e.deleted_at && (
                      <span className="ml-2 text-xs text-destructive">(deleted)</span>
                    )}
                  </td>
                  <td className="px-4 py-2 tabular-nums">{e.component_count}</td>
                  <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">
                    {formatDate(e.created_at)}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">
                    {formatDate(e.updated_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => load(entities.length, false)}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  )
}

function ComponentCard({
  component,
  deleted = false,
}: {
  component: EntityInspectorData['components'][number]
  deleted?: boolean
}) {
  const [expanded, setExpanded] = useState(true)

  return (
    <div
      className={cn(
        'border rounded-lg overflow-hidden',
        deleted
          ? 'border-destructive/30 bg-destructive/5 opacity-75'
          : 'border-border bg-card'
      )}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-accent/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="font-semibold text-sm">{component.name}</span>
          {deleted && (
            <span className="text-xs bg-destructive text-destructive-foreground px-2 py-0.5 rounded-full">
              Deleted
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1" title="type_id">
            <Hash className="h-3 w-3" />
            {component.type_id.slice(0, 8)}...
          </span>
          <span>{expanded ? '−' : '+'}</span>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-border px-4 py-3 space-y-3">
          {/* Timestamps */}
          <div className="flex gap-6 text-xs text-muted-foreground">
            <span>Created: {formatDate(component.created_at)}</span>
            <span>Updated: {formatDate(component.updated_at)}</span>
            {component.deleted_at && (
              <span className="text-destructive">
                Deleted: {formatDate(component.deleted_at)}
              </span>
            )}
          </div>
          {/* Data */}
          {component.data && typeof component.data === 'object' ? (
            <ReactJson
              src={component.data as object}
              name={null}
              collapsed={false}
              displayDataTypes={false}
              enableClipboard
              theme="rjv-default"
              style={{ fontSize: '13px' }}
            />
          ) : (
            <pre className="text-sm font-mono bg-muted p-3 rounded-md overflow-auto">
              {JSON.stringify(component.data, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
