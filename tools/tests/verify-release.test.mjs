import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';

import { internals, verifyRelease } from '../verify-release.mjs';

function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, source] of entries) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(source);
    const compressed = name.endsWith('/') ? Buffer.alloc(0) : deflateRawSync(data);
    const method = name.endsWith('/') ? 0 : 8;
    const checksum = internals.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(local, nameBuffer, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBuffer);
    localOffset += local.length + nameBuffer.length + compressed.length;
  }
  const centralOffset = localOffset;
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

const releaseEntries = [
  ['index.html', '<title>Onigokko</title>'],
  ['main.js', 'export {};'],
  ['README.md', '# Onigokko'],
  ['THIRD_PARTY_NOTICES.txt', 'THIRD-PARTY NOTICES — Onigokko\n'],
  ['sim/', ''],
  ['sim/game.js', 'export class Game {}'],
  ['view/', ''],
  ['view/input.js', 'export {};'],
  ['vendor/', ''],
  ['vendor/three.module.js', 'export {};'],
];
const releaseTree = releaseEntries
  .filter(([name]) => !name.endsWith('/'))
  .map(([path]) => ({ path, type: 'blob' }));

async function fakeRelease(options = {}) {
  const entries = options.entries ?? releaseEntries;
  const archive = zip(entries);
  const archiveSha = createHash('sha256').update(archive).digest('hex');
  const sidecarSha = options.sidecarSha ?? archiveSha;
  const sidecar = Buffer.from(`${sidecarSha}  onigokko-v-test.zip\n`);
  const provenanceSha = options.provenanceSha ?? archiveSha;
  const provenanceDir = await mkdtemp(join(tmpdir(), 'onigokko-release-test-'));
  const provenancePath = join(provenanceDir, 'PROVENANCE.md');
  const fileCount = entries.filter(([name]) => !name.endsWith('/')).length;
  await writeFile(provenancePath, `# Provenance — Onigokko v-test

## Release archive

| | |
| --- | --- |
| File | \`onigokko-v-test.zip\` |
| Size | ${archive.length} bytes |
| SHA-256 | \`${provenanceSha}\` |
| Entries | ${fileCount} files |
`);

  let apiBase;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, apiBase).pathname;
    let status = 200;
    let body;
    let type = 'application/json';
    if (pathname === '/repos/test/onigokko/releases/tags/v-test') {
      body = JSON.stringify({
        tag_name: 'v-test',
        name: 'Onigokko v-test',
        draft: false,
        prerelease: false,
        assets: [
          {
            name: 'onigokko-v-test.zip',
            url: `${apiBase}/assets/archive`,
            size: archive.length,
            digest: `sha256:${archiveSha}`,
          },
          {
            name: 'onigokko-v-test.zip.sha256',
            url: `${apiBase}/assets/checksum`,
            size: sidecar.length,
            digest: `sha256:${createHash('sha256').update(sidecar).digest('hex')}`,
          },
        ],
      });
    } else if (pathname === '/repos/test/onigokko/git/trees/v-test') {
      body = JSON.stringify({ truncated: false, tree: options.tree ?? releaseTree });
    } else if (pathname === '/assets/archive') {
      body = archive;
      type = 'application/zip';
    } else if (pathname === '/assets/checksum') {
      body = sidecar;
      type = 'text/plain';
    } else {
      status = 404;
      body = JSON.stringify({ message: 'not found' });
    }
    response.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  apiBase = `http://127.0.0.1:${server.address().port}`;
  return {
    apiBase,
    provenance: provenancePath,
    close: () => new Promise((resolvePromise, reject) => {
      server.close((error) => (error ? reject(error) : resolvePromise()));
    }),
  };
}

async function withFakeRelease(options, callback) {
  const fixture = await fakeRelease(options);
  try {
    return await callback(fixture);
  } finally {
    await fixture.close();
  }
}

function verifyFixture(fixture) {
  return verifyRelease({
    repo: 'test/onigokko',
    tag: 'v-test',
    provenance: fixture.provenance,
    apiBase: fixture.apiBase,
  });
}

