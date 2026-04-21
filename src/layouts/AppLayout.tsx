import { Outlet } from 'react-router-dom'
import { DesktopSidebar } from '../components/layout/DesktopSidebar'
import { HeaderBar } from '../components/layout/HeaderBar'
import { MobileTabBar } from '../components/layout/MobileTabBar'
import { useUiStore } from '../stores/uiStore'

export function AppLayout() {
  const darkMode = useUiStore((s) => s.darkMode)
  const toggleDarkMode = useUiStore((s) => s.toggleDarkMode)

  return (
    <div className="app-shell">
      <div className="flex min-h-dvh w-full">
        <DesktopSidebar />
        <div className="flex min-h-dvh min-w-0 flex-1 flex-col">
          <HeaderBar />
          <div className="hidden items-center justify-end gap-2 border-b border-zinc-200/80 bg-white/85 px-4 py-2 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-900/75 lg:flex">
            <button
              type="button"
              onClick={() => toggleDarkMode()}
              className="btn-secondary px-3 py-2 text-sm"
              aria-pressed={darkMode}
            >
              {darkMode ? 'Light mode' : 'Dark mode'}
            </button>
          </div>
          <main className="min-w-0 flex-1 px-3 pb-[calc(6.5rem+env(safe-area-inset-bottom))] pt-4 sm:px-5 sm:pt-5 lg:px-8 lg:pb-10 xl:px-10 2xl:px-14">
            <Outlet />
          </main>
        </div>
      </div>
      <MobileTabBar />
    </div>
  )
}
