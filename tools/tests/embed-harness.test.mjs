import assert from 'node:assert/strict';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { internals, startHarness } from '../embed-harness/serve.mjs';

test('accepts only loopback bind hosts', async () => {
  assert.equal(internals.isLoopback('127.0.0.1'), true);
  assert.equal(internals.isLoopback('127.1.2.3'), true);
  assert.equal(internals.isLoopback('localhost'), true);
  assert.equal(internals.isLoopback('::1'), true);
  assert.equal(internals.isLoopback('0.0.0.0'), false);
  assert.equal(internals.isLoopback('example.com'), false);
  await assert.rejects(startHarness({
    host: 'example.com',
    gamePort: 0,
    parentPort: 0,
    gameDir: '.',
    width: 960,
    height: 600,
  }), /loopback/);
});

test('serves the game and parent on distinct origins', async (context) => {
  const gameDir = await mkdtemp(join(tmpdir(), 'onigokko-harness-'));
  await writeFile(join(gameDir, 'index.html'), '<title>Onigokko</title>');
  const harness = await startHarness({
    host: '127.0.0.1',
    gamePort: 0,
    parentPort: 0,
    gameDir,
    width: 960,
    height: 600,
  });
  context.after(() => harness.close());

  assert.notEqual(new URL(harness.gameOrigin).origin, new URL(harness.parentOrigin).origin);
  const [gameResponse, parentResponse, attemptedRedirect] = await Promise.all([
    fetch(`${harness.gameOrigin}/`),
    fetch(`${harness.parentOrigin}/`),
    fetch(`${harness.parentOrigin}/?game=https://example.com/remote-build`),
  ]);
  assert.equal(gameResponse.status, 200);
  assert.match(await gameResponse.text(), /<title>Onigokko<\/title>/);
  assert.equal(parentResponse.status, 200);
  const parent = await parentResponse.text();
  assert.match(parent, new RegExp(harness.gameOrigin.replaceAll('.', '\\.')));
  assert.match(parent, /width: 960px; height: 600px/);
  assert.match(parent, /Click to run/);
  assert.match(parent, /requestFullscreen/);
  assert.doesNotMatch(parent, /URLSearchParams/);
  const redirectBody = await attemptedRedirect.text();
  assert.match(redirectBody, new RegExp(harness.gameOrigin.replaceAll('.', '\\.')));
  assert.doesNotMatch(redirectBody, /example\.com/);
});

test('does not serve paths outside the game directory', async (context) => {
  const gameDir = await mkdtemp(join(tmpdir(), 'onigokko-harness-'));
  await writeFile(join(gameDir, 'index.html'), '<title>Onigokko</title>');
  const harness = await startHarness({
    host: '127.0.0.1',
    gamePort: 0,
    parentPort: 0,
    gameDir,
    width: 390,
    height: 844,
  });
  context.after(() => harness.close());
  const response = await fetch(`${harness.gameOrigin}/..%2F..%2Fetc%2Fpasswd`);
  assert.equal(response.status, 403);
});

test('does not follow a game-directory symlink outside the real root', async (context) => {
  const gameDir = await mkdtemp(join(tmpdir(), 'onigokko-harness-game-'));
  const outsideDir = await mkdtemp(join(tmpdir(), 'onigokko-harness-outside-'));
  await writeFile(join(gameDir, 'index.html'), '<title>Onigokko</title>');
  await writeFile(join(outsideDir, 'secret.txt'), 'REVIEW-SECRET');
  await symlink(outsideDir, join(gameDir, 'escape'));
  const harness = await startHarness({
    host: '127.0.0.1',
    gamePort: 0,
    parentPort: 0,
    gameDir,
    width: 960,
    height: 600,
  });
  context.after(() => harness.close());
  const response = await fetch(`${harness.gameOrigin}/escape/secret.txt`);
  assert.equal(response.status, 403);
  assert.notEqual(await response.text(), 'REVIEW-SECRET');
});
