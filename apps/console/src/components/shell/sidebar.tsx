import { Link, NavLink } from 'react-router';
import { Bot, ExternalLink, LogOut } from 'lucide-react';
import { cn } from '@clickland/ui';
import { roleOf, signOut } from '@/lib/auth';
import { useViews } from '@/lib/queries';
import type { Me } from '@/lib/types';
import { NAV_GROUPS, type NavItem, SETTINGS } from '@/nav';
import { useAssistant } from '../assistant/assistant-context';
import { Mark } from './mark';
import { ThemeToggle } from './theme-toggle';

const rowClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex h-9 items-center gap-3 rounded-lg px-2.5 text-[13px] transition-colors duration-[120ms]',
    isActive ? 'bg-acdim font-semibold text-t1' : 'text-t2 hover:bg-acdim hover:text-t1',
  );

function NavRow({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink to={item.href} className={rowClass}>
      <Icon className="size-[18px] shrink-0" strokeWidth={1.7} />
      <span className="truncate">{item.label}</span>
    </NavLink>
  );
}

/** Pinned dashboards, listed under Dashboards (api.md: "the console lists dashboards in its navigation"). */
function DashboardLinks() {
  const views = useViews(true);
  const list = views.data?.views ?? [];
  if (!list.length) return null;
  return (
    <div className="ml-[21px] flex flex-col border-l border-hair pl-2" data-testid="nav-dashboards">
      {list.slice(0, 8).map((v) => (
        <NavLink
          key={v.id}
          to={`/dashboards/${v.id}`}
          className={({ isActive }) =>
            cn(
              'truncate rounded-md px-2 py-1 text-[12px] transition-colors',
              isActive ? 'bg-acdim font-semibold text-t1' : 'text-t3 hover:bg-acdim hover:text-t1',
            )
          }
        >
          {v.title}
        </NavLink>
      ))}
    </div>
  );
}

/** The left rail on desktop (md and up), after Landbright's: mark, grouped navigation, theme and the user. */
export function Sidebar({ me }: { me: Me }) {
  const assistant = useAssistant();
  return (
    <aside className="sticky top-0 hidden h-screen w-[200px] shrink-0 flex-col overflow-y-auto border-r border-hair bg-sf2 px-1.5 py-2.5 md:flex">
      <Link to="/search" className="mb-2 flex items-center gap-2.5 px-2.5 py-1">
        <Mark size="md" />
        <span className="truncate text-[13px] font-semibold text-t1">Clickland</span>
      </Link>
      <nav className="flex flex-col" aria-label="Main">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col gap-0.5">
            <div className="px-2.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
              {group.label}
            </div>
            {group.items.map((item) => (
              <div key={item.href} className="flex flex-col gap-0.5">
                <NavRow item={item} />
                {item.href === '/dashboards' && <DashboardLinks />}
              </div>
            ))}
          </div>
        ))}
        <div className="px-2.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Ask</div>
        <button
          type="button"
          onClick={() => assistant.setOpen(!assistant.open)}
          aria-pressed={assistant.open}
          className={rowClass({ isActive: assistant.open })}
        >
          <Bot className="size-[18px] shrink-0" strokeWidth={1.7} />
          <span className="truncate">Assistant</span>
          {assistant.streaming && <span className="ml-auto size-1.5 animate-pulse-soft rounded-full bg-ac" />}
        </button>
      </nav>

      <div className="mt-auto flex flex-col gap-0.5 pt-3">
        <NavRow item={SETTINGS} />
        <a href="http://127.0.0.1:28123/clickstack" target="_blank" rel="noreferrer" className={rowClass({ isActive: false })}>
          <ExternalLink className="size-[18px] shrink-0" strokeWidth={1.7} />
          <span className="truncate">ClickStack</span>
        </a>
      </div>
      <div className="flex flex-col gap-2.5 px-2.5 pb-1 pt-2">
        <ThemeToggle />
        <UserRow me={me} />
      </div>
    </aside>
  );
}

export function UserRow({ me }: { me: Me }) {
  return (
    <div className="flex items-center gap-2 border-t border-hair pt-2.5" data-testid="user-menu">
      <span
        className="grid size-7 shrink-0 place-items-center rounded-full bg-acdim text-[11px] font-semibold text-ac"
        aria-hidden
      >
        {initials(me.user.name)}
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-[12px] font-semibold text-t1">{me.user.name}</div>
        <div className="truncate text-[11px] text-t3" title={me.user.email}>
          {roleOf(me)}
          {me.authMode === 'dev' ? ' · dev' : ''}
        </div>
      </div>
      {me.authMode !== 'dev' && (
        <button
          type="button"
          aria-label="Sign out"
          title="Sign out"
          onClick={() => void signOut()}
          className="grid size-7 shrink-0 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1"
        >
          <LogOut className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase() || '?';
}
