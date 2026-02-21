import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface ArcheTypeSettingsState {
  useRealDbFieldName: boolean
  autoExpandRow: boolean
  showDeleted: boolean

  // Actions
  setUseRealDbFieldName: (value: boolean) => void
  setAutoExpandRow: (value: boolean) => void
  setShowDeleted: (value: boolean) => void
}

export const useArcheTypeSettings = create<ArcheTypeSettingsState>()(
  persist(
    (set) => ({
      useRealDbFieldName: false,
      autoExpandRow: true,
      showDeleted: false,

      setUseRealDbFieldName: (value) => set({ useRealDbFieldName: value }),
      setAutoExpandRow: (value) => set({ autoExpandRow: value }),
      setShowDeleted: (value) => set({ showDeleted: value }),
    }),
    {
      name: 'bunsane-archetype-settings',
    }
  )
)
