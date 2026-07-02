export const VAULT_TO_ENV = {
  ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY',
  OPENAI_API: 'OPENAI_API_KEY',
  DEEPSEEK_API: 'DEEPSEEK_API_KEY',
  ZAI_API_KEY: 'ZAI_API_KEY',
  KIMI_API_KEY: 'MOONSHOT_API_KEY',
  GEMINI_API_KEY: 'GOOGLE_GENERATIVE_AI_API_KEY',
}

function envNameFor(name) {
  return VAULT_TO_ENV[name] || name
}

export function get(name) {
  return process.env[envNameFor(name)] || ''
}

export function list() {
  const names = new Set()
  for (const [vaultName, envName] of Object.entries(VAULT_TO_ENV)) {
    if (process.env[envName]) names.add(vaultName)
  }
  return Array.from(names).sort()
}
