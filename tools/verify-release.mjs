#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const REPOSITORY = 'lrd-org/onigokko-play';
const API_BASE = 'https://api.github.com';
const RELEASE_ROOT_FILES = new Set([
  'index.html',
  'main.js',
  'README.md',
  'THIRD_PARTY_NOTICES.txt',
]);
const RELEASE_DIRECTORIES = ['sim/', 'view/', 'vendor/'];
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return value >>> 0;
});

function fail(message) {
  throw new Error(message);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function parseArgs(argv) {
  const options = {
    repo: REPOSITORY,
    apiBase: API_BASE,
    provenance: resolve(dirname(fileURLToPath(import.meta.url)), '..', 'PROVENANCE.md'),
    json: false,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--repo' || argument === '--provenance' || argument === '--api-base') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`${argument} requires a value`);
      index += 1;
      if (argument === '--repo') options.repo = value;
      if (argument === '--provenance') options.provenance = resolve(value);
      if (argument === '--api-base') options.apiBase = value.replace(/\/$/, '');
    } else if (argument === '--json') {
      options.json = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument.startsWith('-')) {
      fail(`unknown option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }

  if (!options.help && positional.length !== 1) {
    fail('exactly one Release tag is required (for example: v0.1)');
  }
  options.tag = positional[0];
  return options;
}

function usage() {
  return [
    'Usage: node tools/verify-release.mjs <tag> [options]',
    '',
    'Downloads the GitHub Release zip and checksum, then verifies them against',
    'the tagged repository tree and the matching PROVENANCE.md release record.',
    '',
    'Options:',
    `  --repo <owner/name>       GitHub repository (default: ${REPOSITORY})`,
    '  --provenance <path>       provenance document (default: ./PROVENANCE.md)',
    `  --api-base <url>          GitHub API base (default: ${API_BASE})`,
    '  --json                    print machine-readable results',
    '  -h, --help                show this help',
  ].join('\n');
}

function requestHeaders(accept = 'application/vnd.github+json') {
  const headers = {
    Accept: accept,
    'User-Agent': 'onigokko-release-verifier',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function fetchChecked(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500).trim();
    fail(`HTTP ${response.status} for ${url}${detail ? `: ${detail}` : ''}`);
  }
  return response;
}

async function fetchJson(url) {
  const response = await fetchChecked(url, { headers: requestHeaders() });
  return response.json();
}

async function fetchAsset(asset) {
  const response = await fetchChecked(asset.url, {
    headers: requestHeaders('application/octet-stream'),
    redirect: 'follow',
  });
  return Buffer.from(await response.arrayBuffer());
}

function parseChecksumFile(text, expectedFile) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length !== 1) fail('checksum asset must contain exactly one non-empty line');
  const match = /^([0-9a-fA-F]{64})[ \t]+[*]?([^\r\n]+)$/.exec(lines[0]);
  if (!match) fail('checksum asset is not in sha256sum format');
  const filename = match[2].trim();
  if (filename !== expectedFile) {
    fail(`checksum names ${filename}, expected ${expectedFile}`);
  }
  return match[1].toLowerCase();
}

function provenanceSection(markdown, tag) {
  const lines = markdown.split(/\r?\n/);
  const heading = new RegExp(`^#\\s+Provenance\\b.*(?:^|\\s)${escapeRegExp(tag)}\\s*$`, 'i');
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) fail(`PROVENANCE.md has no top-level record for ${tag}`);
  const next = lines.findIndex((line, index) => index > start && /^#\s+Provenance\b/i.test(line));
  return lines.slice(start, next < 0 ? undefined : next).join('\n');
}

function tableValue(section, label) {
  const pattern = new RegExp(`^\\|\\s*${escapeRegExp(label)}\\s*\\|\\s*(.*?)\\s*\\|\\s*$`, 'mi');
  const match = pattern.exec(section);
  if (!match) fail(`PROVENANCE.md release record is missing ${label}`);
  return match[1].replaceAll('`', '').trim();
}

function parseProvenance(markdown, tag) {
  const section = provenanceSection(markdown, tag);
  const releaseHeading = /^##\s+Release archive\s*$/mi.exec(section);
  if (!releaseHeading) {
    fail(`PROVENANCE.md record for ${tag} has no Release archive section`);
  }
  const afterHeading = section.slice(releaseHeading.index + releaseHeading[0].length);
  const nextHeading = /^##\s+/m.exec(afterHeading);
  const releaseSection = afterHeading.slice(0, nextHeading?.index);
  const file = tableValue(releaseSection, 'File');
  const sizeText = tableValue(releaseSection, 'Size');
  const sha256 = tableValue(releaseSection, 'SHA-256').toLowerCase();
  const entriesText = tableValue(releaseSection, 'Entries');
  const sizeMatch = /^([0-9][0-9,]*)\s+bytes\b/i.exec(sizeText);
  const entriesMatch = /^([0-9][0-9,]*)\s+files?\b/i.exec(entriesText);
  if (!sizeMatch) fail(`invalid PROVENANCE.md Size value: ${sizeText}`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail(`invalid PROVENANCE.md SHA-256 value: ${sha256}`);
  if (!entriesMatch) fail(`invalid PROVENANCE.md Entries value: ${entriesText}`);
  return {
    file,
    size: Number(sizeMatch[1].replaceAll(',', '')),
    sha256,
    fileCount: Number(entriesMatch[1].replaceAll(',', '')),
  };
}

function findEndOfCentralDirectory(buffer) {
  const signature = 0x06054b50;
  const firstPossible = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= firstPossible; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature
        && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) {
      return offset;
    }
  }
  fail('zip end-of-central-directory record not found');
}

function safeZipName(name) {
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/')) return false;
  const parts = name.split('/').filter(Boolean);
  return parts.length > 0 && parts.every((part) => part !== '.' && part !== '..');
}

function parseZip(buffer) {
  const end = findEndOfCentralDirectory(buffer);
  const disk = buffer.readUInt16LE(end + 4);
  const centralDisk = buffer.readUInt16LE(end + 6);
  const diskEntries = buffer.readUInt16LE(end + 8);
  const totalEntries = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralOffset = buffer.readUInt32LE(end + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    fail('multi-disk zip archives are not supported');
  }
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    fail('ZIP64 archives are not supported');
  }
  if (centralOffset + centralSize > end) fail('zip central directory is out of bounds');

  const entries = [];
  const names = new Set();
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      fail(`invalid zip central-directory entry ${index + 1}`);
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const checksum = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const endOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (endOffset > buffer.length) fail(`zip central-directory entry ${index + 1} is truncated`);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (!safeZipName(name)) fail(`unsafe zip entry name: ${JSON.stringify(name)}`);
    if (names.has(name)) fail(`duplicate zip entry: ${name}`);
    if ((flags & 0x1) !== 0) fail(`encrypted zip entry is not supported: ${name}`);
    if (method !== 0 && method !== 8) fail(`unsupported compression method ${method}: ${name}`);
    names.add(name);
    entries.push({ name, flags, method, checksum, compressedSize, uncompressedSize, localOffset });
    offset = endOffset;
  }
  if (offset !== centralOffset + centralSize) fail('zip central-directory size does not match its entries');

  function readEntry(name) {
    const entry = entries.find((candidate) => candidate.name === name);
    if (!entry || name.endsWith('/')) fail(`zip file not found: ${name}`);
    const local = entry.localOffset;
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) {
      fail(`invalid local header for ${name}`);
    }
    const localNameLength = buffer.readUInt16LE(local + 26);
    const localExtraLength = buffer.readUInt16LE(local + 28);
    const localFlags = buffer.readUInt16LE(local + 6);
    const localMethod = buffer.readUInt16LE(local + 8);
    const localName = buffer.subarray(local + 30, local + 30 + localNameLength).toString('utf8');
    if (localName !== entry.name || localFlags !== entry.flags || localMethod !== entry.method) {
      fail(`local header does not match central directory for ${name}`);
    }
    const dataStart = local + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buffer.length) fail(`compressed data is truncated for ${name}`);
    const compressed = buffer.subarray(dataStart, dataEnd);
    const contents = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
    if (contents.length !== entry.uncompressedSize) {
      fail(`uncompressed size mismatch for ${name}`);
    }
    const actualChecksum = crc32(contents);
    if (actualChecksum !== entry.checksum) {
      fail(`CRC-32 mismatch for ${name}`);
    }
    return contents;
  }

  return { entries, readEntry };
}

