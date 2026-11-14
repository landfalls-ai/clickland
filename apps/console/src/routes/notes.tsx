import { useEffect, useState } from 'react';
import { NotebookPen, Plus } from 'lucide-react';
import { Button, Card, Chip, EmptyState, ErrorNote, Field, formatTime, Input, Markdown, Skeleton, Textarea } from '@clickland/ui';
import { SearchBox } from '@/components/search/search-box';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { Dialog } from '@/components/ui/dialog';
import { useCan } from '@/lib/auth';
import { api, useNotes, useWrite } from '@/lib/queries';

/** What people and agents learned: search (full text) and add. */
export function NotesPage() {
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const notes = useNotes(q);
  const canEdit = useCan('edit');
  const [adding, setAdding] = useState(false);

  // Search as you type, a moment after the last key.
  useEffect(() => {
    const t = setTimeout(() => setQ(draft.trim()), 300);
    return () => clearTimeout(t);
  }, [draft]);

  return (
    <>
      <PageHeader
        title="Notes"
        actions={
          canEdit && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus className="size-3.5" /> Add note
            </Button>
          )
        }
      />
      <PageBody className="flex flex-col gap-3">
        <SearchBox value={draft} onChange={setDraft} onSubmit={() => setQ(draft.trim())} placeholder="Search notes" />
        {notes.isLoading ? (
          <Skeleton lines={6} />
        ) : notes.error ? (
          <ErrorNote error={notes.error} />
        ) : !notes.data?.notes.length ? (
          <Card>
            <EmptyState
              icon={<NotebookPen className="size-5" />}
              title={q ? 'No notes match' : 'No notes yet'}
              hint="Notes hold what people and agents learned about an incident or a service; the assistant searches them."
            />
          </Card>
        ) : (
          <div className="flex flex-col gap-2" data-testid="notes">
            {notes.data.notes.map((n) => (
              <Card key={n.id} className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="min-w-0 flex-1 text-[14px] font-semibold text-t1">{n.title}</h2>
                  {n.service && <Chip mono>{n.service}</Chip>}
                  {n.tags.map((t) => (
                    <Chip key={t}>{t}</Chip>
                  ))}
                </div>
                <div className="text-[11px] text-t3">
                  {n.author} · {formatTime(n.createdAt, { date: true, ms: false })}
                </div>
                <Markdown text={n.body} />
                {n.traceIds.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 text-[12px]">
                    {n.traceIds.map((t) => (
                      <a key={t} href={`/traces/${t}`} className="font-mono text-ac hover:underline">
                        {t.slice(0, 16)}
                      </a>
                    ))}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </PageBody>
      {adding && <AddNote onClose={() => setAdding(false)} />}
    </>
  );
}

function AddNote({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [service, setService] = useState('');
  const [tags, setTags] = useState('');
  const [traces, setTraces] = useState('');
  const create = useWrite(api.createNote, ['notes']);
  const split = (s: string) => s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  return (
    <Dialog
      title="Add a note"
      onClose={onClose}
      onSubmit={() =>
        create.mutate(
          { title: title.trim(), body, service: service.trim() || null, tags: split(tags), traceIds: split(traces) },
          { onSuccess: onClose },
        )
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={create.isPending} disabled={!title.trim() || !body.trim()}>
            Add note
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
        </Field>
        <Field label="Body" hint="Markdown.">
          <Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} required />
        </Field>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Service">
            <Input value={service} onChange={(e) => setService(e.target.value)} placeholder="optional" />
          </Field>
          <Field label="Tags" hint="Comma separated.">
            <Input value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
        </div>
        <Field label="Trace ids" hint="Comma separated.">
          <Input value={traces} onChange={(e) => setTraces(e.target.value)} className="font-mono" />
        </Field>
        <ErrorNote error={create.error} />
      </div>
    </Dialog>
  );
}
