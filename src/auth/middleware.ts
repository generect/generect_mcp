import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, extractApiToken, GenerectJwtPayload } from './jwt.js';
import { generateWwwAuthenticateHeader } from './prm.js';

export interface AuthenticatedRequest extends Request {
  apiToken?: string;
  jwtPayload?: GenerectJwtPayload;
  isAuthenticated?: boolean;
}

export async function requireBearerAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res
      .status(401)
      .set('WWW-Authenticate', generateWwwAuthenticateHeader())
      .json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Authorization required',
        },
        id: null,
      });
    return;
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    console.log('[auth] Invalid Bearer format');
    res
      .status(401)
      .set('WWW-Authenticate', generateWwwAuthenticateHeader())
      .json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Invalid authorization header format. Use: Bearer <token>',
        },
        id: null,
      });
    return;
  }

  const token = match[1];
  if (token.startsWith('Token ')) {
    req.apiToken = token;
    req.isAuthenticated = true;
    console.log('[auth] Using direct Token auth');
    next();
    return;
  }

  const payload = await verifyAccessToken(token);
  if (!payload) {
    console.log('[auth] JWT verification FAILED');
    res
      .status(401)
      .set('WWW-Authenticate', generateWwwAuthenticateHeader())
      .json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Invalid or expired access token',
        },
        id: null,
      });
    return;
  }

  try {
    const apiToken = extractApiToken(payload);
    req.apiToken = apiToken;
    req.jwtPayload = payload;
    req.isAuthenticated = true;
    next();
  } catch (error) {
    console.log('[auth] Decryption error:', error);
    res
      .status(401)
      .set('WWW-Authenticate', generateWwwAuthenticateHeader())
      .json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Failed to decrypt token',
        },
        id: null,
      });
    return;
  }
}

export function optionalBearerAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    next();
    return;
  }

  requireBearerAuth(req, res, next);
}

export function getApiTokenFromRequest(req: AuthenticatedRequest): string | null {
  return req.apiToken || null;
}
