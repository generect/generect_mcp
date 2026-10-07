import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/server';
import { RESOURCE_MIME_TYPE, registerAppResource } from '@modelcontextprotocol/ext-apps/server';

// ---------------------------------------------------------------------------
// MCP Apps: the interactive view hosts render instead of a JSON dump
// ---------------------------------------------------------------------------
// Claude, ChatGPT, VS Code and other hosts that speak the MCP Apps extension
// (io.modelcontextprotocol/ui) see `_meta.ui.resourceUri` on a tool, fetch this
// resource and render it in a sandbox next to the answer. Hosts that don't keep
// reading `content` / `structuredContent` exactly as before, so nothing changes
// for them.
//
// One page serves every view (ui/main.ts picks one from the tool name), so a
// host fetches and caches a single resource. It is built by scripts/build-ui.mjs
// into dist/ui/app.html, which ships in the npm package and the Docker image.

export const UI_RESOURCE_URI = 'ui://generect/app.html';

/** Tools whose results have a view. Everything else stays text-only. */
export const UI_TOOLS = new Set([
  'count_leads',
  'count_companies',
  'search_leads',
  'search_companies',
  'preview_leads',
  'enrich_lead',
  'get_lead_by_url',
  'enrich_company',
  'get_balance',
  'generate_email',
]);

let cached: string | undefined;

/** The built page. Read once; a missing build is a loud error, not a blank card. */
export function uiHtml(): string {
  if (cached) return cached;
  const file = new URL('../dist/ui/app.html', import.meta.url);
  try {
    cached = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`MCP Apps view not built: ${file.pathname} is missing. Run \`npm run build\`.`);
  }
  return cached;
}

export function registerUiResource(server: McpServer): void {
  registerAppResource(
    server,
    'Generect results view',
    UI_RESOURCE_URI,
    {
      description: 'Interactive view for Generect search, count, enrichment and balance results.',
      mimeType: RESOURCE_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: UI_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: uiHtml(),
          _meta: {
            ui: {
              // Script and styles are inlined. The one outside origin is Claude's
              // own font host, so applyHostFonts can load Anthropic Sans.
              csp: { connectDomains: [], resourceDomains: ['https://assets.claude.ai'] },
              // Borderless: the view sits in the conversation, not in a box.
              prefersBorder: false,
            },
          },
        },
      ],
    }),
  );
}
