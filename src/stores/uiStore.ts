import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type UiState = {
  sidebarCollapsed: boolean
  darkMode: boolean
  setSidebarCollapsed: (value: boolean) => void
  toggleSidebarCollapsed: () => void
  setDarkMode: (value: boolean) => void
  toggleDarkMode: () => void
}

function applyDarkClass(dark: boolean) {
  document.documentElement.classList.toggle('dark', dark)
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      sidebarCollapsed: false,
      darkMode: false,
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      toggleSidebarCollapsed: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
      setDarkMode: (darkMode) => {
        applyDarkClass(darkMode)
        set({ darkMode })
      },
      toggleDarkMode: () => {
        const darkMode = !get().darkMode
        applyDarkClass(darkMode)
        set({ darkMode })
      },
    }),
    {
      name: 'budget-jump-ui',
      partialize: (s) => ({ sidebarCollapsed: s.sidebarCollapsed, darkMode: s.darkMode }),
      onRehydrateStorage: () => (state) => {
        if (state?.darkMode) applyDarkClass(true)
      },
    },
  ),
)
