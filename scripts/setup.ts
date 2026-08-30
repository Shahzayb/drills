// First-run setup. `pnpm run setup`.
//
// Was scripts/setup.sh. CLAUDE.md's rule is that a script is plain Node and
// shell is only for one-liners inside package.json, and this had grown past
// that. See plans/2026-08-30_instrument-typescript.md.
//
// Runs on the HOST, before anything is up — so it may not assume Docker is
// running, and it deliberately does not assume .env exists.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const path = (name: string) => fileURLToPath(new URL(name, root));

if (existsSync(path('.env'))) {
  console.log('✓ .env already exists');
} else {
  console.log('📋 Creating .env from .env.example...');
  copyFileSync(path('.env.example'), path('.env'));
  console.log('✓ .env created with default values');
}

// `docker ps` rather than `docker info`: it is the cheapest call that fails
// when the daemon is not running, which is the state this is checking for.
const daemon = spawnSync('docker', ['ps'], { stdio: 'ignore' });
if (daemon.status !== 0) {
  console.error('❌ Docker is not running. Please start Docker and try again.');
  process.exit(1);
}

console.log('🚀 Starting services...');

const { status, error } = spawnSync('npm', ['run', 'docker:up'], {
  cwd: path('.'),
  stdio: 'inherit',
});

if (error) {
  console.error(`could not run npm: ${error.message}`);
  process.exit(1);
}
process.exit(status ?? 1);
