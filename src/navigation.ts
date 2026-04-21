export type NavItem = {
  to: string
  label: string
  /** Pass to NavLink `end` for index routes */
  end?: boolean
}

export const mainNav: NavItem[] = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/journal', label: 'Paycheck Journal' },
  { to: '/accounts', label: 'Accounts' },
  { to: '/envelopes', label: 'Envelopes' },
  { to: '/transactions', label: 'Transactions' },
  { to: '/budget', label: 'Budget vs Actual' },
  { to: '/reports', label: 'Reports' },
  { to: '/savings', label: 'Savings Goals' },
  { to: '/debt', label: 'Debt Tracker' },
  { to: '/settings', label: 'Settings' },
]

export const pageTitleByPath: Record<string, string> = Object.fromEntries(
  mainNav.map((item) => [item.to === '/' ? '/' : item.to, item.label]),
)
