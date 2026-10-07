// A stand-in MCP Apps host for local previews and browser tests.
//
// It renders dist/ui/app.html exactly the way a host does: a sandboxed iframe
// driven by the SDK's own AppBridge (the host side of the protocol), with
// Claude's published style variables in light and dark. Tool calls the view
// makes are answered by window.__callTool, which the test runner provides.

import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

// Claude's documented values (claude.com/docs/connectors/building/mcp-apps/design-guidelines).
const COMMON: Record<string, string> = {
  '--font-sans': 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  '--font-mono': 'ui-monospace, monospace',
  '--font-weight-normal': '400',
  '--font-weight-medium': '500',
  '--font-weight-semibold': '600',
  '--font-weight-bold': '700',
  '--font-text-xs-size': '12px',
  '--font-text-sm-size': '14px',
  '--font-text-md-size': '16px',
  '--font-text-lg-size': '20px',
  '--font-heading-xl-size': '24px',
  '--font-heading-3xl-size': '36px',
  '--border-radius-sm': '6px',
  '--border-radius-md': '8px',
  '--border-radius-lg': '10px',
  '--border-radius-full': '9999px',
  '--border-width-regular': '0.5px',
};
const LIGHT: Record<string, string> = {
  ...COMMON,
  '--color-background-primary': '#FFFFFF',
  '--color-background-secondary': '#F5F4ED',
  '--color-background-tertiary': '#FAF9F5',
  '--color-background-inverse': '#141413',
  '--color-background-info': '#D6E4F6',
  '--color-background-danger': '#F7ECEC',
  '--color-background-success': '#E9F1DC',
  '--color-background-warning': '#F6EEDF',
  '--color-text-primary': '#141413',
  '--color-text-secondary': '#3D3D3A',
  '--color-text-tertiary': '#73726C',
  '--color-text-inverse': '#FFFFFF',
  '--color-text-info': '#3266AD',
  '--color-text-danger': '#7F2C28',
  '--color-text-success': '#265B19',
  '--color-text-warning': '#5A4815',
  '--color-border-secondary': 'rgba(31,30,29,0.3)',
  '--color-border-tertiary': 'rgba(31,30,29,0.15)',
  '--color-ring-primary': 'rgba(20,20,19,0.7)',
};
const DARK: Record<string, string> = {
  ...COMMON,
  '--color-background-primary': '#30302E',
  '--color-background-secondary': '#262624',
  '--color-background-tertiary': '#141413',
  '--color-background-inverse': '#FAF9F5',
  '--color-background-info': '#253E5F',
  '--color-background-danger': '#602A28',
  '--color-background-success': '#1B4614',
  '--color-background-warning': '#483A0F',
  '--color-text-primary': '#FAF9F5',
  '--color-text-secondary': '#C2C0B6',
  '--color-text-tertiary': '#9C9A92',
  '--color-text-inverse': '#141413',
  '--color-text-info': '#80AADD',
  '--color-text-danger': '#EE8884',
  '--color-text-success': '#7AB948',
  '--color-text-warning': '#D1A041',
  '--color-border-secondary': 'rgba(222,220,209,0.3)',
  '--color-border-tertiary': 'rgba(222,220,209,0.15)',
  '--color-ring-primary': 'rgba(250,249,245,0.7)',
};

export interface MountOptions {
  html: string;
  toolName: string;
  args?: Record<string, unknown>;
  result?: { structuredContent?: unknown; content?: unknown[] };
  theme?: 'light' | 'dark';
  displayMode?: 'inline' | 'fullscreen';
  width?: number;
  height?: number;
  withResultDelayMs?: number;
  /** What the host offers; Claude offers both. */
  displayModes?: Array<'inline' | 'fullscreen'>;
}

declare global {
  interface Window {
    mount: (o: MountOptions) => Promise<void>;
    __log: Array<{ type: string; params: unknown }>;
    __callTool?: (name: string, args: unknown) => Promise<unknown>;
    __bridge?: AppBridge;
  }
}

window.__log = [];

window.mount = async (o: MountOptions) => {
  const stage = document.getElementById('stage')!;
  stage.innerHTML = '';
  const theme = o.theme ?? 'light';
  document.body.dataset.theme = theme;
  const width = o.width ?? 720;
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.title = 'Generect view';
  frame.style.cssText = `width:${width}px;height:120px;border:0;display:block;background:transparent`;
  const card = document.createElement('div');
  card.className = 'card';
  card.appendChild(frame);
  stage.appendChild(card);

  let mode = o.displayMode ?? 'inline';
  const applyMode = () => {
    card.classList.toggle('full', mode === 'fullscreen');
    if (mode === 'fullscreen') {
      frame.style.width = `${width}px`;
      frame.style.height = `${o.height ?? 760}px`;
    }
  };
  applyMode();

  const hostContext = {
    theme,
    styles: { variables: theme === 'dark' ? DARK : LIGHT } as any,
    displayMode: mode,
    availableDisplayModes: o.displayModes ?? ['inline', 'fullscreen'],
    toolInfo: { tool: { name: o.toolName, inputSchema: { type: 'object' } } as any },
    locale: 'en-US',
    platform: 'web',
  } as any;
  const bridge = new AppBridge(
    null,
    { name: 'Preview host (Claude styles)', version: '1.0.0' },
    {
      openLinks: {},
      downloadFile: {},
      serverTools: {},
      logging: {},
      updateModelContext: { text: {} },
    },
    { hostContext },
  );
  window.__bridge = bridge;
  bridge.onsizechange = ({ height }) => {
    if (mode === 'inline' && typeof height === 'number') frame.style.height = `${Math.ceil(height)}px`;
  };
  bridge.oncalltool = async p => {
    window.__log.push({ type: 'tools/call', params: p });
    const r = window.__callTool ? await window.__callTool(p.name, p.arguments) : { content: [] };
    return r as any;
  };
  bridge.onmessage = async p => {
    window.__log.push({ type: 'ui/message', params: p });
    return {};
  };
  bridge.onupdatemodelcontext = async p => {
    window.__log.push({ type: 'ui/update-model-context', params: p });
    return {};
  };
  bridge.onopenlink = async p => {
    window.__log.push({ type: 'ui/open-link', params: p });
    return {};
  };
  bridge.ondownloadfile = async p => {
    window.__log.push({ type: 'ui/download-file', params: p });
    return {};
  };
  bridge.onrequestdisplaymode = async p => {
    window.__log.push({ type: 'ui/request-display-mode', params: p });
    const offered = o.displayModes ?? ['inline', 'fullscreen'];
    mode = p.mode === 'fullscreen' && offered.includes('fullscreen') ? 'fullscreen' : 'inline';
    applyMode();
    await bridge.sendHostContextChange({ displayMode: mode });
    return { mode };
  };
  const initialized = new Promise<void>(resolve => {
    bridge.oninitialized = () => resolve();
  });
  await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
  frame.srcdoc = o.html;
  await initialized;
  await bridge.sendToolInput({ arguments: (o.args ?? {}) as any });
  if (o.withResultDelayMs) await new Promise(r => setTimeout(r, o.withResultDelayMs));
  if (o.result) await bridge.sendToolResult(o.result as any);
};