function releaseFilesFromTree(tree) {
  if (tree.truncated) fail('GitHub tag tree is truncated');
  const files = tree.tree
    .filter((entry) => entry.type === 'blob')
    .map((entry) => entry.path)
    .filter((path) => RELEASE_ROOT_FILES.has(path)
      || RELEASE_DIRECTORIES.some((directory) => path.startsWith(directory)))
    .sort();
  for (const rootFile of RELEASE_ROOT_FILES) {
    if (!files.includes(rootFile)) fail(`tagged release tree is missing ${rootFile}`);
  }
  for (const directory of RELEASE_DIRECTORIES) {
    if (!files.some((file) => file.startsWith(directory))) {
      fail(`tagged release tree has no files under ${directory}`);
    }
  }
  return files;
}

function verifyAssetMetadata(asset, buffer) {
  if (asset.size !== buffer.length) {
    fail(`GitHub asset ${asset.name} size ${asset.size} does not match downloaded size ${buffer.length}`);
  }
  if (asset.digest) {
    const digest = `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
    if (asset.digest !== digest) {
      fail(`GitHub asset ${asset.name} digest ${asset.digest} does not match ${digest}`);
    }
  }
}

function expectedDirectories(files) {
  const directories = new Set();
  for (const file of files) {
    const parts = file.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(`${parts.slice(0, index).join('/')}/`);
    }
  }
  return directories;
}

function compareArchive(zip, expectedFiles) {
  const archiveFiles = zip.entries.filter((entry) => !entry.name.endsWith('/')).map((entry) => entry.name).sort();
  const archiveDirectories = zip.entries.filter((entry) => entry.name.endsWith('/')).map((entry) => entry.name).sort();
  const expectedFileSet = new Set(expectedFiles);
  const expectedDirectorySet = expectedDirectories(expectedFiles);
  const foldedNames = new Map();
  for (const entry of zip.entries) {
    const folded = entry.name.toLowerCase();
    if (foldedNames.has(folded) && foldedNames.get(folded) !== entry.name) {
      fail(`case-colliding zip entries: ${foldedNames.get(folded)}, ${entry.name}`);
    }
    foldedNames.set(folded, entry.name);
  }
  const missing = expectedFiles.filter((file) => !archiveFiles.includes(file));
  const extra = archiveFiles.filter((file) => !expectedFileSet.has(file));
  const extraDirectories = archiveDirectories.filter((directory) => !expectedDirectorySet.has(directory));
  if (missing.length || extra.length || extraDirectories.length) {
    const details = [
      missing.length ? `missing files: ${missing.join(', ')}` : '',
      extra.length ? `extra files: ${extra.join(', ')}` : '',
      extraDirectories.length ? `extra directories: ${extraDirectories.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    fail(`archive does not match the tagged release tree (${details})`);
  }
  return { files: archiveFiles, directories: archiveDirectories };
}

function verifyHtmlTitle(contents) {
  const html = contents.toString('utf8');
  const titles = [...html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/gi)];
  if (titles.length !== 1 || titles[0][1].trim() !== 'Onigokko') {
    fail('index.html must contain exactly one <title>Onigokko</title>');
  }
}

