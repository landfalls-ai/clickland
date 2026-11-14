import {
  Bell,
  Bot,
  ChartLine,
  LayoutDashboard,
  type LucideIcon,
  NotebookPen,
  Search,
  Server,
  Settings,
  Shapes,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** On the phone's bottom bar (the rest are under More). */
  bar?: boolean;
}

/** The sidebar on desktop; on a phone the `bar` items are the bottom bar and the rest sit under More. */
export const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: 'Explore',
    items: [
      { href: '/search', label: 'Search', icon: Search, bar: true },
      { href: '/services', label: 'Services', icon: Server, bar: true },
      { href: '/metrics', label: 'Metrics', icon: ChartLine },
      { href: '/patterns', label: 'Patterns', icon: Shapes },
    ],
  },
  {
    label: 'Watch',
    items: [
      { href: '/alerts', label: 'Alerts', icon: Bell },
      { href: '/dashboards', label: 'Dashboards', icon: LayoutDashboard, bar: true },
      { href: '/notes', label: 'Notes', icon: NotebookPen },
    ],
  },
];

export const ASSISTANT: NavItem = { href: '/assistant', label: 'Assistant', icon: Bot, bar: true };
export const SETTINGS: NavItem = { href: '/settings', label: 'Settings', icon: Settings };

export const ALL_PAGES: NavItem[] = [...NAV_GROUPS.flatMap((g) => g.items), ASSISTANT, SETTINGS];
