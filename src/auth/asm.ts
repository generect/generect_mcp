import { Request, Response } from 'express';
import { getOAuthBaseUrl, getKeyId } from './jwt.js';

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  jwks_uri: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  scopes_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  client_id_metadata_document_supported: boolean;
  subject_types_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
}

export function getAuthorizationServerMetadata(): AuthorizationServerMetadata {
  const baseUrl = getOAuthBaseUrl();

  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    jwks_uri: `${baseUrl}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['generect:api', 'openid'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    client_id_metadata_document_supported: true,
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256', 'HS256'],
  };
}

export function handleAuthorizationServerMetadata(req: Request, res: Response): void {
  const metadata = getAuthorizationServerMetadata();
  res.json(metadata);
}

export interface JwksResponse {
  keys: Array<{
    kty: string;
    kid: string;
    use: string;
    alg: string;
    n?: string;
    e?: string;
    k?: string;
  }>;
}

export async function handleJwks(req: Request, res: Response): Promise<void> {
  const { getPublicKeyJwk } = await import('./jwt.js');
  const jwk = await getPublicKeyJwk();

  const jwks: JwksResponse = {
    keys: [
      {
        ...jwk,
        use: 'sig',
      },
    ],
  };

  res.json(jwks);
}
