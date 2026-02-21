import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import {
  Search,
  Loader2,
  AlertCircle,
  Box,
  Layers,
  FlameIcon,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { PageContainer } from '../components/PageContainer'
import { Input } from '../components/ui/input'
import { Button } from '../components/ui/button'
import { fetchStats, type StudioStats } from '../lib/api'
import { toast } from 'sonner'

export function Welcome() {
  const navigate = useNavigate()
  const [stats, setStats] = useState<StudioStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [entitySearch, setEntitySearch] = useState('')

  const loadStats = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchStats()
      setStats(data)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch stats'
      setError(message)
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadStats()
  }, [])

  const handleEntityLookup = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = entitySearch.trim()
    if (!trimmed) return
    navigate(`/entity/${trimmed}`)
  }

  return (
    <PageContainer>
      <div className="max-w-5xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-primary">Dashboard</h1>
            <p className="text-muted-foreground mt-1">
              Overview of your ECS database
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={loadStats}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Refresh
          </Button>
        </div>

        {/* Quick entity lookup */}
        <form onSubmit={handleEntityLookup} className="flex gap-2 mb-8 max-w-lg">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={entitySearch}
              onChange={(e) => setEntitySearch(e.target.value)}
              placeholder="Quick entity lookup — paste UUID..."
              className="pl-9 font-mono text-sm"
            />
          </div>
          <Button type="submit" disabled={!entitySearch.trim()}>
            Inspect
          </Button>
        </form>

        {/* Error */}
        {error && !loading && (
          <div className="flex items-center gap-2 text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-4 mb-6">
            <AlertCircle className="h-5 w-5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Loading skeleton */}
        {loading && !stats && (
          <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Loading stats...</span>
          </div>
        )}

        {/* Stats content */}
        {stats && (
          <>
            {/* Summary cards */}
            <div className="grid gap-4 md:grid-cols-3 mb-8">
              <SummaryCard
                icon={Box}
                label="Entities"
                value={stats.entities.active}
                sub={
                  stats.entities.deleted > 0
                    ? `${stats.entities.deleted} deleted`
                    : undefined
                }
              />
              <SummaryCard
                icon={Layers}
                label="Component Types"
                value={stats.componentTypes.length}
              />
              <SummaryCard
                icon={FlameIcon}
                label="Archetypes"
                value={stats.archetypes.length}
              />
            </div>

            {/* Two-column layout */}
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Archetypes */}
              <div className="border border-border rounded-lg bg-card">
                <div className="px-5 py-4 border-b border-border">
                  <h2 className="font-semibold">Archetypes</h2>
                </div>
                {stats.archetypes.length === 0 ? (
                  <p className="p-5 text-sm text-muted-foreground">
                    No archetypes registered.
                  </p>
                ) : (
                  <div className="divide-y divide-border">
                    {stats.archetypes.map((a) => (
                      <Link
                        key={a.name}
                        to={`/archetype/${a.name}`}
                        className="flex items-center justify-between px-5 py-3 hover:bg-accent/50 transition-colors"
                      >
                        <div>
                          <span className="text-sm font-medium">{a.name}</span>
                          <span className="text-xs text-muted-foreground ml-2">
                            {a.componentCount} component{a.componentCount !== 1 ? 's' : ''}
                          </span>
                        </div>
                        <span className="text-sm font-mono tabular-nums">
                          {a.entityCount.toLocaleString()}
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>

              {/* Component types */}
              <div className="border border-border rounded-lg bg-card">
                <div className="px-5 py-4 border-b border-border">
                  <h2 className="font-semibold">Component Types</h2>
                </div>
                {stats.componentTypes.length === 0 ? (
                  <p className="p-5 text-sm text-muted-foreground">
                    No components found.
                  </p>
                ) : (
                  <div className="divide-y divide-border max-h-96 overflow-auto">
                    {stats.componentTypes.map((ct) => (
                      <div
                        key={ct.name}
                        className="flex items-center justify-between px-5 py-3"
                      >
                        <span className="text-sm">{ct.name}</span>
                        <span className="text-sm font-mono tabular-nums text-muted-foreground">
                          {ct.count.toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Deleted entities note */}
            {stats.entities.deleted > 0 && (
              <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-md px-4 py-3">
                <Trash2 className="h-4 w-4 shrink-0" />
                <span>
                  {stats.entities.deleted.toLocaleString()} soft-deleted{' '}
                  {stats.entities.deleted === 1 ? 'entity' : 'entities'} in the
                  database ({stats.entities.total.toLocaleString()} total)
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </PageContainer>
  )
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Box
  label: string
  value: number
  sub?: string
}) {
  return (
    <div className="border border-border rounded-lg p-5 bg-card">
      <div className="flex items-center gap-3 mb-3">
        <div className="p-2 rounded-md bg-primary/10">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
      <p className="text-3xl font-bold tabular-nums">{value.toLocaleString()}</p>
      {sub && (
        <p className="text-xs text-muted-foreground mt-1">{sub}</p>
      )}
    </div>
  )
}
