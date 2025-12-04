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

export async function deleteTableRecord(tableName: string, id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/table/${tableName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'delete', id }),
  })
  if (!response.ok) {
    throw new Error('Failed to delete table record')
  }
}

export async function deleteArcheTypeRecord(archeTypeName: string, id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/arche-type/${archeTypeName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'delete', id }),
  })
  if (!response.ok) {
    throw new Error('Failed to delete archetype record')
  }
}