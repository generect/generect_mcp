import { Request, Response } from 'express';
import { getOAuthBaseUrl, getMcpEndpointUrl } from './jwt.js';

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  resource_name: string;
  resource_documentation?: string;
  grant_types_supported?: string[];
  token_types_supported?: string[];
}

export function getProtectedResourceMetadata(): ProtectedResourceMetadata {
  const baseUrl = getOAuthBaseUrl();
  const mcpEndpoint = getMcpEndpointUrl();

  return {
    resource: mcpEndpoint,
    authorization_servers: [baseUrl],
    scopes_supported: ['generect:api'],
    resource_name: 'Generect MCP Server',
    resource_documentation: 'https://github.com/generect/generect_mcp',
    grant_types_supported: ['authorization_code'],
    token_types_supported: ['bearer'],
  };
}

export function handleProtectedResourceMetadata(req: Request, res: Response): void {
  const metadata = getProtectedResourceMetadata();
  res.json(metadata);
}

export function getPrmUrl(): string {
  return `${getOAuthBaseUrl()}/.well-known/oauth-protected-resource`;
}

export function generateWwwAuthenticateHeader(): string {
  const prmUrl = getPrmUrl();
  return `Bearer resource_metadata="${prmUrl}", scope="generect:api"`;
}
