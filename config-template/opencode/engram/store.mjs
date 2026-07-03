// engram/store.mjs — the temporal knowledge-graph store.
//
// Pure data layer over node:sqlite (built into Node 24, ZERO external deps, so it
// works behind the firewall). No OpenCode/network here → fully unit-testable.
//
// The brain has three tables:
//   episodes  — raw chunks captured when context is about to be dropped (provenance)
//   entities  — the nodes (people, models, files, configs, concepts)
//   facts     — temporal edges/statements. Each fact has valid_from / valid_to;
//               valid_to IS NULL means "still true now". When a newer fact about the
//               same (subject, predicate) arrives with a different object, the old one
//               is INVALIDATED (valid_to + superseded_by set) — never deleted — so the
//               history survives and recall knows what's current vs. superseded.
//   facts_fts — FTS5 mirror of fact statements → ranked keyword recall, no embeddings.

// Runtime-adaptive SQLite: OpenCode runs on Bun (bun:sqlite), our tests run on
// Node (node:sqlite). Both expose .exec / .prepare / .run / .get / .all. The
// unused branch's dynamic import is never evaluated (ternary short-circuits), so
// node never tries to load bun:sqlite and vice-versa.
const IS_BUN = typeof globalThis.Bun !== 'undefined'
const _sqlite = IS_BUN ? await import('bun:sqlite') : await import('node:sqlite')
const makeDb = IS_BUN ? (p) => new _sqlite.Database(p) : (p) => new _sqlite.DatabaseSync(p)

// Tracks whether FTS5 is usable on a given db (Bun's bundled SQLite may lack it).
const ftsCapable = new WeakMap()

const SCHEMA = `
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  project TEXT NOT NULL DEFAULT 'global',
  content TEXT NOT NULL,
  captured_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  project TEXT NOT NULL DEFAULT 'global',
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  UNIQUE(name, project)
);
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY,
  statement TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'chat',
  subject TEXT,
  predicate TEXT,
  object TEXT,
  project TEXT NOT NULL DEFAULT 'global',
  source_episode INTEGER,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  created_at INTEGER NOT NULL,
  superseded_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_facts_sp ON facts(subject, predicate, valid_to);
CREATE INDEX IF NOT EXISTS idx_facts_project ON facts(project, valid_to);
CREATE INDEX IF NOT EXISTS idx_facts_object ON facts(object, valid_to);
`

export function openStore(path = ':memory:', { fts: wantFts = true } = {}) {
  const db = makeDb(path)
  // WAL + a busy timeout so the main agent and the council can share this one DB
  // file concurrently (multiple connections) without tripping over each other.
  try { db.exec('PRAGMA journal_mode = WAL;') } catch {}
  try { db.exec('PRAGMA busy_timeout = 5000;') } catch {}
  db.exec(SCHEMA)
  try { db.exec("ALTER TABLE facts ADD COLUMN source TEXT NOT NULL DEFAULT 'chat'") } catch {}  // migrate older DBs that predate the trust column
  // FTS5 powers ranked recall, but Bun's bundled SQLite may not include it —
  // probe it for real (create + insert + MATCH), and fall back to a LIKE scan if
  // it's unavailable. Recall works either way. (fts:false forces the fallback.)
  let fts = false
  if (wantFts) {
    try {
      db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(statement);')
      db.prepare('INSERT INTO facts_fts(rowid, statement) VALUES (?, ?)').run(-1, 'engram fts capability probe')
      const ok = db.prepare('SELECT rowid FROM facts_fts WHERE facts_fts MATCH ? LIMIT 1').get('probe')
      db.prepare('DELETE FROM facts_fts WHERE rowid = ?').run(-1)
      fts = !!ok
    } catch {
      fts = false
    }
  }
  ftsCapable.set(db, fts)
  return db
}

