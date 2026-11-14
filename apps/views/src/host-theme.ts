import type { McpUiHostContext } from '@modelcontextprotocol/ext-apps';

/**
 * The host's theme over the land tokens: each land variable takes the host's matching value when the host sends
 * one (MCP Apps `styles.variables`), and keeps its token otherwise. `theme` picks the tokens' light or dark set.
 */
export const HOST_TO_LAND: Record<string, string[]> = {
  '--color-background-primary': ['--bg', '--sf'],
  '--color-background-secondary': ['--sf2', '--wl'],
  '--color-background-ghost': ['--acdim', '--nudim'],
  '--color-background-danger': ['--rddim'],
  '--color-background-success': ['--gndim'],
  '--color-background-warning': ['--warndim'],
  '--color-text-primary': ['--t1', '--ac', '--ac2'],
  '--color-text-secondary': ['--t2'],
  '--color-text-tertiary': ['--t3'],
  '--color-text-inverse': ['--on-ac'],
  '--color-text-danger': ['--rd'],
  '--color-text-success': ['--gn'],
  '--color-text-warning': ['--warn'],
  '--color-border-primary': ['--bd'],
  '--color-border-tertiary': ['--hair'],
  '--color-border-danger': ['--rdbd'],
  '--color-border-success': ['--gnbd'],
  '--color-border-warning': ['--warnbd'],
  '--font-sans': ['--font-geist-sans'],
  '--font-mono': ['--font-geist-mono'],
};

/** The land variables to set for a host's style variables. */
export function landVariables(hostVars: Record<string, string | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [host, lands] of Object.entries(HOST_TO_LAND)) {
    const value = hostVars?.[host];
    if (value) for (const land of lands) out[land] = value;
  }
  return out;
}

export function applyHostContext(ctx: McpUiHostContext | undefined, root: HTMLElement = document.documentElement) {
  if (!ctx) return;
  if (ctx.theme === 'light' || ctx.theme === 'dark') root.dataset.theme = ctx.theme;
  for (const [name, value] of Object.entries(landVariables(ctx.styles?.variables))) root.style.setProperty(name, value);
  const fonts = ctx.styles?.css?.fonts;
  if (fonts && !document.getElementById('host-fonts')) {
    const style = document.createElement('style');
    style.id = 'host-fonts';
    style.textContent = fonts;
    document.head.appendChild(style);
  }
}