const provenance = `# Provenance — Onigokko v0.1

## Release archive

| | |
| --- | --- |
| File | \`onigokko-v0.1.zip\` |
| Size | 551,874 bytes |
| SHA-256 | \`3eba5a04a1296563fbd2bf5ac0f4fc0d708e74b20895a32559aee0dbdd42a752\` |
| Entries | 30 files — playable files |
`;

test('parses the tagged provenance release record', () => {
  assert.deepEqual(internals.parseProvenance(provenance, 'v0.1'), {
    file: 'onigokko-v0.1.zip',
    size: 551874,
    sha256: '3eba5a04a1296563fbd2bf5ac0f4fc0d708e74b20895a32559aee0dbdd42a752',
    fileCount: 30,
  });
  assert.throws(() => internals.parseProvenance(provenance, 'v0.1.1'), /no top-level record/);
});

test('parses a strict sha256sum file', () => {
  const digest = 'a'.repeat(64);
  assert.equal(internals.parseChecksumFile(`${digest}  game.zip\n`, 'game.zip'), digest);
  assert.throws(() => internals.parseChecksumFile(`${digest}  other.zip\n`, 'game.zip'), /checksum names/);
  assert.throws(() => internals.parseChecksumFile(`${digest}  game.zip\nextra\n`, 'game.zip'), /exactly one/);
});

test('reads stored directories and deflated files from a zip', () => {
  const archive = internals.parseZip(zip([
    ['index.html', '<title>Onigokko</title>'],
    ['view/', ''],
    ['view/input.js', 'export {};'],
  ]));
  assert.deepEqual(archive.entries.map((entry) => entry.name), ['index.html', 'view/', 'view/input.js']);
  assert.equal(archive.readEntry('view/input.js').toString(), 'export {};');
});

test('rejects a file whose ZIP CRC-32 is corrupt', () => {
  const archive = zip([['index.html', '<title>Onigokko</title>']]);
  const corrupt = Buffer.from(archive);
  const central = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  corrupt.writeUInt32LE((corrupt.readUInt32LE(central + 16) ^ 1) >>> 0, central + 16);
  assert.throws(() => internals.parseZip(corrupt).readEntry('index.html'), /CRC-32 mismatch/);
});

test('rejects unsafe and duplicate zip entries', () => {
  assert.throws(() => internals.parseZip(zip([['../index.html', 'bad']])), /unsafe zip entry/);
  assert.throws(() => internals.parseZip(zip([['view\\input.js', 'bad']])), /unsafe zip entry/);
  assert.throws(() => internals.parseZip(zip([['index.html', 'one'], ['index.html', 'two']])), /duplicate zip entry/);
});

test('matches archive files exactly to the tagged release tree', () => {
  const archive = internals.parseZip(zip([
    ['index.html', '<title>Onigokko</title>'],
    ['view/', ''],
    ['view/input.js', 'export {};'],
  ]));
  assert.deepEqual(internals.compareArchive(archive, ['index.html', 'view/input.js']), {
    files: ['index.html', 'view/input.js'],
    directories: ['view/'],
  });
  assert.throws(
    () => internals.compareArchive(archive, ['index.html']),
    /extra files: view\/input\.js/,
  );
  assert.throws(
    () => internals.compareArchive(archive, ['index.html', 'view/input.js', 'main.js']),
    /missing files: main\.js/,
  );
  const collision = internals.parseZip(zip([
    ['index.html', '<title>Onigokko</title>'],
    ['INDEX.HTML', '<title>Onigokko</title>'],
  ]));
  assert.throws(
    () => internals.compareArchive(collision, ['index.html']),
    /case-colliding zip entries/,
  );
});

test('requires the exact Onigokko HTML title', () => {
  assert.doesNotThrow(() => internals.verifyHtmlTitle(Buffer.from('<title>Onigokko</title>')));
  assert.throws(() => internals.verifyHtmlTitle(Buffer.from('<title>OFA v2</title>')), /Onigokko/);
  assert.throws(() => internals.verifyHtmlTitle(Buffer.from('<main>Onigokko</main>')), /exactly one/);
  assert.throws(
    () => internals.verifyHtmlTitle(Buffer.from('<title>Onigokko</title><title>Onigokko</title>')),
    /exactly one/,
  );
});

