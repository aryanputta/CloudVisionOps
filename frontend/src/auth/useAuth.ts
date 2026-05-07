/**
 * Cognito implicit flow auth hook.
 *
 * On load: checks localStorage for a stored id_token, then parses the URL
 * hash for a fresh token from the Cognito hosted UI callback. Expiry is
 * verified against the JWT `exp` claim without a library dependency.
 */

import { useEffect, useState } from 'react';

const TOKEN_KEY = 'cvo_id_token';
const EXPIRY_KEY = 'cvo_token_expiry';

function parseJwtExp(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof decoded.exp === 'number' ? decoded.exp : null;
  } catch {
    return null;
  }
}

function isExpired(exp: number | null): boolean {
  if (exp === null) return true;
  return Date.now() / 1000 > exp;
}

export function buildLoginUrl(): string {
  const domain = import.meta.env.VITE_COGNITO_DOMAIN ?? '';
  const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID ?? '';
  const redirectUri = encodeURIComponent(window.location.origin);
  return `${domain}/login?client_id=${clientId}&response_type=token&scope=email+openid+profile&redirect_uri=${redirectUri}`;
}

export function useAuth() {
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Parse token from URL hash after Cognito hosted UI redirect
    const hash = window.location.hash;
    if (hash.includes('id_token=')) {
      const params = new URLSearchParams(hash.replace('#', ''));
      const idToken = params.get('id_token');
      const expiresIn = parseInt(params.get('expires_in') ?? '3600', 10);
      if (idToken) {
        const expiry = Math.floor(Date.now() / 1000) + expiresIn;
        localStorage.setItem(TOKEN_KEY, idToken);
        localStorage.setItem(EXPIRY_KEY, String(expiry));
        // Clean hash from URL without a page reload
        window.history.replaceState(null, '', window.location.pathname);
        setToken(idToken);
        setLoading(false);
        return;
      }
    }

    // Fall back to stored token
    const stored = localStorage.getItem(TOKEN_KEY);
    const expiry = parseInt(localStorage.getItem(EXPIRY_KEY) ?? '0', 10);
    if (stored && !isExpired(expiry || parseJwtExp(stored))) {
      setToken(stored);
    } else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(EXPIRY_KEY);
    }
    setLoading(false);
  }, []);

  const signOut = () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EXPIRY_KEY);
    setToken(null);
    const domain = import.meta.env.VITE_COGNITO_DOMAIN ?? '';
    const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID ?? '';
    const logoutUri = encodeURIComponent(window.location.origin);
    window.location.href = `${domain}/logout?client_id=${clientId}&logout_uri=${logoutUri}`;
  };

  return { token, loading, isAuthenticated: token !== null, signOut };
}
