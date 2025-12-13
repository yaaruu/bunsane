import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface ArcheTypeSettingsState {
  useRealDbFieldName: boolean
  autoExpandRow: boolean

  // Actions
  setUseRealDbFieldName: (value: boolean) => void
  setAutoExpandRow: (value: boolean) => void
}

export const useArcheTypeSettings = create<ArcheTypeSettingsState>()(
  persist(
    (set) => ({
      useRealDbFieldName: false,
      autoExpandRow: true,

      setUseRealDbFieldName: (value) => set({ useRealDbFieldName: value }),
      setAutoExpandRow: (value) => set({ autoExpandRow: value }),
    }),
    {
      name: 'bunsane-archetype-settings',
    }
  )
)
