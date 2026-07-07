// setup/index.js — the bounded toolset for Omega Setup mode (the `setup` primary agent).
// Exports ONLY its default plugin function (opencode loads every export of a plugin file as a plugin).
// Runs on Bun. All mutating tools tag metadata.omegaSetup.needsRestart so the sidecar reloads the engine
// between turns; setup_finish tags finished so the sidecar hands back to normal Omega.
import { tool } from '@opencode-ai/plugin'
import * as L from './lib.mjs'

const z = tool.schema
const RESTART = { omegaSetup: { needsRestart: true } }

const SetupPlugin = async ({ client, directory }) => {
  try { const m = L.migrateJsoncStub(); if (m && m.migrated) console.log('[setup] retired stub opencode.jsonc so config writes land in opencode.json') } catch {}

  return {
    tool: {
      setup_list_models: tool({
        description: 'Show the configured providers and models, which have a working key, and the current default. Call this first.',
        args: {},
        execute: async () => {
          const cfg = (() => { try { return L.readConfig() } catch { return {} } })()
          const live = await L.providersLive(client)
          const keys = new Set(await L.vaultList())
          const lines = []
          const provs = cfg.provider || {}
          const enabled = cfg.enabled_providers || Object.keys(provs)
          for (const pid of enabled) {
            const p = provs[pid] || {}
            const models = Object.keys(p.models || {})
            const url = (p.options && p.options.baseURL) || ''
            const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|10\.|169\.254|192\.168)/.test(url)
            let keyName = L.PROVIDER_KEY[pid] || null
            if (p.options && p.options.apiKey) { const ref = String(p.options.apiKey); const found = Object.keys(L.VAULT_TO_ENV).find((k) => ref.includes(k)); if (found) keyName = found }
            const keyStatus = isLocal ? 'local (no key)' : keyName ? (keys.has(keyName) ? 'key ✓' : 'key missing') : 'n/a'
            lines.push(`• ${pid}${url ? ' @ ' + url : ''} — ${models.length ? models.join(', ') : '(no models)'}  [${keyStatus}]`)
          }
          const def = cfg.model || '(none)'
          return { title: 'Configured models', output: `Default model: ${def}\n\n${lines.join('\n') || '(no providers configured yet)'}\n\nVault keys present: ${[...keys].join(', ') || 'none'}${live ? '' : '\n(live provider list unavailable — showing config file)'}` }
        },
      }),

      setup_add_model: tool({
        description: 'Add a local server or a cloud provider+model to the config. Writes opencode.json safely (keys are only stored as {env:...} refs, never inline). Applies after the automatic reload.',
        args: {
          kind: z.enum(['local', 'cloud']).describe('local server (llama.cpp/Ollama/LM Studio) or a cloud provider'),
          provider_id: z.string().describe('short id, e.g. gmk128, anthropic, groq'),
          model_id: z.string().describe('the model id the server/provider exposes'),
          model_name: z.string().optional().describe('friendly display name'),
          base_url: z.string().optional().describe('local/custom base URL, e.g. http://127.0.0.1:8080/v1'),
          context: z.number().int().optional().describe('context window (local)'),
          output: z.number().int().optional().describe('max output tokens (local)'),
          reasoning: z.boolean().optional().describe('is this a reasoning model'),
          api_key_env: z.string().optional().describe('vault/env name for a cloud key (default <PROVIDER>_API_KEY)'),
          set_default: z.boolean().optional().describe('make this the default model'),
          force: z.boolean().optional().describe('write even if a local endpoint is unreachable'),
        },
        execute: async (a) => {
          try {
            const cfg = L.readConfig()
            const provs = cfg.provider || {}
            const modelEntry = { name: a.model_name || a.model_id }
            if (a.context || a.output) modelEntry.limit = { context: a.context || 32768, output: a.output || 8192 }
            if (a.reasoning) { modelEntry.reasoning = true; modelEntry.options = { ...(modelEntry.options || {}), reasoning: true } }
            let providerPatch
            if (a.kind === 'local') {
              if (!a.base_url) return 'A local model needs a base_url (e.g. http://127.0.0.1:8080/v1).'
              if (!a.force) { const ping = await L.pingProvider({ kind: 'openai', baseURL: a.base_url }); if (!ping.ok) return `Couldn't reach ${a.base_url} (${ping.why}). Start the server, or call again with force:true to add it anyway.` }
              providerPatch = { npm: '@ai-sdk/openai-compatible', name: a.model_name || a.provider_id, options: { baseURL: a.base_url, apiKey: 'local-noauth' }, models: { [a.model_id]: modelEntry } }
            } else {
              const env = a.api_key_env || (a.provider_id.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY')
              const keys = new Set(await L.vaultList())
              const keyNote = keys.has(env) ? '' : `\nNote: no vault key named ${env} yet — run setup_set_key(name:"${env}") next, or the model won't authenticate.`
              providerPatch = { name: a.model_name || a.provider_id, options: { apiKey: `{env:${env}}` }, models: { [a.model_id]: modelEntry } }
              providerPatch.__keyNote = keyNote
            }
            const keyNote = providerPatch.__keyNote || ''; delete providerPatch.__keyNote
            const existing = provs[a.provider_id] || {}
            const merged = { ...existing, ...providerPatch, options: { ...(existing.options || {}), ...providerPatch.options }, models: { ...(existing.models || {}), ...providerPatch.models } }
            // a whitelisted provider drops any model NOT in its whitelist at load — extend it so the new one shows
            if (Array.isArray(existing.whitelist)) merged.whitelist = Array.from(new Set([...existing.whitelist, a.model_id]))
            const patch = { provider: { [a.provider_id]: merged } }
            // only touch enabled_providers if it's ALREADY explicit (absent = all enabled; writing one silently disables the rest)
            if (Array.isArray(cfg.enabled_providers) && !cfg.enabled_providers.includes(a.provider_id)) patch.enabled_providers = [...cfg.enabled_providers, a.provider_id]
            if (a.set_default) patch.model = `${a.provider_id}/${a.model_id}`
            const w = await L.patchConfig(client, patch)
            return { title: 'Model added', output: `Added ${a.provider_id}/${a.model_id}${a.set_default ? ' (now the default)' : ''}. Goes live after a quick automatic reload.${keyNote} [written via ${w.via}]`, metadata: RESTART }
          } catch (e) { return `Could not add the model: ${e.message}` }
        },
      }),

      setup_set_key: tool({
        description: 'Store an API key in the encrypted local vault. NEVER echo or restate the key value. Applies after the automatic reload.',
        args: {
          name: z.string().describe('canonical vault key name, e.g. ANTHROPIC_API_KEY'),
          value: z.string().describe('the API key (stored to the vault; never shown back)'),
          validate: z.boolean().optional().describe('test the key against the provider first (default true)'),
        },
        execute: async (a) => {
          if (!/^[A-Z0-9_]{3,64}$/.test(a.name || '')) return 'Key name must be UPPER_SNAKE, 3-64 chars (e.g. ANTHROPIC_API_KEY).'
          if (!/_API_KEY$/.test(a.name)) return 'Key names must end in _API_KEY (e.g. ANTHROPIC_API_KEY, GROQ_API_KEY) — otherwise the engine cannot load it. Please use a name ending in _API_KEY.'
          const val = L.sanitizeSecret(a.value)
          if (!val) return 'No key value provided.'
          let verdict = ''
          if (a.validate !== false) {
            const v = await L.validateKey(a.name, val)
            if (v.known && v.ok === false && !v.soft) return `That key was rejected by the provider (${v.why}) — not stored. Double-check and try again.`
            verdict = !v.known ? ' — stored (unrecognized provider — not validated)' : v.ok ? ' — validated ✓' : ` — stored, but couldn't validate (${v.why})`
          }
          const r = await L.vaultSet(a.name, val)
          if (!r.ok) return `Failed to store the key: ${r.err || r.out}`
          return { title: 'Key stored', output: `${a.name} stored to the vault ✓${verdict}. It reaches the model after a quick automatic reload.`, metadata: RESTART }
        },
      }),

      setup_test_model: tool({
        description: 'Send a REAL test prompt through a model via the engine and report whether it answered. Proof a model is actually working.',
        args: { provider_id: z.string(), model_id: z.string(), timeout_s: z.number().int().optional() },
        execute: async (a) => {
          const r = await L.testModelViaEngine(client, directory, a.provider_id, a.model_id, Math.min(Math.max(a.timeout_s || 90, 5), 300))
          if (r.ok) return { title: 'Model test PASS', output: `${a.provider_id}/${a.model_id} answered in ${Math.round(r.ms / 100) / 10}s: "${r.text}"` }
          const hint = /reachable|not reachable/.test(r.error || '') ? ' (is the server running? if you just added it, the reload may not have finished — ask me to test again)' : ''
          return { title: 'Model test FAIL', output: `${a.provider_id}/${a.model_id} did not answer: ${r.error}${hint}` }
        },
      }),

      setup_run_doctor: tool({
        description: 'Run the full Agent Omega health check (config, plugins, skills, providers, dependencies, endpoints). Read-only.',
        args: {},
        execute: async () => {
          const r = await L.runDoctor()
          const verdict = /FAIL/i.test(r.out) ? 'Some checks FAILED — see above.' : /WARN/i.test(r.out) ? 'Healthy with a few warnings.' : 'All checks passed.'
          return { title: 'Doctor', output: `${r.out}\n\n${verdict}` }
        },
      }),

      setup_list_skills: tool({
        description: 'List the installed skills (procedures the agent can invoke).',
        args: {},
        execute: async () => {
          const s = L.listSkillsOnDisk()
          return { title: 'Skills', output: s.length ? s.map((x) => `• ${x.name} — ${x.description}`).join('\n') : 'No skills installed.' }
        },
      }),

      setup_add_skill: tool({
        description: 'Create a new skill. FIRST load the skill-creator skill (via the skill tool) to follow the authoring rules, then call this with the name, description and body.',
        args: {
          name: z.string().describe('kebab-case, a-z 0-9 -'),
          description: z.string().describe('one-line trigger: when this skill applies'),
          body: z.string().describe('the skill markdown body'),
          command_md: z.string().optional().describe('optional companion /command markdown'),
          overwrite: z.boolean().optional(),
        },
        execute: async (a) => {
          try {
            if (!L.skillNameOk(a.name)) return 'Skill name must be kebab-case (a-z 0-9 -), 2-41 chars.'
            if (!a.overwrite && L.listSkillsOnDisk().some((s) => s.name === a.name)) return `A skill named "${a.name}" already exists. Pass overwrite:true to replace it.`
            const paths = L.writeSkill(a.name, a.description, a.body, a.command_md)
            return { title: 'Skill created', output: `Created:\n${paths.join('\n')}\nIt becomes available after a quick automatic reload.`, metadata: RESTART }
          } catch (e) { return `Could not create the skill: ${e.message}` }
        },
      }),

      setup_set_effort: tool({
        description: 'Set the default reasoning-effort (variant) for an agent+model. Narrow by design: applies when a session uses that agent on that exact model.',
        args: { agent_name: z.string().optional(), model: z.string().describe('provider/model'), effort: z.string().describe('variant/effort name') },
        execute: async (a) => {
          try {
            const agent = a.agent_name || 'build'
            const patch = { agent: { [agent]: { model: a.model, variant: a.effort } } }
            const w = await L.patchConfig(client, patch)
            return { title: 'Effort set', output: `Default effort for agent "${agent}" on ${a.model} set to "${a.effort}". Applies to new sessions after a quick reload; the in-app effort picker still controls the current session. [via ${w.via}]`, metadata: RESTART }
          } catch (e) { return `Could not set effort: ${e.message}` }
        },
      }),

      setup_finish: tool({
        description: 'End setup and hand control back to normal Omega. Call after summarizing what changed and getting a clear yes.',
        args: { summary: z.string().optional() },
        execute: async (a) => {
          return { title: 'Setup complete', output: `${a.summary ? a.summary + '\n\n' : ''}Setup finished. Your next message is answered by normal Omega — on whatever model you pick.`, metadata: { omegaSetup: { finished: true } } }
        },
      }),
    },
  }
}

export default SetupPlugin