export function addEpisode(db, { sessionId = null, project = 'global', content, capturedAt }) {
  const r = db
    .prepare('INSERT INTO episodes(session_id, project, content, captured_at) VALUES (?, ?, ?, ?)')
    .run(sessionId, project, content, capturedAt)
  return Number(r.lastInsertRowid)
}

// Insert-or-touch an entity; deduped by (name, project). Returns its id.
export function upsertEntity(db, { name, type = null, project = 'global', t }) {
  if (!name) return null
  db.prepare(`
    INSERT INTO entities(name, type, project, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name, project) DO UPDATE SET
      last_seen = excluded.last_seen,
      type = COALESCE(entities.type, excluded.type)
  `).run(name, type, project, t, t)
  const row = db.prepare('SELECT id FROM entities WHERE name = ? AND project = ?').get(name, project)
  return row ? Number(row.id) : null
}

const mapFact = (r) => ({
  id: Number(r.id),
  statement: r.statement,
  source: r.source || 'chat',
  subject: r.subject,
  predicate: r.predicate,
  object: r.object,
  project: r.project,
  status: r.valid_to == null ? 'current' : 'superseded',
  valid_from: r.valid_from,
  valid_to: r.valid_to,
  created_at: r.created_at,
  superseded_by: r.superseded_by == null ? null : Number(r.superseded_by),
})

