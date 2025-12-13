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
  params: { limit?: number; offset?: number; search?: string } = {}
): Promise<ArcheTypeData> {
  const searchParams = new URLSearchParams()
  if (params.limit) searchParams.set('limit', params.limit.toString())
  if (params.offset) searchParams.set('offset', params.offset.toString())
  if (params.search) searchParams.set('search', params.search)

  const response = await fetch(`${API_BASE}/arche-type/${archeTypeName}?${searchParams}`)
  if (!response.ok) {
    throw new Error('Failed to fetch archetype data')
  }
  const result = await response.json()
  // Transform entities to flat records with id and component fields
  const data = result.entities?.map((entity: any) => ({
    id: entity.entityId,
    ...entity.components,
  })) || []
  return {
    data,
    hasMore: result.entities && result.entities.length === (params.limit || 50),
    total: result.total,
  }
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