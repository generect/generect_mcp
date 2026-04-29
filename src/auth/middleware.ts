import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, extractApiToken, GenerectJwtPayload } from './jwt.js';
import { parseAuthHeader } from './parse.js';
import { generateWwwAuthenticateHeader } from './prm.js';

export interface AuthenticatedRequest extends Request {
  apiToken?: string;
  jwtPayload?: GenerectJwtPayload;
  isAuthenticated?: boolean;
}

function unauthorized(res: Response, message: string): void {
  res
    .status(401)
    .set('WWW-Authenticate', generateWwwAuthenticateHeader())
    .json({
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id: null,
    });
}

export async function requireBearerAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const parsed = parseAuthHeader(req.headers.authorization);

  if (!parsed) {
    if (!req.headers.authorization) {
      unauthorized(res, 'Authorization required');
    } else {
      unauthorized(res, 'Invalid authorization header format. Use: Bearer <token>');
    }
    return;
  }

  if (parsed.kind === 'token') {
    req.apiToken = parsed.apiKey;
    req.isAuthenticated = true;
    next();
    return;
  }

  const payload = await verifyAccessToken(parsed.jwt);
  if (!payload) {
    unauthorized(res, 'Invalid or expired access token');
    return;
  }

  try {
    req.apiToken = extractApiToken(payload);
    req.jwtPayload = payload;
    req.isAuthenticated = true;
    next();
  } catch (error) {
    console.log('[auth] Decryption error:', error);
    unauthorized(res, 'Failed to decrypt token');
  }
}

export function optionalBearerAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.headers.authorization) {
    next();
    return;
  }
  requireBearerAuth(req, res, next);
}

export function getApiTokenFromRequest(req: AuthenticatedRequest): string | null {
  return req.apiToken || null;
}
