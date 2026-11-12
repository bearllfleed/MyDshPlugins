/**
 * Host half of the dsh-git plugin.
 *
 * It owns exactly one route — `POST /api/dsh-git` — and turns each request into
 * one git command through `git/actions.js`. The route always answers 200 with a
 * JSON envelope: `{ ok: true, value }` or `{ ok: false, error }`, so a failing
 * git command can never surface as a 500 and the Client only has to inspect
 * `ok`. Configuration is a plain object (no schemastery `Config` export) because
 * the bundle is installed through a `link:` dependency.
 */
import { handleAction } from './git/actions.js';
import { createConfig } from './git/config.js';
import { gitError, toGitError } from './git/util.js';

/** Plugin name as declared in the bundle patch. */
export const name = 'dsh-git';
/** The only Host service this plugin needs at load time. */
export const inject = ['connection'];
/** The single route the Client half calls. */
export const ROUTE = '/api/dsh-git';

/**
 * Mount the request route.
 * @param {object} ctx - the plugin's Host context.
 * @param {unknown} rawConfig - the plain configuration object from the patch file.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const config = createConfig(rawConfig);
  if (typeof ctx?.inject !== 'function') return;
  ctx.inject(['connection'], (scope) => {
    const connection = scope.get('connection');
    const register =
      typeof connection?.fetch?.register === 'function' ? connection.fetch.register.bind(connection.fetch) : undefined;
    if (register === undefined) return;
    scope.effect(
      () =>
        register({
          path: ROUTE,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) => handleRequest(ctx, request, config),
        }),
      `dsh-git: ${ROUTE}`,
    );
  });
}

/**
 * Read and parse the request body.
 * @param {unknown} request - the route request.
 * @returns {Promise<object>} the parsed body.
 * @throws {GitError} E_INVALID_ARG when the body is missing or not JSON.
 */
async function readBody(request) {
  if (request === null || typeof request !== 'object') throw gitError('E_INVALID_ARG', 'request body is required');
  try {
    if (typeof request.json === 'function') return await request.json();
    if (typeof request.text === 'function') return JSON.parse(await request.text());
    if (typeof request.body === 'string') return JSON.parse(request.body);
  } catch {
    throw gitError('E_INVALID_ARG', 'request body must be valid JSON');
  }
  throw gitError('E_INVALID_ARG', 'request body must be valid JSON');
}

/**
 * Turn any thrown value into the contract's error envelope.
 * @param {unknown} error - the thrown value.
 * @returns {{ code: string, message: string, detail?: string }}
 */
export function errorEnvelope(error) {
  const failure = toGitError(error);
  const envelope = { code: failure.code, message: failure.message };
  if (typeof failure.detail === 'string' && failure.detail !== '') envelope.detail = failure.detail;
  return envelope;
}

/**
 * Handle one HTTP request: always 200, always a JSON envelope.
 * @param {object} ctx - the plugin's Host context.
 * @param {unknown} request - the route request.
 * @param {unknown} config - the configuration handle.
 * @returns {Promise<Response>}
 */
export async function handleRequest(ctx, request, config) {
  let payload;
  try {
    const body = await readBody(request);
    const value = await handleAction(ctx, body, config);
    payload = { ok: true, value };
  } catch (error) {
    payload = { ok: false, error: errorEnvelope(error) };
  }
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
