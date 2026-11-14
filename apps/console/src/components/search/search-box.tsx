import { forwardRef } from 'react';
import { CircleHelp, Search } from 'lucide-react';
import { cn } from '@clickland/ui';
import { SYNTAX_HELP } from '@/lib/search-query';
import { Popover } from '../ui/popover';

/** The search input with the language's help a click away (examples insert themselves). */
export const SearchBox = forwardRef<
  HTMLInputElement,
  {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    placeholder?: string;
    invalid?: boolean;
    className?: string;
  }
>(function SearchBox({ value, onChange, onSubmit, placeholder, invalid, className }, ref) {
  return (
    <form
      role="search"
      className={cn(
        'flex h-9 min-w-0 items-center gap-1 rounded-[10px] border bg-wl pl-3 pr-1 focus-within:border-ac',
        invalid ? 'border-rdbd' : 'border-hair',
        className,
      )}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <Search className="size-3.5 shrink-0 text-t3" />
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? 'level:error service:api timeout'}
        aria-label="Search"
        aria-invalid={invalid || undefined}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="h-full min-w-0 flex-1 bg-transparent font-mono text-[13px] text-t1 outline-none placeholder:text-t3"
      />
      <Popover
        label="Search syntax"
        trigger={({ toggle, open }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label="Search syntax"
            title="Search syntax"
            className="grid size-7 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-ac"
          >
            <CircleHelp className="size-4" />
          </button>
        )}
      >
        {(close) => (
          <SyntaxHelp
            onPick={(example) => (onChange(value.trim() ? `${value.trim()} ${example}` : example), close())}
          />
        )}
      </Popover>
    </form>
  );
});

export function SyntaxHelp({ onPick }: { onPick?: (example: string) => void }) {
  return (
    <div className="flex flex-col gap-1 md:w-[440px]" data-testid="syntax-help">
      <p className="mb-1 text-[12px] text-t2">
        Lucene-style, as ClickStack’s search box. Clauses side by side are ANDed; AND binds tighter than OR.
      </p>
      {SYNTAX_HELP.map((h) => (
        <button
          key={h.example}
          type="button"
          onClick={() => onPick?.(h.example)}
          className="grid grid-cols-1 gap-x-3 rounded-lg px-2 py-1 text-left hover:bg-acdim md:grid-cols-[180px_1fr]"
        >
          <code className="font-mono text-[12px] text-ac">{h.example}</code>
          <span className="text-[12px] text-t2">{h.meaning}</span>
        </button>
      ))}
    </div>
  );
}

/** A syntax error under the box, pointing at the character. */
export function QueryError({ query, message, position }: { query: string; message: string; position?: number }) {
  return (
    <div role="alert" className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2 text-[12px] text-rd">
      <p>{message}</p>
      {position !== undefined && position <= query.length && (
        <pre className="mt-1 overflow-x-auto font-mono text-[12px] leading-tight text-t1">
          {query}
          {'\n'}
          <span className="text-rd">{' '.repeat(position)}^</span>
        </pre>
      )}
    </div>
  );
}
