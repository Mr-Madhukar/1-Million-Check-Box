'use strict';
/**
 * OIDC Client for 2,000 Checkboxes
 * Connects to the OIDC auth server defined by OIDC_ISSUER env var.
 * The oidc-auth-main server must be running (npm run dev inside oidc-auth-main/).
 */

const crypto = require('crypto');
const express = require('express');

const APP_URL     = process.env.APP_URL     || 'http://localhost:8080';
const OIDC_ISSUER = process.env.OIDC_ISSUER || 'http://localhost:8000';
const CLIENT_ID   = process.env.CLIENT_ID   || 'checkboxes-app';
// CLIENT_SECRET is kept for future use (some OIDC flows require it);
// the oidc-auth-main server currently uses PKCE without verifying the secret.
const CLIENT_SECRET = process.env.CLIENT_SECRET || '';

// ─── Express Router ───────────────────────────────────────────────────────────
const router = express.Router();

// ── PKCE helpers (RFC 7636 / S256) ──────────────────────────────────────────
function generatePKCE() {
  const verifier  = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// ── /auth/login ── Initiate OIDC flow with PKCE ───────────────────────────────
router.get('/auth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  const { verifier, challenge } = generatePKCE();

  // Save state + PKCE verifier to session BEFORE redirect
  req.session.oidcState    = state;
  req.session.oidcNonce    = nonce;
  req.session.pkceVerifier = verifier;

  req.session.save((err) => {
    if (err) {
      console.error('[Auth Login] Session save error:', err);
      return res.redirect('/?error=session_error');
    }
    const qs = new URLSearchParams({
      client_id:             CLIENT_ID,
      redirect_uri:          `${APP_URL}/auth/callback`,
      response_type:         'code',
      scope:                 'openid profile email',
      state,
      nonce,
      code_challenge:        challenge,
      code_challenge_method: 'S256',
    });
    res.redirect(`${OIDC_ISSUER}/o/authenticate?${qs}`);
  });
});

// ── /auth/callback ── Handle OIDC callback ───────────────────────────────────
router.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('[Auth Callback] OIDC error:', error, req.query.error_description);
    return res.redirect(`/?error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return res.redirect('/?error=no_code');
  }

  // CSRF check – verify state matches what we stored
  if (!req.session.oidcState || state !== req.session.oidcState) {
    console.error('[Auth Callback] State mismatch. Session state:', req.session.oidcState, 'Query state:', state);
    return res.redirect('/?error=invalid_state');
  }

  try {
    // Exchange authorization code for tokens via OIDC token endpoint
    const pkceVerifier = req.session.pkceVerifier;
    if (!pkceVerifier) {
      console.error('[Auth Callback] Missing PKCE verifier in session');
      return res.redirect('/?error=missing_pkce');
    }

    const tokenRes = await fetch(`${OIDC_ISSUER}/o/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  `${APP_URL}/auth/callback`,
        code_verifier: pkceVerifier,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      console.error('[Auth Callback] Token exchange failed:', tokenRes.status, body);
      return res.redirect('/?error=token_failed');
    }

    const tokens = await tokenRes.json();

    // Decode ID token payload (base64url → JSON)
    const parts   = tokens.id_token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));

    // Persist user to session
    req.session.user = {
      sub:     payload.sub,
      name:    payload.name    || 'User',
      email:   payload.email   || '',
      picture: payload.picture || '',
    };

    delete req.session.oidcState;
    delete req.session.oidcNonce;
    delete req.session.pkceVerifier;

    req.session.save((err) => {
      if (err) console.error('[Auth Callback] Session save error:', err);
      res.redirect('/');
    });
  } catch (err) {
    console.error('[Auth Callback] Unexpected error:', err);
    res.redirect('/?error=callback_error');
  }
});

// ── /auth/me ── Return current session user ──────────────────────────────────
router.get('/auth/me', (req, res) => {
  if (req.session?.user) {
    return res.json({ user: req.session.user, authenticated: true });
  }
  res.json({ user: null, authenticated: false });
});

// ── /auth/logout ── Destroy session ─────────────────────────────────────────
router.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ── requireAuth middleware ────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ error: 'Authentication required' });
}

module.exports = { router, CLIENT_ID, OIDC_ISSUER, requireAuth };
