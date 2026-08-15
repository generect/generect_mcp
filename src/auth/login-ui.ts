import { describeRedirectTarget } from './redirect.js';

export function renderLoginPage(params: {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  clientName?: string;
  error?: string;
  nonce?: string;
}): string {
  const { clientId, redirectUri, state, codeChallenge, codeChallengeMethod, scope, clientName, error, nonce } = params;

  // Build cancel URL that redirects back with error
  const cancelUrl = new URL('/oauth/authorize', 'http://localhost');
  cancelUrl.searchParams.set('client_id', clientId);
  cancelUrl.searchParams.set('redirect_uri', redirectUri);
  cancelUrl.searchParams.set('code_challenge', codeChallenge);
  cancelUrl.searchParams.set('code_challenge_method', codeChallengeMethod);
  cancelUrl.searchParams.set('scope', scope);
  if (state) cancelUrl.searchParams.set('state', state);
  cancelUrl.searchParams.set('error', 'access_denied');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Generect MCP - Authorize</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: #f5f5f7;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04);
      max-width: 400px;
      width: 100%;
      overflow: hidden;
    }
    .header {
      background: #2d59c8;
      color: white;
      padding: 28px;
      text-align: center;
    }
    .header h1 {
      font-size: 22px;
      font-weight: 600;
      margin-bottom: 6px;
    }
    .header p {
      font-size: 14px;
      opacity: 0.85;
    }
    .content {
      padding: 28px;
    }
    .error {
      background: #fef2f2;
      border: 1px solid #fecaca;
      color: #dc2626;
      padding: 12px 14px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 14px;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      font-size: 14px;
      font-weight: 500;
      color: #374151;
      margin-bottom: 8px;
    }
    input[type="text"], input[type="password"], input[type="email"] {
      width: 100%;
      padding: 12px 14px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      font-size: 15px;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    input:focus {
      outline: none;
      border-color: #2d59c8;
      box-shadow: 0 0 0 3px rgba(45, 89, 200, 0.1);
    }
    input:disabled {
      background: #f3f4f6;
      cursor: not-allowed;
    }
    .hint {
      font-size: 12px;
      color: #6b7280;
      margin-top: 8px;
    }
    .hint a {
      color: #2d59c8;
      text-decoration: none;
    }
    .hint a:hover {
      text-decoration: underline;
    }
    .permissions {
      background: #f9fafb;
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 20px;
    }
    .permissions h3 {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 10px;
      color: #374151;
    }
    .permission-item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: #4b5563;
      margin-bottom: 6px;
    }
    .permission-item:last-child {
      margin-bottom: 0;
    }
    .permission-icon {
      color: #2d59c8;
      font-weight: bold;
    }
    button {
      width: 100%;
      padding: 12px 20px;
      background: #2d59c8;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    button:hover:not(:disabled) {
      background: #2348a0;
    }
    button:active:not(:disabled) {
      background: #1e3d87;
    }
    button:disabled {
      background: #9ca3af;
      cursor: not-allowed;
    }
    .spinner {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255,255,255,0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .cancel-link {
      display: block;
      text-align: center;
      margin-top: 16px;
      color: #6b7280;
      font-size: 14px;
      text-decoration: none;
    }
    .cancel-link:hover {
      color: #374151;
      text-decoration: underline;
    }
    .footer {
      text-align: center;
      padding: 16px 28px;
      border-top: 1px solid #e5e7eb;
      font-size: 12px;
      color: #9ca3af;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Generect MCP</h1>
      <p>Authorize ${escapeHtml(clientName) || 'an application'} to access your Generect API</p>
    </div>

    <div class="content">
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}

      ${(() => {
        // Show the user WHERE their authorization will be delivered. Any app may
        // register itself with this server, so this line — not a host allowlist —
        // is what stands between the user and approving a flow they did not
        // start. It has to stay readable for every callback shape, including
        // private-use schemes that have no hostname.
        const target = describeRedirectTarget(redirectUri);
        const what = target.detail ? ` (${escapeHtml(target.detail)})` : '';
        return `<div style="margin:0 0 16px;padding:10px 12px;border:1px solid #e0e0e0;border-radius:8px;background:#fafafa;font-size:13px;color:#444;">Your access will be sent to <strong>${escapeHtml(target.label)}</strong>${what}. Only continue if you started this connection there.</div>`;
      })()}

      <form method="POST" action="/oauth/authorize" id="authForm">
        <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
        <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
        <input type="hidden" name="state" value="${escapeHtml(state || '')}">
        <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
        <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}">
        <input type="hidden" name="scope" value="${escapeHtml(scope)}">

        <div class="permissions">
          <h3>This application will be able to:</h3>
          <div class="permission-item">
            <span class="permission-icon">&#10003;</span>
            <span>Access your Generect API account</span>
          </div>
          <div class="permission-item">
            <span class="permission-icon">&#10003;</span>
            <span>Search for leads and companies</span>
          </div>
          <div class="permission-item">
            <span class="permission-icon">&#10003;</span>
            <span>Use all other API endpoints using your API quota</span>
          </div>
        </div>

        <div class="form-group">
          <label for="email">Email</label>
          <input type="email" id="email" name="email" placeholder="you@company.com" autocomplete="username">
        </div>
        <div class="form-group">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" placeholder="Your Generect password" autocomplete="current-password">
          <div class="hint">
            Log in with your Generect account — we'll create a connection token for you automatically. Nothing to copy.
          </div>
        </div>

        <details style="margin: 4px 0 8px;">
          <summary style="cursor: pointer; color: #666; font-size: 13px;">Or authorize with an API token instead</summary>
          <div class="form-group" style="margin-top: 10px;">
            <label for="api_token">Generect API Token</label>
            <input type="password" id="api_token" name="api_token" placeholder="Enter your API token" autocomplete="off">
            <div class="hint">
              Get your API token from <a href="https://beta.generect.com" target="_blank">beta.generect.com</a>
            </div>
          </div>
        </details>

        <button type="submit" id="submitBtn">
          <span id="btnText">Log in &amp; Authorize</span>
        </button>
        <a href="${escapeHtml(cancelUrl.toString())}" class="cancel-link">Cancel</a>
      </form>
    </div>

    <div class="footer">
      By authorizing, you allow this application to access your Generect API on your behalf.
    </div>
  </div>

  <script nonce="${nonce || ''}">
    document.getElementById('authForm').addEventListener('submit', function(e) {
      const btn = document.getElementById('submitBtn');
      const btnText = document.getElementById('btnText');

      btn.disabled = true;
      btnText.innerHTML = '<span class="spinner"></span> Authorizing...';
    });
  </script>
