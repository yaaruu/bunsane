import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, AlertCircle, Play, Clock, ChevronDown } from 'lucide-react'
import { PageContainer } from '../components/PageContainer'
import { PageHeader } from '../components/PageHeader'
import { Button } from '../components/ui/button'
import { executeQuery, type QueryResult } from '../lib/api'
import { toast } from 'sonner'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const TEMPLATES = [
  {
    label: 'Entities with component',
    sql: `SELECT e.id, e.created_at, c.name as component, c.data
FROM entities e
JOIN components c ON c.entity_id = e.id
WHERE c.name = 'MyComponent'
AND c.deleted_at IS NULL
ORDER BY e.created_at DESC
LIMIT 50`,
  },
  {
    label: 'Orphaned components',
    sql: `SELECT c.id, c.entity_id, c.name, c.created_at
FROM components c
LEFT JOIN entities e ON e.id = c.entity_id
WHERE e.id IS NULL
LIMIT 50`,
  },
  {
    label: 'Recently deleted entities',
    sql: `SELECT id, created_at, deleted_at
FROM entities
WHERE deleted_at IS NOT NULL
ORDER BY deleted_at DESC
LIMIT 50`,
  },
  {
    label: 'Component data for entity',
    sql: `SELECT c.name, c.type_id, c.data, c.created_at, c.updated_at, c.deleted_at
FROM components c
WHERE c.entity_id = '00000000-0000-0000-0000-000000000000'
ORDER BY c.name`,
  },
  {
    label: 'Component type counts',
    sql: `SELECT name, COUNT(*) as count
FROM components
WHERE deleted_at IS NULL
GROUP BY name
ORDER BY count DESC`,
  },
  {
    label: 'Table sizes',
    sql: `SELECT relname AS table_name,
  pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
  pg_size_pretty(pg_relation_size(relid)) AS data_size,
  n_live_tup AS row_estimate
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC`,
  },
]

export function QueryRunner() {
  const [sql, setSql] = useState('')
  const [result, setResult] = useState<QueryResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showTemplates, setShowTemplates] = useState(false)

  const handleRun = async () => {
    const trimmed = sql.trim()
    if (!trimmed) return

    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const data = await executeQuery(trimmed)
      setResult(data)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Query failed'
      setError(message)
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      handleRun()
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="SQL Query Runner"
        description="Execute read-only SQL queries against the database. Dev mode only."
      />

      {/* SQL editor */}
      <div className="space-y-3 mb-6">
        <div className="flex items-center gap-2">
          <div className="relative">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowTemplates(!showTemplates)}
            >
              Templates
              <ChevronDown className="h-3 w-3 ml-1" />
            </Button>
            {showTemplates && (
              <div className="absolute top-full left-0 mt-1 z-10 bg-card border border-border rounded-md shadow-lg min-w-[220px]">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.label}
                    className="w-full text-left px-4 py-2 text-sm hover:bg-accent transition-colors first:rounded-t-md last:rounded-b-md"
                    onClick={() => {
                      setSql(t.sql)
                      setShowTemplates(false)
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="text-xs text-muted-foreground">
            Ctrl+Enter to run
          </span>
        </div>

        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="SELECT * FROM entities LIMIT 10"
          className="w-full h-40 font-mono text-sm bg-background border border-input rounded-md px-4 py-3 resize-y focus:outline-none focus:ring-2 focus:ring-ring"
          spellCheck={false}
        />

        <div className="flex items-center gap-3">
          <Button onClick={handleRun} disabled={loading || !sql.trim()}>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            Run Query
          </Button>

          {result && (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              {result.rowCount} row{result.rowCount !== 1 ? 's' : ''} in{' '}
              {result.duration}ms
            </span>
          )}
        </div>
      </div>

      {/* Error */}
      {error && !loading && (
        <div className="flex items-start gap-2 text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-4 mb-6">
          <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
          <pre className="text-sm whitespace-pre-wrap font-mono">{error}</pre>
        </div>
      )}

      {/* Results table */}
      {result && result.columns.length > 0 && (
        <div className="bg-card rounded-lg border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/50">
                <tr>
                  {result.columns.map((col) => (
                    <th
                      key={col}
                      className="px-4 py-3 text-left text-sm font-medium text-muted-foreground border-b border-border whitespace-nowrap"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr
                    key={i}
                    className="border-b border-border hover:bg-muted/50"
                  >
                    {result.columns.map((col) => (
                      <td
                        key={col}
                        className="px-4 py-3 text-sm font-mono whitespace-nowrap max-w-xs truncate"
                        title={formatValue(row[col])}
                      >
                        <CellValue value={row[col]} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty result */}
      {result && result.columns.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Query executed successfully but returned no columns.
        </p>
      )}
    </PageContainer>
  )
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function CellValue({ value }: { value: unknown }) {
  const str = formatValue(value)
  if (typeof value === 'string' && UUID_REGEX.test(value)) {
    return (
      <Link
        to={`/entity/${value}`}
        className="text-primary hover:underline"
        title="Inspect entity"
      >
        {str}
      </Link>
    )
  }
  return <>{str}</>
}
