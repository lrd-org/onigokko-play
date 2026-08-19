#!/usr/bin/env node

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOL_ROOT = fileURLToPath(new URL('.', import.meta.url));
const REPOSITORY_ROOT = resolve(TOOL_ROOT, '..', '..');
const DEFAULTS = {
  host: '127.0.0.1',
  gamePort: 4173,
  parentPort: 4174,
  gameDir: REPOSITORY_ROOT,
  width: 960,
  height: 600,
};

const TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
]);

function fail(message) {
  throw new Error(message);
}

function integer(value, flag, minimum, maximum) {
  if (!/^\d+$/.test(value ?? '')) fail(`${flag} requires an integer`);
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    fail(`${flag} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function isLoopback(host) {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  const octets = normalized.split('.');
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127;
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`${argument} requires a value`);
    index += 1;
    if (argument === '--host') options.host = value;
    else if (argument === '--game-dir') options.gameDir = resolve(value);
    else if (argument === '--game-port') options.gamePort = integer(value, argument, 1, 65_535);
    else if (argument === '--parent-port') options.parentPort = integer(value, argument, 1, 65_535);
    else if (argument === '--width') options.width = integer(value, argument, 240, 2_560);
    else if (argument === '--height') options.height = integer(value, argument, 240, 2_560);
    else fail(`unknown option: ${argument}`);
  }
  if (!isLoopback(options.host)) fail('--host must be a loopback address or localhost');
  if (options.gamePort === options.parentPort) fail('game and parent ports must differ');
  return options;
}

function usage() {
  return [
    'Usage: node tools/embed-harness/serve.mjs [options]',
    '',
    'Serves Onigokko and an itch-like parent on different origins.',
    '',
    'Options:',
    '  --game-dir <path>    build directory (default: repository root)',
    `  --host <host>         bind host (default: ${DEFAULTS.host})`,
    `  --game-port <port>    game port (default: ${DEFAULTS.gamePort})`,
    `  --parent-port <port>  parent port (default: ${DEFAULTS.parentPort})`,
    `  --width <pixels>      iframe width (default: ${DEFAULTS.width})`,
    `  --height <pixels>     iframe height (default: ${DEFAULTS.height})`,
    '  -h, --help            show this help',
  ].join('\n');
}

function send(response, status, body, contentType) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function requestPath(request) {
  try {
    return decodeURIComponent(new URL(request.url, 'http://harness.invalid').pathname);
  } catch {
    return null;
  }
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function createGameHandler(root) {
  const absoluteRoot = resolve(root);
  return async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, 'Method Not Allowed\n', 'text/plain; charset=utf-8');
      return;
    }
    const pathname = requestPath(request);
    if (!pathname) {
      send(response, 400, 'Bad Request\n', 'text/plain; charset=utf-8');
      return;
    }
    if (pathname === '/healthz') {
      send(response, 200, request.method === 'HEAD' ? '' : 'ok\n', 'text/plain; charset=utf-8');
      return;
    }
    let candidate = resolve(absoluteRoot, `.${pathname}`);
    if (!inside(absoluteRoot, candidate)) {
      send(response, 403, 'Forbidden\n', 'text/plain; charset=utf-8');
      return;
    }
    try {
      const details = await stat(candidate);
      if (details.isDirectory()) candidate = resolve(candidate, 'index.html');
      if (!inside(absoluteRoot, candidate) || !(await stat(candidate)).isFile()) throw new Error('not a file');
      const contents = await readFile(candidate);
      const body = request.method === 'HEAD' ? Buffer.alloc(0) : contents;
      send(response, 200, body, TYPES.get(extname(candidate).toLowerCase()) ?? 'application/octet-stream');
    } catch {
      send(response, 404, 'Not Found\n', 'text/plain; charset=utf-8');
    }
  };
}

async function parentHtml({ gameOrigin, width, height }) {
  const template = await readFile(resolve(TOOL_ROOT, 'index.html'), 'utf8');
  return template
    .replace('__GAME_URL_JSON__', JSON.stringify(`${gameOrigin}/`))
    .replace('__FRAME_WIDTH__', String(width))
    .replace('__FRAME_HEIGHT__', String(height));
}

function createParentHandler(options) {
  return async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, 'Method Not Allowed\n', 'text/plain; charset=utf-8');
      return;
    }
    const pathname = requestPath(request);
    if (pathname === '/healthz') {
      send(response, 200, request.method === 'HEAD' ? '' : 'ok\n', 'text/plain; charset=utf-8');
      return;
    }
    if (pathname !== '/' && pathname !== '/index.html') {
      send(response, 404, 'Not Found\n', 'text/plain; charset=utf-8');
      return;
    }
    const body = await parentHtml(options);
    send(response, 200, request.method === 'HEAD' ? '' : body, 'text/html; charset=utf-8');
  };
}

function listen(server, port, host) {
  return new Promise((resolvePromise, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolvePromise();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function origin(host, address) {
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${urlHost}:${address.port}`;
}

function createSafeServer(handler) {
  return createServer((request, response) => {
    handler(request, response).catch((error) => {
      if (!response.headersSent) {
        send(response, 500, `Harness error: ${error.message}\n`, 'text/plain; charset=utf-8');
      } else {
        response.destroy(error);
      }
    });
  });
}

function close(server) {
  return new Promise((resolvePromise, reject) => {
    if (!server?.listening) {
      resolvePromise();
      return;
    }
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

export async function startHarness(options) {
  if (!isLoopback(options.host)) fail('harness host must be loopback');
  if (options.gamePort === options.parentPort && options.gamePort !== 0) {
    fail('game and parent ports must differ');
  }
  const gameServer = createSafeServer(createGameHandler(options.gameDir));
  let parentServer;
  try {
    await listen(gameServer, options.gamePort, options.host);
    const gameOrigin = origin(options.host, gameServer.address());
    parentServer = createSafeServer(createParentHandler({
      gameOrigin,
      width: options.width,
      height: options.height,
    }));
    await listen(parentServer, options.parentPort, options.host);
    const parentOrigin = origin(options.host, parentServer.address());
    return {
      gameOrigin,
      parentOrigin,
      close: () => Promise.all([close(gameServer), close(parentServer)]),
    };
  } catch (error) {
    await Promise.allSettled([close(gameServer), close(parentServer)]);
    throw error;
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    if (!isAbsolute(options.gameDir)) fail('--game-dir must resolve to an absolute path');
    const harness = await startHarness(options);
    console.log(`Game origin:   ${harness.gameOrigin}/`);
    console.log(`Parent origin: ${harness.parentOrigin}/`);
    console.log(`Iframe:        ${options.width}x${options.height}`);
    console.log('Press Ctrl-C to stop.');
    const stop = async () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      await harness.close();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}

export const internals = { createGameHandler, isLoopback, parseArgs, parentHtml };