</body>
</html>`;
}

export function renderErrorPage(params: { error: string; errorDescription?: string }): string {
  const { error, errorDescription } = params;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorization Error</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f7;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04);
      max-width: 400px;
      width: 100%;
      padding: 40px;
      text-align: center;
    }
    .error-icon {
      font-size: 40px;
      margin-bottom: 16px;
    }
    h1 {
      font-size: 20px;
      color: #dc2626;
      margin-bottom: 12px;
      font-weight: 600;
    }
    p {
      color: #6b7280;
      font-size: 14px;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="error-icon">&#10060;</div>
    <h1>Authorization Error</h1>
    <p>${escapeHtml(errorDescription || error)}</p>
  </div>
</body>
</html>`;
}

export function renderRedirectPage(params: {
  redirectUri: string;
  authorizationCode: string;
  state?: string;
  nonce?: string;
}): string {
  const { redirectUri, authorizationCode, state, nonce } = params;

  // Build the final redirect URL with query parameters
  const finalRedirectUrl = new URL(redirectUri);
  finalRedirectUrl.searchParams.set('code', authorizationCode);
  if (state) finalRedirectUrl.searchParams.set('state', state);

  const redirectUrlString = finalRedirectUrl.toString();
  // Handing off to a locally installed app (cursor://, vscode://, …) is a
  // different experience from a web callback: browsers often refuse to open an
  // external protocol without a user gesture, or raise an "Open in …?" prompt.
  // Waiting 3s before offering the button reads as a hang, so for those the
  // button is there from the start.
  const isExternalApp = !/^https?:$/.test(finalRedirectUrl.protocol);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Redirecting...</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: #f5f5f7;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04);
      max-width: 400px;
      width: 100%;
      padding: 40px;
      text-align: center;
    }
    .icon {
      font-size: 48px;
      margin-bottom: 20px;
    }
    h1 {
      font-size: 20px;
      font-weight: 600;
      color: #1f2937;
      margin-bottom: 12px;
    }
    p {
      color: #6b7280;
      font-size: 14px;
      line-height: 1.6;
      margin-bottom: 24px;
    }
    .spinner {
      display: inline-block;
      width: 24px;
      height: 24px;
      border: 2px solid #e5e7eb;
      border-top-color: #2d59c8;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-bottom: 20px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .manual-link {
      display: inline-block;
      padding: 12px 24px;
      background: #2d59c8;
      color: white;
      text-decoration: none;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 500;
      transition: background 0.2s;
    }
    .manual-link:hover {
      background: #2348a0;
    }
    .hidden {
      display: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">&#9989;</div>
    <h1>Authorization Successful</h1>
    <p>${isExternalApp ? 'Opening the application to finish signing in...' : 'Redirecting you back to the application...'}</p>
    ${isExternalApp ? '' : '<div class="spinner" id="spinner"></div>'}
    <a href="${escapeHtml(redirectUrlString)}" class="manual-link${isExternalApp ? '' : ' hidden'}" id="manualLink">
      ${isExternalApp ? 'Open the application' : 'Click here to continue'}
    </a>
  </div>
  <script nonce="${nonce || ''}">
    // Attempt immediate redirect. JSON.stringify produces a safe JS string
    // literal; the URL is already percent-encoded by the WHATWG serializer.
    const redirectUrl = ${JSON.stringify(redirectUrlString)};
    const isExternalApp = ${isExternalApp ? 'true' : 'false'};

    // Small delay to ensure page is fully loaded
    setTimeout(function() {
      window.location.href = redirectUrl;

      if (isExternalApp) return;

      // Show manual link after a short delay in case automatic redirect doesn't work
      setTimeout(function() {
        document.getElementById('spinner').classList.add('hidden');
        document.getElementById('manualLink').classList.remove('hidden');
        document.querySelector('p').textContent = 'If you are not redirected automatically, click the button below:';
      }, 3000);
    }, 100);
  </script>
</body>
</html>`;
}

function escapeJs(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escapeHtml(str: string | undefined | null): string {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