export async function verifyRelease({ repo, tag, provenance, apiBase = API_BASE }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) fail(`unsafe Release tag: ${tag}`);
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) fail(`invalid GitHub repository: ${repo}`);
  const encodedRepo = repo.split('/').map(encodeURIComponent).join('/');
  const encodedTag = encodeURIComponent(tag);
  const release = await fetchJson(`${apiBase}/repos/${encodedRepo}/releases/tags/${encodedTag}`);
  if (release.tag_name !== tag) fail(`Release tag is ${release.tag_name}, expected ${tag}`);
  if (release.name !== `Onigokko ${tag}`) {
    fail(`Release title is ${JSON.stringify(release.name)}, expected ${JSON.stringify(`Onigokko ${tag}`)}`);
  }
  if (release.draft || release.prerelease) fail(`${tag} must be a published, non-prerelease Release`);

  const provenanceText = await readFile(provenance, 'utf8');
  const record = parseProvenance(provenanceText, tag);
  const zipAsset = release.assets.find((asset) => asset.name === record.file);
  const checksumAsset = release.assets.find((asset) => asset.name === `${record.file}.sha256`);
  if (!zipAsset) fail(`Release has no asset named ${record.file}`);
  if (!checksumAsset) fail(`Release has no asset named ${record.file}.sha256`);

  const [zipBuffer, checksumBuffer, tree] = await Promise.all([
    fetchAsset(zipAsset),
    fetchAsset(checksumAsset),
    fetchJson(`${apiBase}/repos/${encodedRepo}/git/trees/${encodedTag}?recursive=1`),
  ]);
  const checksum = parseChecksumFile(checksumBuffer.toString('utf8'), record.file);
  const actualSha256 = createHash('sha256').update(zipBuffer).digest('hex');
  if (actualSha256 !== checksum) fail(`zip SHA-256 ${actualSha256} does not match checksum asset ${checksum}`);
  if (actualSha256 !== record.sha256) fail(`zip SHA-256 ${actualSha256} does not match PROVENANCE.md ${record.sha256}`);
  verifyAssetMetadata(zipAsset, zipBuffer);
  verifyAssetMetadata(checksumAsset, checksumBuffer);
  if (zipBuffer.length !== record.size) {
    fail(`zip size ${zipBuffer.length} does not match PROVENANCE.md ${record.size}`);
  }
  const zip = parseZip(zipBuffer);
  const expectedFiles = releaseFilesFromTree(tree);
  const archive = compareArchive(zip, expectedFiles);
  if (!archive.files.includes('index.html')) fail('index.html is not at the archive root');
  if (!archive.files.includes('THIRD_PARTY_NOTICES.txt')) fail('THIRD_PARTY_NOTICES.txt is missing');
  if (archive.files.length !== record.fileCount) {
    fail(`archive has ${archive.files.length} files, PROVENANCE.md records ${record.fileCount}`);
  }
  const contents = new Map(archive.files.map((file) => [file, zip.readEntry(file)]));
  const notices = contents.get('THIRD_PARTY_NOTICES.txt').toString('utf8');
  if (!/^THIRD-PARTY NOTICES — Onigokko\s*$/m.test(notices)) {
    fail('THIRD_PARTY_NOTICES.txt does not contain the Onigokko notices heading');
  }
  verifyHtmlTitle(contents.get('index.html'));

  return {
    repository: repo,
    tag,
    releaseTitle: release.name,
    asset: record.file,
    bytes: zipBuffer.length,
    sha256: actualSha256,
    files: archive.files,
    directoryEntries: archive.directories,
    checks: [
      'release tag and title',
      'published Release state',
      'sha256 asset',
      'GitHub asset digest and size',
      'PROVENANCE.md sha256, size, and file count',
      'tagged release-tree manifest',
      'index.html at archive root',
      'THIRD_PARTY_NOTICES.txt heading',
      'HTML title Onigokko',
    ],
  };
}

function printResult(result) {
  console.log(`PASS ${result.repository} ${result.tag}`);
  console.log(`Release: ${result.releaseTitle}`);
  console.log(`Asset:   ${result.asset} (${result.bytes} bytes)`);
  console.log(`SHA-256: ${result.sha256}`);
  console.log(`Files (${result.files.length}):`);
  for (const file of result.files) console.log(`  ${file}`);
  if (result.directoryEntries.length) {
    console.log(`Directory entries (${result.directoryEntries.length}):`);
    for (const directory of result.directoryEntries) console.log(`  ${directory}`);
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const result = await verifyRelease(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else printResult(result);
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}

export const internals = {
  compareArchive,
  crc32,
  parseArgs,
  parseChecksumFile,
  parseProvenance,
  parseZip,
  releaseFilesFromTree,
  verifyAssetMetadata,
  verifyHtmlTitle,
};
