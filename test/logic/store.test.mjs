// engram/store.mjs — the temporal knowledge-graph store over node:sqlite. The invariant
// under test: at most ONE current fact per (subject, predicate) — a newer fact with a
// different object INVALIDATES the old one (valid_to set, superseded_by set) instead of
// deleting it, so history survives and recall knows current vs. superseded. All in-memory
// (:memory:), deterministic timestamps passed in (the module never calls Date.now itself).
//
// Requires Node ≥22.5 (node:sqlite). CI runs the shared job on Node 24 for exactly this.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  openStore, addEpisode, upsertEntity, addFact, recall, factsAbout, stats,
} from '../../config-template/opencode/engram/store.mjs'

test('addEpisode: stores a provenance chunk and returns its id', () => {
  const db = openStore(':memory:')
  const id = addEpisode(db, { content: 'a captured chunk', capturedAt: 1000 })
  assert.equal(typeof id, 'number')
  assert.equal(stats(db).episodes, 1)
})

test('upsertEntity: dedups by (name, project) and never clobbers an existing type', () => {
  const db = openStore(':memory:')
  const a = upsertEntity(db, { name: 'gmk128', type: 'box', t: 1000 })
  const b = upsertEntity(db, { name: 'gmk128', type: 'server', t: 2000 }) // same node
  assert.equal(a, b, 'same (name, project) → same id, no duplicate row')
  assert.equal(stats(db).entities, 1)
  const row = db.prepare('SELECT type FROM entities WHERE id = ?').get(a)
  assert.equal(row.type, 'box', 'COALESCE keeps the first non-null type')
})

test('upsertEntity: a later type fills in a previously-null type', () => {
  const db = openStore(':memory:')
  const id = upsertEntity(db, { name: 'deco', type: null, t: 1000 })
  upsertEntity(db, { name: 'deco', type: 'router', t: 2000 })
  assert.equal(db.prepare('SELECT type FROM entities WHERE id = ?').get(id).type, 'router')
})

test('addFact: a newer fact with a different object supersedes the old one (temporal invariant)', () => {
  const db = openStore(':memory:')
  const r1 = addFact(db, { statement: 'net uses wifi 6', subject: 'network', predicate: 'uses', object: 'wifi6', createdAt: 1000 })
  assert.deepEqual(r1.superseded, [])
  assert.equal(r1.duplicate, false)

  const r2 = addFact(db, { statement: 'net uses wifi 7', subject: 'network', predicate: 'uses', object: 'wifi7', createdAt: 2000 })
  assert.deepEqual(r2.superseded, [r1.id], 'the old fact is invalidated, not deleted')
  assert.equal(r2.duplicate, false)

  // round-trip the invariant through the persisted store, not the return value
  const s = stats(db)
  assert.equal(s.facts, 2, 'the old fact still exists (history preserved)')
  assert.equal(s.currentFacts, 1, 'exactly one current fact for the subject/predicate')
  assert.equal(s.supersededFacts, 1)
  const current = db.prepare('SELECT count(*) c FROM facts WHERE subject = ? AND predicate = ? AND valid_to IS NULL').get('network', 'uses')
  assert.equal(current.c, 1, 'THE INVARIANT: never two current facts for one (subject, predicate)')
  const old = db.prepare('SELECT valid_to, superseded_by FROM facts WHERE id = ?').get(r1.id)
  assert.equal(old.valid_to, 2000)
  assert.equal(Number(old.superseded_by), r2.id)
})

test('addFact: an identical current fact reaffirms without a duplicate row', () => {
  const db = openStore(':memory:')
  const r1 = addFact(db, { statement: 'x uses y', subject: 'x', predicate: 'uses', object: 'y', createdAt: 1000 })
  const r2 = addFact(db, { statement: 'x uses y', subject: 'x', predicate: 'uses', object: 'y', createdAt: 2000 })
  assert.equal(r2.duplicate, true)
  assert.equal(r2.id, r1.id, 'reaffirm returns the existing id')
  assert.equal(stats(db).facts, 1, 'no second row created')
})

test('addFact: a blank statement is rejected', () => {
  const db = openStore(':memory:')
  assert.equal(addFact(db, { statement: '   ', createdAt: 1000 }), null)
  assert.equal(stats(db).facts, 0)
})

test('recall: FTS path returns only current facts matching the query terms', () => {
  const db = openStore(':memory:') // FTS on by default
  addFact(db, { statement: 'net uses wifi 6', subject: 'network', predicate: 'uses', object: 'wifi6', createdAt: 1000 })
  addFact(db, { statement: 'net uses wifi 7', subject: 'network', predicate: 'uses', object: 'wifi7', createdAt: 2000 })
  const hits = recall(db, { query: 'wifi' })
  assert.equal(hits.length, 1, 'the superseded fact is excluded by default')
  assert.match(hits[0].statement, /wifi 7/)
  assert.equal(hits[0].status, 'current')
})

test('recall: the LIKE fallback (fts:false) returns the same current-only result', () => {
  const db = openStore(':memory:', { fts: false })
  addFact(db, { statement: 'net uses wifi 6', subject: 'network', predicate: 'uses', object: 'wifi6', createdAt: 1000 })
  addFact(db, { statement: 'net uses wifi 7', subject: 'network', predicate: 'uses', object: 'wifi7', createdAt: 2000 })
  const hits = recall(db, { query: 'wifi' })
  assert.equal(hits.length, 1)
  assert.match(hits[0].statement, /wifi 7/)
})

test('recall: an empty query returns nothing', () => {
  const db = openStore(':memory:')
  addFact(db, { statement: 'a fact', subject: 's', predicate: 'p', object: 'o', createdAt: 1000 })
  assert.deepEqual(recall(db, { query: '' }), [])
})

test('factsAbout: graph traversal finds facts touching a named entity (subject or object)', () => {
  const db = openStore(':memory:')
  addFact(db, { statement: 'network uses wifi7', subject: 'network', predicate: 'uses', object: 'wifi7', createdAt: 1000 })
  addFact(db, { statement: 'deco connects network', subject: 'deco', predicate: 'connects', object: 'network', createdAt: 2000 })
  const hits = factsAbout(db, ['network'])
  assert.equal(hits.length, 2, 'matches both the subject and the object occurrence')
  assert.deepEqual(hits.map((h) => h.subject).sort(), ['deco', 'network'])
})
