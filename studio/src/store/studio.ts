import { create } from 'zustand'
import { persist } from "zustand/middleware";

export interface Metadata {
  archeTypes: Record<string, {
    fieldName: string
    componentName: string
    fieldLabel: string
    nullable?: boolean
  }[]>
}

interface StudioState {
    metadata: Metadata | null;
    tables: string[];
    isLoading: boolean;
    error: string | null;
    isSidebarCollapsed: boolean;
    expandedSections: Record<string, boolean>;

    // Actions
    setMetadata: (metadata: Metadata) => void;
    setTables: (tables: string[]) => void;
    setLoading: (loading: boolean) => void;
    setError: (error: string | null) => void;
    setSidebarCollapsed: (collapsed: boolean) => void;
    toggleSection: (section: string) => void;
}

export const useStudioStore = create<StudioState>()(
    persist(
        (set) => ({
            metadata: null,
            tables: [],
            isLoading: false,
            error: null,
            isSidebarCollapsed: false,
            expandedSections: {
                archeTypes: true,
                tables: true,
            },

            setMetadata: (metadata) => set({ metadata }),
            setTables: (tables) => set({ tables }),
            setLoading: (loading) => set({ isLoading: loading }),
            setError: (error) => set({ error }),
            setSidebarCollapsed: (collapsed) =>
                set({ isSidebarCollapsed: collapsed }),
            toggleSection: (section) =>
                set((state) => ({
                    expandedSections: {
                        ...state.expandedSections,
                        [section]: !state.expandedSections[section],
                    },
                })),
        }),
        {
            name: "bunsane-studio-storage",
            partialize: (state) => ({
                isSidebarCollapsed: state.isSidebarCollapsed,
                expandedSections: state.expandedSections,
            }),
        }
    )
);