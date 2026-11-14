import { Panel, ViewSpec, viewMarker, type View } from '@clickland/contracts';
import type { Sql } from './clients.js';
import type { Config } from './config.js';
import { ApiError, notFound } from './errors.js';
import { newId } from './ids.js';

export const VIEW_RESOURCE_URI = 'ui://clickland/view';

type Row = {
  id: string;
  title: string;
  spec: ViewSpec;
  pinned: boolean;
  version: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
};

const toView = (r: Row): View => ({
  id: r.id,
  title: r.title,
  spec: r.spec,
  pinned: r.pinned,
  version: r.version,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

/** Gives every panel a stable id, so the editor and agents can refer to one across saves. */
function withPanelIds(spec: ViewSpec): ViewSpec {
  const used = new Set<string>();
  const panels = spec.panels.map((p) => {
    let id = p.id && !used.has(p.id) ? p.id : newId('pn');
    while (used.has(id)) id = newId('pn');
    used.add(id);
    return { ...p, id };
  });
  return { ...spec, panels };
}

function checkSpec(spec: unknown): ViewSpec {
  const parsed = ViewSpec.safeParse(spec);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new ApiError(
      'bad_request',
      `The view is not valid at ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      { issues: parsed.error.issues },
    );
  }
  return withPanelIds(parsed.data);
}

export class Views {
  constructor(
    private readonly pg: Sql,
    private readonly config: Config,
  ) {}

  links(id: string) {
    return { id, url: `${this.config.consoleUrl}/views/${id}`, resourceUri: VIEW_RESOURCE_URI, marker: viewMarker(id) };
  }

  async create(
    input: { spec: unknown; pinned?: boolean },
    createdBy: string,
  ): Promise<View & ReturnType<Views['links']>> {
    const spec = checkSpec(input.spec);
    const [row] = await this.pg<Row[]>`
      INSERT INTO views (id, title, spec, pinned, created_by)
      VALUES (${newId('vw')}, ${spec.title}, ${this.pg.json(spec as never)}, ${input.pinned ?? false}, ${createdBy})
      RETURNING *`;
    const view = toView(row!);
    return { ...view, ...this.links(view.id) };
  }

  async list(filter: { pinned?: boolean; limit?: number }) {
    const pinned = filter.pinned ?? null;
    const rows = await this.pg<Row[]>`
      SELECT * FROM views WHERE (${pinned}::boolean IS NULL OR pinned = ${pinned})
      ORDER BY updated_at DESC LIMIT ${Math.min(filter.limit ?? 100, 500)}`;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.spec.description ?? null,
      pinned: r.pinned,
      panels: r.spec.panels.length,
      version: r.version,
      createdBy: r.created_by,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    }));
  }

  async get(id: string): Promise<View & ReturnType<Views['links']>> {
    const [row] = await this.pg<Row[]>`SELECT * FROM views WHERE id = ${id}`;
    if (!row) throw notFound('View');
    return { ...toView(row), ...this.links(row.id) };
  }

  /** Changes a view. With `version`, a save that lost a race fails with 409 instead of overwriting someone's edit. */
  async update(id: string, input: { spec?: unknown; title?: string; pinned?: boolean; version?: number }) {
    const current = await this.get(id);
    if (input.version !== undefined && input.version !== current.version)
      throw new ApiError(
        'conflict',
        `The view changed since version ${input.version} (now ${current.version}); reload it`,
        { version: current.version },
      );
    let spec = input.spec !== undefined ? checkSpec(input.spec) : current.spec;
    if (input.title !== undefined) spec = { ...spec, title: input.title };
    const pinned = input.pinned ?? current.pinned;
    const [row] = await this.pg<Row[]>`
      UPDATE views SET spec = ${this.pg.json(spec as never)}, title = ${spec.title}, pinned = ${pinned},
        version = version + 1, updated_at = now()
      WHERE id = ${id} AND version = ${current.version}
      RETURNING *`;
    if (!row) throw new ApiError('conflict', 'The view changed while saving; reload it');
    return { ...toView(row), ...this.links(row.id) };
  }

  async addPanel(id: string, panel: unknown, position?: number) {
    const current = await this.get(id);
    const parsed = Panel.safeParse(panel);
    if (!parsed.success)
      throw new ApiError('bad_request', `The panel is not valid: ${parsed.error.issues[0]!.message}`, {
        issues: parsed.error.issues,
      });
    const panels = [...current.spec.panels];
    panels.splice(position ?? panels.length, 0, parsed.data);
    return this.update(id, { spec: { ...current.spec, panels }, version: current.version });
  }

  async removePanel(id: string, index: number) {
    const current = await this.get(id);
    if (!Number.isInteger(index) || index < 0 || index >= current.spec.panels.length) throw notFound('Panel');
    if (current.spec.panels.length === 1)
      throw new ApiError('bad_request', 'A view keeps at least one panel; delete the view instead');
    const panels = current.spec.panels.filter((_, i) => i !== index);
    return this.update(id, { spec: { ...current.spec, panels }, version: current.version });
  }

  async delete(id: string): Promise<void> {
    const rows = await this.pg`DELETE FROM views WHERE id = ${id} RETURNING id`;
    if (rows.length === 0) throw notFound('View');
  }
}
