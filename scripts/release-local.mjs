#!/usr/bin/env node
/**
 * Build and install the CLI globally from the monorepo.
 *
 * `@t-cli/core` is a private workspace package that is never published, so a
 * plain `npm pack` of apps/cli would produce a tarball whose `@t-cli/core`
 * dependency cannot be resolved. This script stages a copy of the CLI with the
 * core package placed physically in its node_modules and declared in
 * `bundleDependencies`, so `npm pack` embeds it in the tarball.
 *
 * Usage:
 *   node scripts/release-local.mjs                 # bump patch, pack, install into ~/.npm-global
 *   node scripts/release-local.mjs --no-bump       # keep the current version
 *   node scripts/release-local.mjs --prefix <dir>  # install into another prefix (e.g. a temp dir)
 *   node scripts/release-local.mjs --pack-only     # stop after packing; prints the tarball path
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_DIR = path.join(ROOT, 'apps', 'cli');
const CORE_DIR = path.join(ROOT, 'packages', 'core');
const CLI_WORKSPACE = 't-cli-translator';
const CORE_NAME = '@t-cli/core';
// ~/.npm-global is the prefix that wins on PATH (see CLAUDE.md).
const DEFAULT_PREFIX = path.join(os.homedir(), '.npm-global');

function parseArgs(argv) {
  const prefixIndex = argv.indexOf('--prefix');
  if (prefixIndex !== -1 && !argv[prefixIndex + 1]) {
    throw new Error('--prefix requires a directory');
  }
  return {
    bump: !argv.includes('--no-bump'),
    packOnly: argv.includes('--pack-only'),
    prefix: prefixIndex === -1 ? DEFAULT_PREFIX : path.resolve(argv[prefixIndex + 1]),
  };
}

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function copyInto(srcDir, destDir, names) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of names) {
    fs.cpSync(path.join(srcDir, name), path.join(destDir, name), { recursive: true });
  }
}

function stagePackage(stageDir) {
  const cliPkg = readJson(path.join(CLI_DIR, 'package.json'));
  const corePkg = readJson(path.join(CORE_DIR, 'package.json'));
  const pinned = cliPkg.dependencies?.[CORE_NAME];
  if (pinned !== corePkg.version) {
    throw new Error(`${CLI_WORKSPACE} depends on ${CORE_NAME}@${pinned} but the workspace has ${corePkg.version}`);
  }
  if (!cliPkg.bundleDependencies?.includes(CORE_NAME)) {
    throw new Error(`${CLI_WORKSPACE} must list ${CORE_NAME} in bundleDependencies`);
  }

  copyInto(CLI_DIR, stageDir, [...cliPkg.files, 'package.json']);
  fs.cpSync(path.join(ROOT, 'README.md'), path.join(stageDir, 'README.md'));
  copyInto(CORE_DIR, path.join(stageDir, 'node_modules', CORE_NAME), [...corePkg.files, 'package.json']);
  return cliPkg;
}

function packStage(stageDir, outDir) {
  const tarballName = run('npm', ['pack', '--pack-destination', outDir], stageDir).split('\n').pop();
  const tarball = path.join(outDir, tarballName);
  const listing = run('tar', ['-tzf', tarball], outDir);
  if (!listing.includes(`package/node_modules/${CORE_NAME}/src/prompts.js`)) {
    throw new Error(`${CORE_NAME} is missing from ${tarballName}; bundling failed`);
  }
  return tarball;
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.bump) {
    run('npm', ['version', 'patch', '--no-git-tag-version', '-w', CLI_WORKSPACE], ROOT);
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 't-cli-release-'));
  const stageDir = path.join(workDir, 'stage');
  const outDir = path.join(workDir, 'out');
  fs.mkdirSync(outDir, { recursive: true });

  try {
    const cliPkg = stagePackage(stageDir);
    const tarball = packStage(stageDir, outDir);
    if (options.packOnly) {
      process.stdout.write(`${tarball}\n`);
      return;
    }
    execFileSync('npm', ['install', '-g', '--prefix', options.prefix, tarball], { stdio: 'inherit' });
    process.stdout.write(`Installed ${cliPkg.name}@${cliPkg.version} into ${options.prefix}\n`);
  } finally {
    if (!options.packOnly) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`release-local failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
