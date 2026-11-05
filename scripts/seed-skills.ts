// Seed skills (#114): skills/*.md (front matter with name, description and optional version, then the
// instructions) -> deploy/config-io/seed/skills.yaml, importable on a fresh install (Settings -> Configuration).
//   node --import tsx scripts/seed-skills.ts          # write the file
//   node --import tsx scripts/seed-skills.ts --check  # fail if it is out of date
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { ObjectDoc } from '../packages/core/src/objectEnvelope.js';

// Rendering only: the envelope module loads the server config, which needs these to be set.
process.env.ENCRYPTION_KEY ??= '0'.repeat(64);
process.env.SETUP_TOKEN ??= 'seed-skills-render-only-placeholder-token';
const { renderObjects, API_VERSION } = await import('../packages/core/src/objectEnvelope.js');

export const SEED_FILE = 'deploy/config-io/seed/skills.yaml';
export function seedSkillsYaml(dir = 'skills') {
  const docs = readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
    .map((f) => {
      const text = readFileSync(`${dir}/${f}`, 'utf8');
      const m = /^---\n([\s\S]*?)\n---\n+([\s\S]*)$/.exec(text);
      if (!m) throw new Error(`${f}: front matter (--- name / description ---) is required`);
      const meta = Object.fromEntries(
        m[1].split('\n').map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]),
      );
      if (!meta.name || !meta.description) throw new Error(`${f}: name and description are required`);
      return {
        apiVersion: API_VERSION,
        kind: 'Skill' as const,
        metadata: { name: meta.name, version: meta.version || '1.0.0' },
        spec: { description: meta.description, instructions: m[2].trimEnd(), enabled: true },
      };
    });
  return renderObjects(docs as ObjectDoc[]);
}
if (process.argv[1]?.endsWith('seed-skills.ts')) {
  const yaml = seedSkillsYaml();
  if (process.argv.includes('--check')) {
    if (readFileSync(SEED_FILE, 'utf8') !== yaml) {
      console.error(`${SEED_FILE} is out of date: run node --import tsx scripts/seed-skills.ts`);
      process.exit(1);
    }
  } else writeFileSync(SEED_FILE, yaml);
}
