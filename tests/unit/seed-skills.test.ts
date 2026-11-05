// #114: deploy/config-io/seed/skills.yaml is generated from skills/*.md and must be current.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { seedSkillsYaml, SEED_FILE } = await import('../../scripts/seed-skills.js');

test('the seed skills file matches skills/*.md (run scripts/seed-skills.ts after editing a skill)', () => {
  const yaml = seedSkillsYaml();
  assert.equal(readFileSync(SEED_FILE, 'utf8'), yaml);
  for (const name of ['strategy-library', 'write-a-strategy-plugin', 'read-the-catalog', 'judge-checklist'])
    assert.match(yaml, new RegExp(`metadata:\\n  name: ${name}\\n`));
});
