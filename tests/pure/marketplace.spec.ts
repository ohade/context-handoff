// FIXTURE: the marketplace install gate requires the complete standalone plugin root.
import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const pluginRoot = resolve(import.meta.dir, '..', '..')

test('the public catalog installs the whole plugin with its existing command namespace', () => {
  const catalogPath = join(pluginRoot, '.claude-plugin', 'marketplace.json')
  expect(existsSync(catalogPath), 'standard plugin installation requires a public catalog').toBe(true)

  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
  expect(catalog.name).toBe('context-handoff')
  expect(catalog.plugins).toHaveLength(1)
  const entry = catalog.plugins[0]
  expect(entry.name).toBe('context-handoff')
  expect(entry.source).toBe('./')

  const installedRoot = resolve(pluginRoot, entry.source)
  const manifest = JSON.parse(readFileSync(join(installedRoot, '.claude-plugin', 'plugin.json'), 'utf8'))
  expect(manifest.name).toBe(entry.name)
  for (const resource of [
    'hooks/hooks.json', 'hooks/register.tsx',
    'skills/compact-crafter/SKILL.md',
    'skills/compact-crafter/reference/snapshot-template.md',
    'scripts/transcript-facts.py',
  ]) {
    expect(existsSync(join(installedRoot, resource)), `${resource} must be installed with the plugin`).toBe(true)
  }
})
