import { useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { ExternalLink, MoreHorizontal, X } from 'lucide-react';
import { cn } from '@clickland/ui';
import type { Me } from '@/lib/types';
import { ALL_PAGES } from '@/nav';
import { UserRow } from './sidebar';
import { ThemeToggle } from './theme-toggle';

/** The phone's navigation (below md): four pages on a bottom bar and More, a sheet with everything else. */
export function BottomBar({ me }: { me: Me }) {
  const { pathname } = useLocation();
  const [moreOn, setMoreOn] = useState<string | null>(null);
  const more = moreOn === pathname;
  const bar = ALL_PAGES.filter((p) => p.bar);
  const rest = ALL_PAGES.filter((p) => !p.bar);
  const inRest = rest.some((p) => pathname.startsWith(p.href));
  return (
    <>
      {more && (
        <div className="fixed inset-0 z-40 bg-overlay md:hidden" onClick={() => setMoreOn(null)} aria-hidden />
      )}
      {more && (
        <div
          role="dialog"
          aria-label="More"
          className="pb-safe fixed inset-x-0 bottom-0 z-50 flex flex-col gap-1 rounded-t-2xl border-t border-hair bg-sf px-3 pt-3 shadow-pop animate-in md:hidden"
        >
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="text-[13px] font-semibold text-t1">More</span>
            <button
              type="button"
              aria-label="Close"
              onClick={() => setMoreOn(null)}
              className="grid size-8 place-items-center rounded-full text-t3 hover:bg-acdim"
            >
              <X className="size-4" />
            </button>
          </div>
          {rest.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.href}
                to={item.href}
                onClick={() => setMoreOn(null)}
                className={({ isActive }) =>
                  cn('flex h-11 items-center gap-3 rounded-lg px-3 text-[14px]', isActive ? 'bg-acdim font-semibold' : 'text-t1')
                }
              >
                <Icon className="size-5 text-t2" strokeWidth={1.7} />
                {item.label}
              </NavLink>
            );
          })}
          <a href="http://127.0.0.1:28123/clickstack" target="_blank" rel="noreferrer" className="flex h-11 items-center gap-3 rounded-lg px-3 text-[14px] text-t1">
            <ExternalLink className="size-5 text-t2" strokeWidth={1.7} /> ClickStack (embedded)
          </a>
          <div className="flex flex-col gap-3 px-3 pb-3 pt-2">
            <ThemeToggle />
            <UserRow me={me} />
          </div>
        </div>
      )}
      <nav
        aria-label="Main"
        className="pb-safe fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-hair bg-sf2/95 backdrop-blur md:hidden"
      >
        {bar.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.href}
              to={item.href}
              className={({ isActive }) =>
                cn(
                  'flex h-14 flex-col items-center justify-center gap-0.5 text-[10px]',
                  isActive ? 'font-semibold text-t1' : 'text-t3',
                )
              }
            >
              <Icon className="size-5" strokeWidth={1.7} />
              {item.label}
            </NavLink>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOn(more ? null : pathname)}
          aria-expanded={more}
          className={cn(
            'flex h-14 flex-col items-center justify-center gap-0.5 text-[10px]',
            more || inRest ? 'font-semibold text-t1' : 'text-t3',
          )}
        >
          <MoreHorizontal className="size-5" strokeWidth={1.7} />
          More
        </button>
      </nav>
    </>
  );
}