// Add a temporal fact. Auto-supersedes a prior CURRENT fact with the same
// (subject, predicate) in the same project whose object differs. Reaffirms (no
// duplicate row) when an identical current fact already exists.
export function addFact(db, f) {
  const {
    statement,
    subject = null,
    predicate = null,
    object = null,
    project = 'global',
    sourceEpisode = null,
    source = 'chat',
    validFrom,
    createdAt,
    supersedes = null,
  } = f
  if (!statement || !String(statement).trim()) return null
  const t = createdAt
  const vf = validFrom ?? createdAt

  // Atomic read-modify-write. BEGIN IMMEDIATE takes the write lock at READ time, so two writers on
  // the shared DB (council + the main agent) can't both pass the dup-check and create TWO "current"
  // facts for one subject/predicate — the temporal-invariant corruption. Also makes the insert +
  // invalidate all-or-nothing (a throw between them can't leave both the old and new fact current).
  db.exec('BEGIN IMMEDIATE')
  try {
    // de-dup: identical current fact already present → reaffirm, don't double-store
    const dup =
      subject && predicate
        ? db
            .prepare(
              'SELECT id FROM facts WHERE subject = ? AND predicate = ? AND object IS ? AND project = ? AND valid_to IS NULL',
            )
            .get(subject, predicate, object, project)
        : db
            .prepare('SELECT id FROM facts WHERE statement = ? AND project = ? AND valid_to IS NULL')
            .get(statement, project)
    if (dup) {
      db.exec('COMMIT')
      return { id: Number(dup.id), superseded: [], duplicate: true }
    }

    // which current facts does this one invalidate?
    let toInvalidate = []
    if (supersedes) {
      toInvalidate = db.prepare('SELECT id FROM facts WHERE id = ? AND valid_to IS NULL').all(supersedes)
    } else if (subject && predicate) {
      toInvalidate = db
        .prepare(
          'SELECT id, object FROM facts WHERE subject = ? AND predicate = ? AND project = ? AND valid_to IS NULL',
        )
        .all(subject, predicate, project)
        .filter((r) => (r.object || '') !== (object || ''))
    }

    const r = db
      .prepare(
        `INSERT INTO facts(statement, source, subject, predicate, object, project, source_episode, valid_from, valid_to, created_at, superseded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(statement, source, subject, predicate, object, project, sourceEpisode, vf, t)
    const id = Number(r.lastInsertRowid)
    if (ftsCapable.get(db)) db.prepare('INSERT INTO facts_fts(rowid, statement) VALUES (?, ?)').run(id, statement)

    for (const old of toInvalidate) {
      db.prepare('UPDATE facts SET valid_to = ?, superseded_by = ? WHERE id = ?').run(t, id, Number(old.id))
    }
    db.exec('COMMIT')
    return { id, superseded: toInvalidate.map((o) => Number(o.id)), duplicate: false }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch {}
    throw e
  }
}

// Extract distinct lowercase search terms from free text.
function termsOf(query) {
  const terms = String(query || '').match(/[A-Za-z0-9][A-Za-z0-9._-]{1,}/g) || []
  return [...new Set(terms.map((t) => t.toLowerCase()))]
}

// Keyword recall: FTS5 ranked match when available, else a LIKE scan scored by how
// many query terms each statement contains. Current facts only by default; scoped
// to a project if given (null = the whole shared brain).
export function recall(db, { query, project = null, limit = 8, includeSuperseded = false }) {
  const terms = termsOf(query)
  if (!terms.length) return []
  const opts = { project, limit, includeSuperseded }
  return ftsCapable.get(db) ? recallFts(db, terms, opts) : recallLike(db, terms, opts)
}

function recallFts(db, terms, { project, limit, includeSuperseded }) {
  const matchExpr = terms
    .flatMap((t) => String(t).split(/[^\p{L}\p{N}_]+/u)) // split hyphenated/punctuated terms into FTS5-safe sub-tokens
    .filter((t) => t.length)
    .map((t) => `${t}*`) // prefix match so "config" finds "configuration"
    .join(' OR ')
  if (!matchExpr) return []
  const where = [project ? 'f.project = ?' : null, includeSuperseded ? null : 'f.valid_to IS NULL']
    .filter(Boolean)
    .join(' AND ')
  const sql = `
    SELECT f.*, bm25(facts_fts) AS score
    FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid
    WHERE facts_fts MATCH ?${where ? ` AND ${where}` : ''}
    ORDER BY score
    LIMIT ?`
  const args = project ? [matchExpr, project, limit] : [matchExpr, limit]
  return db.prepare(sql).all(...args).map(mapFact)
}

function recallLike(db, terms, { project, limit, includeSuperseded }) {
  const where = [project ? 'project = ?' : null, includeSuperseded ? null : 'valid_to IS NULL']
    .filter(Boolean)
    .join(' AND ')
  const rows = db.prepare(`SELECT * FROM facts${where ? ` WHERE ${where}` : ''}`).all(...(project ? [project] : []))
  return rows
    .map((r) => ({ r, score: terms.reduce((n, t) => n + ((r.statement || '').toLowerCase().includes(t) ? 1 : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.r.created_at - a.r.created_at)
    .slice(0, limit)
    .map((x) => mapFact(x.r))
}

// Graph traversal: facts touching any of the named entities (subject or object).
export function factsAbout(db, names, { project = null, limit = 12, includeSuperseded = false } = {}) {
  if (!names || !names.length) return []
  const ph = names.map(() => '?').join(',')
  const where = [project ? 'project = ?' : null, includeSuperseded ? null : 'valid_to IS NULL']
    .filter(Boolean)
    .join(' AND ')
  const sql = `
    SELECT * FROM facts
    WHERE (subject IN (${ph}) OR object IN (${ph}))${where ? ` AND ${where}` : ''}
    ORDER BY created_at DESC
    LIMIT ?`
  const args = project ? [...names, ...names, project, limit] : [...names, ...names, limit]
  return db.prepare(sql).all(...args).map(mapFact)
}

export function stats(db) {
  const c = (sql) => Number(db.prepare(sql).get().c)
  return {
    episodes: c('SELECT count(*) c FROM episodes'),
    entities: c('SELECT count(*) c FROM entities'),
    facts: c('SELECT count(*) c FROM facts'),
    currentFacts: c('SELECT count(*) c FROM facts WHERE valid_to IS NULL'),
    supersededFacts: c('SELECT count(*) c FROM facts WHERE valid_to IS NOT NULL'),
  }
}
