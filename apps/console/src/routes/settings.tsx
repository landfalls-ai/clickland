import { useState } from 'react';
import { ExternalLink, KeyRound, Plus, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import { ApiScope, WebhookEvent } from '@clickland/contracts';
import {
  Badge,
  Button,
  Card,
  Chip,
  ErrorNote,
  Field,
  formatTime,
  Input,
  PickMany,
  SectionLabel,
  Select,
  Skeleton,
} from '@clickland/ui';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { UserRow } from '@/components/shell/sidebar';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { OnceSecret } from '@/components/ui/copy-button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { roleOf, useCan, useMe } from '@/lib/auth';
import { api, useAlerts, useKeys, useWebhooks, useWrite } from '@/lib/queries';

const CLICKSTACK = 'http://127.0.0.1:28123/clickstack';

/** You, the theme, API keys and webhooks (admins), and the ClickStack bridge. */
export function SettingsPage() {
  const me = useMe();
  const admin = useCan('admin');
  return (
    <>
      <PageHeader title="Settings" />
      <PageBody className="flex max-w-3xl flex-col gap-4">
        <Card className="flex flex-col gap-3">
          <SectionLabel>You</SectionLabel>
          {me.data && <UserRow me={me.data} />}
          <p className="text-[12px] text-t3">
            Role <b className="text-t2">{roleOf(me.data)}</b>: viewers read; editors also change alerts, notes and
            dashboards; admins also manage API keys and webhooks.
            {me.data?.kind === 'person' &&
              ` Your Landbright groups decide it (${(me.data.user.groups ?? []).join(', ') || 'none'}).`}
          </p>
          <div className="flex items-center gap-3">
            <span className="text-[12px] text-t2">Theme</span>
            <ThemeToggle />
          </div>
        </Card>
        <Card className="flex flex-col gap-2">
          <SectionLabel>ClickStack (embedded)</SectionLabel>
          <p className="text-[13px] text-t2">
            The stock ClickStack UI that ClickHouse embeds, over the same tables: the bridge while Clickland’s own
            screens grow.
          </p>
          <a
            href={CLICKSTACK}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-1.5 text-[13px] font-semibold text-ac hover:underline"
          >
            <ExternalLink className="size-3.5" /> Open ClickStack
          </a>
        </Card>
        {admin ? (
          <>
            <ApiKeys />
            <Webhooks />
          </>
        ) : (
          <p className="text-[12px] text-t3">API keys and webhooks are for admins.</p>
        )}
      </PageBody>
    </>
  );
}

function ApiKeys() {
  const keys = useKeys(true);
  const [creating, setCreating] = useState(false);
  const [revoke, setRevoke] = useState<string | null>(null);
  const remove = useWrite(api.deleteKey, ['keys']);
  return (
    <Card className="flex flex-col gap-2" testId="api-keys">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-t3" />
        <SectionLabel>API keys</SectionLabel>
        <Button size="sm" className="ml-auto" onClick={() => setCreating(true)}>
          <Plus className="size-3.5" /> New key
        </Button>
      </div>
      {keys.isLoading ? (
        <Skeleton lines={3} />
      ) : keys.error ? (
        <ErrorNote error={keys.error} />
      ) : !keys.data?.length ? (
        <p className="text-[13px] text-t3">No keys yet.</p>
      ) : (
        keys.data.map((k) => (
          <div key={k.id} className="flex flex-wrap items-center gap-2 border-t border-hair pt-2">
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-t1">{k.name}</span>
            <span className="flex flex-wrap gap-1">
              {k.scopes.map((s) => (
                <Chip key={s} mono>
                  {s}
                </Chip>
              ))}
            </span>
            <span className="text-[11px] text-t3">{formatTime(k.createdAt, { date: true, ms: false })}</span>
            <Button size="icon-sm" variant="ghost" aria-label={`Revoke ${k.name}`} onClick={() => setRevoke(k.id)}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))
      )}
      {creating && <NewKey onClose={() => setCreating(false)} />}
      {revoke && (
        <ConfirmDialog
          title="Revoke this key?"
          message="Anything using it stops working at once."
          action="Revoke"
          busy={remove.isPending}
          onClose={() => setRevoke(null)}
          onConfirm={() => remove.mutate(revoke, { onSuccess: () => setRevoke(null) })}
        />
      )}
    </Card>
  );
}

function NewKey({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['read']);
  const create = useWrite(api.createKey, ['keys']);
  return (
    <Dialog
      title="New API key"
      onClose={onClose}
      onSubmit={() => !create.data && create.mutate({ name: name.trim(), scopes })}
      footer={
        create.data ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              loading={create.isPending}
              disabled={!name.trim() || !scopes.length}
            >
              Create key
            </Button>
          </>
        )
      }
    >
      {create.data ? (
        <OnceSecret label="API key" value={create.data.key} />
      ) : (
        <div className="flex flex-col gap-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="landflow-plugin" autoFocus />
          </Field>
          <Field label="Scopes">
            <PickMany
              options={ApiScope.options.map((s) => ({ value: s, label: s }))}
              value={scopes}
              onChange={setScopes}
            />
          </Field>
          <ErrorNote error={create.error} />
        </div>
      )}
    </Dialog>
  );
}

