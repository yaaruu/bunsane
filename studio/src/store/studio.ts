import { create } from 'zustand'

interface Metadata {
  archeTypes: Record<string, {
    fieldName: string
    componentName: string
    fieldLabel: string
  }[]>
}

interface StudioState {
  metadata: Metadata | null
  tables: string[]
  isLoading: boolean
  error: string | null

  // Actions
  setMetadata: (metadata: Metadata) => void
  setTables: (tables: string[]) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
}

export const useStudioStore = create<StudioState>((set) => ({
  metadata: null,
  tables: [],
  isLoading: false,
  error: null,

  setMetadata: (metadata) => set({ metadata }),
  setTables: (tables) => set({ tables }),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
}))