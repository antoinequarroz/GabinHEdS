import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { settings } from '../src/compte.js';

const SECRET = 'x'.repeat(32);
const ENV = { COMPTE_URL: 'https://compte.exemple.ch/', COMPTE_CLIENT_SECRET: SECRET, APP_URL: 'https://nino.exemple.ch/' };
const ISSUER = 'https://compte.exemple.ch/api/auth';

const cookiesOf = (header: string | string[] | number | undefined): Record<string, string> => Object.fromEntries(
  (Array.isArray(header) ? header : [String(header ?? '')]).map(cookie => cookie.split(';')[0]!.split('=')).map(([name, ...value]) => [name!, value.join('=')]));
const idToken = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

/** Fake Compte Postmelo: discovery plus a token endpoint answering with the given person. */
function fakeCompte(person: () => Record<string, unknown>) {
  const original = globalThis.fetch;
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token` });
    }
    if (url === `${ISSUER}/token`) return Response.json({ id_token: idToken(person()) });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { requests, restore: () => { globalThis.fetch = original; } };
}

test('settings default the client id to nino and stay off without every variable', () => {
  assert.equal(settings(ENV)?.clientId, 'nino');
  assert.equal(settings(ENV)?.redirectUri, 'https://nino.exemple.ch/api/auth/compte/callback');
  assert.equal(settings({ ...ENV, COMPTE_URL: '' }), null);
  assert.equal(settings({ ...ENV, COMPTE_CLIENT_SECRET: 'court' }), null);
  assert.equal(settings({ ...ENV, APP_URL: '' }), null);
});

test('without the variables, the pairing code stays the only way in', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nino-compte-off-'));
  const app = await buildApp({ dataDir, compteEnv: {} });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/auth/compte' })).json(), { enabled: false });
  const start = await app.inject({ method: 'GET', url: '/api/auth/compte/start' });
  assert.equal(start.statusCode, 302);
  assert.match(String(start.headers.location), /^\/\?compte_erreur=/);
});

test('Compte Postmelo sign-in associates this browser, once', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nino-compte-'));
  let pendingNonce = '';
  let role = 'admin';
  const compte = fakeCompte(() => ({ iss: ISSUER, aud: 'nino', nonce: pendingNonce, exp: Math.floor(Date.now() / 1000) + 300, sub: 'person-1', email: 'lea@studio.ch', name: 'Léa', role }));
  const app = await buildApp({ dataDir, compteEnv: ENV });
  t.after(async () => { compte.restore(); await app.close(); await rm(dataDir, { recursive: true, force: true }); });

  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/auth/compte' })).json(), { enabled: true });

  async function signIn() {
    const start = await app.inject({ method: 'GET', url: '/api/auth/compte/start' });
    assert.equal(start.statusCode, 302);
    const authorize = new URL(String(start.headers.location));
    assert.equal(authorize.origin + authorize.pathname, `${ISSUER}/authorize`);
    assert.equal(authorize.searchParams.get('client_id'), 'nino');
    assert.equal(authorize.searchParams.get('redirect_uri'), 'https://nino.exemple.ch/api/auth/compte/callback');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.match(String(start.headers['set-cookie']), /compte_pending=.+; Path=\/api\/auth\/compte; Max-Age=600; HttpOnly; SameSite=Lax; Secure/);
    const pending = cookiesOf(start.headers['set-cookie']).compte_pending!;
    pendingNonce = JSON.parse(Buffer.from(pending, 'base64url').toString()).nonce;
    const state = authorize.searchParams.get('state')!;
    const callback = await app.inject({ method: 'GET', url: `/api/auth/compte/callback?code=abc&state=${state}`, headers: { cookie: `compte_pending=${pending}` } });
    assert.equal(callback.statusCode, 302);
    assert.equal(callback.headers.location, '/?compte=1');
    return cookiesOf(callback.headers['set-cookie']).nino_compte_handoff!;
  }

  const ticket = await signIn();
  const token = compte.requests.find(request => request.url.endsWith('/token'))!;
  assert.equal(new Headers(token.init?.headers).get('authorization'), `Basic ${Buffer.from(`nino:${SECRET}`).toString('base64')}`);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/compte/claim' })).statusCode, 401);
  const claim = await app.inject({ method: 'POST', url: '/api/auth/compte/claim', headers: { cookie: `nino_compte_handoff=${ticket}`, host: 'nino.exemple.ch', origin: 'https://nino.exemple.ch' } });
  assert.equal(claim.statusCode, 200);
  const auth = claim.json();
  assert.equal(auth.device.role, 'technician');
  assert.equal(auth.device.name, 'Léa · Compte Postmelo');
  assert.equal((await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${auth.token}` } })).statusCode, 200);
  // One use only, and never from another site.
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/compte/claim', headers: { cookie: `nino_compte_handoff=${ticket}` } })).statusCode, 401);
  const other = await signIn();
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/compte/claim', headers: { cookie: `nino_compte_handoff=${other}`, host: 'nino.exemple.ch', origin: 'https://evil.example' } })).statusCode, 403);

  role = 'member';
  const member = (await app.inject({ method: 'POST', url: '/api/auth/compte/claim', headers: { cookie: `nino_compte_handoff=${await signIn()}` } })).json();
  assert.equal(member.device.role, 'operator');

  const forged = await app.inject({ method: 'GET', url: '/api/auth/compte/callback?code=abc&state=forged', headers: { cookie: 'compte_pending=e30' } });
  assert.equal(forged.statusCode, 302);
  assert.match(String(forged.headers.location), /^\/\?compte_erreur=/);
  assert.equal(cookiesOf(forged.headers['set-cookie']).nino_compte_handoff, undefined);
});