function Webhooks() {
  const hooks = useWebhooks(true);
  const [creating, setCreating] = useState(false);
  const [del, setDel] = useState<string | null>(null);
  const remove = useWrite(api.deleteWebhook, ['webhooks']);
  return (
    <Card className="flex flex-col gap-2" testId="webhooks">
      <div className="flex items-center gap-2">
        <WebhookIcon className="size-4 text-t3" />
        <SectionLabel>Webhooks</SectionLabel>
        <Button size="sm" className="ml-auto" onClick={() => setCreating(true)}>
          <Plus className="size-3.5" /> New webhook
        </Button>
      </div>
      <p className="text-[12px] text-t3">Signed as Standard Webhooks; retried for about 40 minutes.</p>
      {hooks.isLoading ? (
        <Skeleton lines={3} />
      ) : hooks.error ? (
        <ErrorNote error={hooks.error} />
      ) : !hooks.data?.webhooks.length ? (
        <p className="text-[13px] text-t3">No webhooks yet.</p>
      ) : (
        hooks.data.webhooks.map((w) => (
          <div key={w.id} className="flex flex-col gap-1 border-t border-hair pt-2">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-t1" title={w.url}>
                {w.url}
              </span>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Delete the webhook to ${w.url}`}
                onClick={() => setDel(w.id)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {w.events.map((e) => (
                <Badge key={e} tone="neutral">
                  {e}
                </Badge>
              ))}
              {w.alertId && <Chip mono>{w.alertId}</Chip>}
              {w.description && <span className="text-[12px] text-t3">{w.description}</span>}
            </div>
          </div>
        ))
      )}
      {creating && <NewWebhook onClose={() => setCreating(false)} />}
      {del && (
        <ConfirmDialog
          title="Delete this webhook?"
          message="Deliveries stop, including retries in flight."
          action="Delete"
          busy={remove.isPending}
          onClose={() => setDel(null)}
          onConfirm={() => remove.mutate(del, { onSuccess: () => setDel(null) })}
        />
      )}
    </Card>
  );
}

function NewWebhook({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['alert.firing', 'alert.resolved']);
  const [alertId, setAlertId] = useState('');
  const [description, setDescription] = useState('');
  const alerts = useAlerts();
  const create = useWrite(api.createWebhook, ['webhooks']);
  return (
    <Dialog
      title="New webhook"
      onClose={onClose}
      onSubmit={() => !create.data && create.mutate({ url: url.trim(), events, alertId: alertId || null, description })}
      footer={
        create.data ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              loading={create.isPending}
              disabled={!/^https?:\/\//.test(url) || !events.length}
            >
              Create webhook
            </Button>
          </>
        )
      }
    >
      {create.data ? (
        <OnceSecret label="Signing secret" value={create.data.secret} />
      ) : (
        <div className="flex flex-col gap-3">
          <Field label="URL">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://127.0.0.1:3000/api/webhooks/…"
              className="font-mono"
              autoFocus
            />
          </Field>
          <Field label="Events">
            <PickMany
              options={WebhookEvent.options.map((e) => ({ value: e, label: e }))}
              value={events}
              onChange={setEvents}
            />
          </Field>
          <Field label="Only for one alert">
            <Select value={alertId} onChange={(e) => setAlertId(e.target.value)}>
              <option value="">Every alert</option>
              {alerts.data?.alerts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Description">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <ErrorNote error={create.error} />
        </div>
      )}
    </Dialog>
  );
}
