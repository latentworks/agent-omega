import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ui = fs.readFileSync(path.join(ROOT, 'ui', 'app.html'), 'utf8')
const modern = fs.readFileSync(path.join(ROOT, 'ui', 'modern-theme.css'), 'utf8')

test('operator runner is persistent and names the boundaries of its data contract', () => {
  assert.match(ui, /id="operatorRunner"/)
  assert.match(ui, /id="runnerModel"/)
  assert.match(ui, /id="runnerTokens"/)
  assert.match(ui, /id="runnerContextLimit"/)
  assert.match(ui, /id="runnerProviderQuota"[^>]*>not reported</)
  assert.match(ui, /function setUsage\(used,size\)/)
  assert.match(ui, /runnerTokens\.textContent=s/)
  assert.match(ui, /runnerLimit\.textContent=size>0/)
  assert.match(ui, /function clearUsage\(\)/)
  assert.match(ui, /runnerTokens\.textContent='—'/)
  assert.match(ui, /const sessionChanged=!!m\.sessionId && m\.sessionId!==sessionId/)
  assert.match(ui, /if\(sessionChanged\)\{ clearUsage\(\); costEl\.textContent=''\; \}/)
  assert.match(ui, /runnerModel\.textContent=mName/)
  assert.match(modern, /body\.theme-modern \.ao-runner/)
})