test('filters the tagged tree to the release allowlist', () => {
  const files = internals.releaseFilesFromTree({
    truncated: false,
    tree: [
      { type: 'blob', path: 'index.html' },
      { type: 'blob', path: 'main.js' },
      { type: 'blob', path: 'README.md' },
      { type: 'blob', path: 'THIRD_PARTY_NOTICES.txt' },
      { type: 'blob', path: 'sim/game.js' },
      { type: 'blob', path: 'view/input.js' },
      { type: 'blob', path: 'vendor/three.module.js' },
      { type: 'blob', path: 'tools/verify-release.mjs' },
      { type: 'blob', path: 'PROVENANCE.md' },
    ],
  });
  assert.deepEqual(files, [
    'README.md',
    'THIRD_PARTY_NOTICES.txt',
    'index.html',
    'main.js',
    'sim/game.js',
    'vendor/three.module.js',
    'view/input.js',
  ]);
  assert.throws(
    () => internals.releaseFilesFromTree({ truncated: false, tree: [] }),
    /tagged release tree is missing/,
  );
});

test('verifies a complete Release through the GitHub API contract', async () => {
  await withFakeRelease({}, async (fixture) => {
    const result = await verifyFixture(fixture);
    assert.equal(result.tag, 'v-test');
    assert.equal(result.files.length, 7);
  });
});

test('rejects corrupt checksum and provenance digests', async (context) => {
  await context.test('checksum sidecar', async () => {
    await withFakeRelease({ sidecarSha: 'a'.repeat(64) }, async (fixture) => {
      await assert.rejects(verifyFixture(fixture), /does not match checksum asset/);
    });
  });
  await context.test('provenance', async () => {
    await withFakeRelease({ provenanceSha: 'b'.repeat(64) }, async (fixture) => {
      await assert.rejects(verifyFixture(fixture), /does not match PROVENANCE\.md/);
    });
  });
});

test('rejects wrong tag trees and missing or extra archive entries', async (context) => {
  await context.test('wrong tag tree', async () => {
    await withFakeRelease({ tree: releaseTree.filter(({ path }) => path !== 'main.js') }, async (fixture) => {
      await assert.rejects(verifyFixture(fixture), /tagged release tree is missing main\.js/);
    });
  });
  await context.test('missing archive entry', async () => {
    await withFakeRelease({ entries: releaseEntries.filter(([path]) => path !== 'main.js') }, async (fixture) => {
      await assert.rejects(verifyFixture(fixture), /missing files: main\.js/);
    });
  });
  await context.test('extra archive entry', async () => {
    await withFakeRelease({ entries: [...releaseEntries, ['view/extra.js', 'export {};']] }, async (fixture) => {
      await assert.rejects(verifyFixture(fixture), /extra files: view\/extra\.js/);
    });
  });
});

test('rejects missing notices and wrong or missing titles', async (context) => {
  await context.test('notices heading', async () => {
    const entries = releaseEntries.map(([path, contents]) => [
      path,
      path === 'THIRD_PARTY_NOTICES.txt' ? 'not a notice' : contents,
    ]);
    await withFakeRelease({ entries }, async (fixture) => {
      await assert.rejects(verifyFixture(fixture), /does not contain the Onigokko notices heading/);
    });
  });
  await context.test('wrong title', async () => {
    const entries = releaseEntries.map(([path, contents]) => [
      path,
      path === 'index.html' ? '<title>OFA v2</title>' : contents,
    ]);
    await withFakeRelease({ entries }, async (fixture) => {
      await assert.rejects(verifyFixture(fixture), /<title>Onigokko<\/title>/);
    });
  });
  await context.test('missing title', async () => {
    const entries = releaseEntries.map(([path, contents]) => [
      path,
      path === 'index.html' ? '<main>Onigokko</main>' : contents,
    ]);
    await withFakeRelease({ entries }, async (fixture) => {
      await assert.rejects(verifyFixture(fixture), /<title>Onigokko<\/title>/);
    });
  });
});
