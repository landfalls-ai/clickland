import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ViewSpec } from '@clickland/contracts';
import { DashboardEditor } from '@/components/dashboards/editor';
import {
  addPanel,
  convertPanel,
  movePanel,
  newPanel,
  removePanel,
  updatePanel,
  withIds,
} from '@/components/dashboards/spec-ops';

const spec = (): ViewSpec => ({
  title: 'Checkout',
  range: { lastMinutes: 60 },
  panels: [
    { id: 'a', type: 'stat', title: 'Errors', signal: 'logs', query: 'level:error', width: 'half' },
    { id: 'b', type: 'logs', title: 'Latest', query: 'service:api', limit: 25, width: 'full' },
    { id: 'c', type: 'markdown', title: 'Runbook', text: 'Restart it.', width: 'half' },
  ],
});

const titles = (s: ViewSpec) => s.panels.map((p) => p.title);

describe('spec edits', () => {
  it('adds, updates, removes and moves panels without touching the rest', () => {
    const s = spec();
    expect(titles(addPanel(s, newPanel('services', 'd')))).toEqual(['Errors', 'Latest', 'Runbook', 'Services']);
    expect(titles(addPanel(s, newPanel('services', 'd'), 0))).toEqual(['Services', 'Errors', 'Latest', 'Runbook']);
    expect(updatePanel(s, 1, { ...s.panels[1]!, title: 'Newest' }).panels[1]!.title).toBe('Newest');
    expect(titles(removePanel(s, 0))).toEqual(['Latest', 'Runbook']);
    expect(titles(movePanel(s, 0, 2))).toEqual(['Latest', 'Runbook', 'Errors']);
    expect(titles(movePanel(s, 2, 0))).toEqual(['Runbook', 'Errors', 'Latest']);
    expect(movePanel(s, 5, 0)).toBe(s);
    expect(titles(s)).toEqual(['Errors', 'Latest', 'Runbook']);
  });

  it('keeps the title, width and search when a panel changes type', () => {
    const bar = convertPanel(spec().panels[0]!, 'bar');
    expect(bar).toMatchObject({
      id: 'a',
      type: 'bar',
      title: 'Errors',
      width: 'half',
      query: 'level:error',
      groupBy: 'service',
    });
  });

  it('gives panels ids only when some lack one', () => {
    const s = spec();
    expect(withIds(s)).toBe(s);
    const bare = { ...s, panels: s.panels.map(({ id: _id, ...p }) => p as ViewSpec['panels'][number]) };
    expect(withIds(bare).panels.every((p) => p.id)).toBe(true);
  });
});

function Harness({ onSpec }: { onSpec: (s: ViewSpec) => void }) {
  const [value, setValue] = useState(spec);
  return (
    <DashboardEditor
      spec={value}
      onChange={(next) => {
        setValue(next);
        onSpec(next);
      }}
    />
  );
}

describe('DashboardEditor', () => {
  const setup = () => {
    const onSpec = vi.fn<(s: ViewSpec) => void>();
    render(<Harness onSpec={onSpec} />);
    const last = () => onSpec.mock.lastCall![0];
    return { user: userEvent.setup(), onSpec, last };
  };

  it('reorders with the arrow buttons', async () => {
    const { user, last } = setup();
    expect(screen.getByRole('button', { name: 'Move Errors up' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Move Errors down' }));
    expect(titles(last())).toEqual(['Latest', 'Errors', 'Runbook']);
    await user.click(screen.getByRole('button', { name: 'Move Runbook up' }));
    expect(titles(last())).toEqual(['Latest', 'Runbook', 'Errors']);
    expect(screen.getByRole('button', { name: 'Move Errors down' })).toBeDisabled();
  });

  it('removes a panel', async () => {
    const { user, last } = setup();
    await user.click(screen.getByRole('button', { name: 'Remove Latest' }));
    expect(titles(last())).toEqual(['Errors', 'Runbook']);
    expect(screen.queryByRole('button', { name: 'Remove Latest' })).not.toBeInTheDocument();
  });

  it('edits a panel title', async () => {
    const { user, last } = setup();
    await user.click(screen.getByRole('button', { name: 'Edit Errors' }));
    const title = screen.getByRole('textbox', { name: 'Title' });
    await user.clear(title);
    await user.type(title, 'Error count');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(last().panels[0]).toMatchObject({ id: 'a', type: 'stat', title: 'Error count', query: 'level:error' });
  });

  it('adds a panel of a picked type at the end', async () => {
    const { user, last } = setup();
    await user.click(screen.getByRole('button', { name: /add panel/i }));
    const picker = screen.getByRole('listbox', { name: 'Panel type' });
    await user.click(within(picker).getByRole('option', { name: /services/i }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add panel' }));
    expect(last().panels).toHaveLength(4);
    expect(last().panels[3]).toMatchObject({ type: 'services', title: 'Services' });
  });

  it('renames the dashboard', async () => {
    const { user, last } = setup();
    const name = screen.getByRole('textbox', { name: 'Dashboard name' });
    await user.clear(name);
    await user.type(name, 'Payments');
    expect(last().title).toBe('Payments');
  });
});

describe('agent panel types', () => {
  it('newPanel makes agents, agent_value and run_graph panels', () => {
    expect(newPanel('agents', 'x')).toMatchObject({ type: 'agents', title: 'Agents', width: 'full' });
    expect(newPanel('agent_value', 'x')).toMatchObject({ type: 'agent_value', width: 'full' });
    expect(newPanel('run_graph', 'x')).toMatchObject({ type: 'run_graph', traceId: '' });
  });
});
