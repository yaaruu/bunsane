const API_BASE = '/studio/api'

export interface TableData {
  data: Record<string, unknown>[]
  hasMore: boolean
  total?: number
}

export interface ArcheTypeData {
  data: Record<string, unknown>[]
  hasMore: boolean
  total?: number
}

export interface TablesResponse {
  tables: string[]
}

export async function fetchTables(): Promise<string[]> {
  const response = await fetch(`${API_BASE}/tables`)
  if (!response.ok) {
    throw new Error('Failed to fetch tables')
  }
  const data: TablesResponse = await response.json()
  return data.tables
}

export async function fetchTableData(
  tableName: string,
  params: { limit?: number; offset?: number; search?: string } = {}
): Promise<TableData> {
  const searchParams = new URLSearchParams()
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.offset) searchParams.set('offset', params.offset.toString())
  if (params.search) searchParams.set('search', params.search)

  const response = await fetch(`${API_BASE}/table/${tableName}?${searchParams}`)
  if (!response.ok) {
    throw new Error('Failed to fetch table data')
  }
  const result = await response.json()
  return {
    data: result.rows || [],
    hasMore: result.rows && result.rows.length === (params.limit || 50),
    total: result.total,
  }
}

export async function fetchArcheTypeData(
  archeTypeName: string,
  params: { limit?: number; offset?: number; search?: string; include_deleted?: boolean } = {}
): Promise<ArcheTypeData> {
  const searchParams = new URLSearchParams()
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.offset) searchParams.set('offset', params.offset.toString())
  if (params.search) searchParams.set('search', params.search)
  if (params.include_deleted) searchParams.set('include_deleted', 'true')

  const response = await fetch(`${API_BASE}/arche-type/${archeTypeName}?${searchParams}`)
  if (!response.ok) {
    throw new Error('Failed to fetch archetype data')
  }
  const result = await response.json()
  // Transform entities to flat records with id and component fields
  const data = result.entities?.map((entity: any) => ({
    id: entity.entityId,
    ...entity.components,
    ...(entity.deleted_at !== undefined ? { _deleted_at: entity.deleted_at } : {}),
  })) || []
  return {
    data,
    hasMore: result.entities && result.entities.length === (params.limit || 50),
    total: result.total,
  }
}

export interface EntityComponent {
  id: string
  name: string
  type_id: string
  data: unknown
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface EntityInspectorData {
  entity: {
    id: string
    created_at: string
    updated_at: string
    deleted_at: string | null
  }
  components: EntityComponent[]
}

export interface StudioStats {
  entities: {
    active: number
    deleted: number
    total: number
  }
  componentTypes: { name: string; count: number }[]
  archetypes: { name: string; entityCount: number; componentCount: number }[]
}

export async function fetchStats(): Promise<StudioStats> {
  const response = await fetch(`${API_BASE}/stats`)
  if (!response.ok) {
    throw new Error('Failed to fetch stats')
  }
  return response.json()
}

export interface ComponentTypeInfo {
  name: string
  entityCount: number
  partitionTable: string
  fields: string[]
}

export async function fetchComponents(): Promise<ComponentTypeInfo[]> {
  const response = await fetch(`${API_BASE}/components`)
  if (!response.ok) {
    throw new Error('Failed to fetch components')
  }
  const data = await response.json()
  return data.components
}

export async function fetchEntity(entityId: string): Promise<EntityInspectorData> {
  const response = await fetch(`${API_BASE}/entity/${entityId}`)
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to fetch entity' }))
    throw new Error(error.error || 'Failed to fetch entity')
  }
  return response.json()
}

export interface QueryResult {
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  duration: number
}

export async function executeQuery(sql: string): Promise<QueryResult> {
  const response = await fetch(`${API_BASE}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Query failed' }))
    throw new Error(error.error || 'Query failed')
  }
  return response.json()
}

export async function deleteTableRecords(tableName: string, ids: string[]): Promise<void> {
  const response = await fetch(`${API_BASE}/table/${tableName}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ids }),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to delete table records' }))
    throw new Error(error.error || 'Failed to delete table records')
  }
}

export async function deleteArcheTypeRecords(archeTypeName: string, entityIds: string[]): Promise<void> {
  const response = await fetch(`${API_BASE}/arche-type/${archeTypeName}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ entityIds }),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to delete archetype records' }))
    throw new Error(error.error || 'Failed to delete archetype records')
  }
}