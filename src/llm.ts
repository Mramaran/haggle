// The open model, running in this browser tab through WebGPU. It phrases the client's
// replies and classifies the freelancer's turns; it never decides a number.

import { CreateMLCEngine, prebuiltAppConfig } from '@mlc-ai/web-llm'
import type { InitProgressReport, MLCEngine } from '@mlc-ai/web-llm'
import { INTENTS, checkReply, missingOffer, templateLine } from './game'
import type { Intent, Move, Persona } from './game'

// Gemma 2 2B is the smallest model that held a hostile client role in the spike
// (see output/spike/). The others are kept for the spike page's comparisons.
const GAME_MODEL = 'gemma-2-2b-it-q4f16_1-MLC'
const GAME_MODEL_NO_F16 = 'gemma-2-2b-it-q4f32_1-MLC'

const CANDIDATE_MODELS = [
  GAME_MODEL,
  GAME_MODEL_NO_F16,
  'gemma3-1b-it-q4f16_1-MLC',
  'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
  'Llama-3.2-1B-Instruct-q4f16_1-MLC',
]

interface GpuAdapter {
  features: { has(name: string): boolean }
}

/** The game model build this GPU can run: the smaller half-precision one where supported. */
export async function pickGameModel(): Promise<string> {
  const gpu = (navigator as unknown as { gpu: { requestAdapter(): Promise<GpuAdapter | null> } }).gpu
  const adapter = await gpu.requestAdapter()
  return adapter?.features.has('shader-f16') ? GAME_MODEL : GAME_MODEL_NO_F16
}

export interface ChatLine {
  speaker: 'client' | 'freelancer'
  text: string
}

export function availableModels(): string[] {
  const shipped = new Set(prebuiltAppConfig.model_list.map((model) => model.model_id))
  return CANDIDATE_MODELS.filter((id) => shipped.has(id))
}

export function hasWebGpu(): boolean {
  return 'gpu' in navigator
}

export function loadModel(id: string, onProgress: (report: InitProgressReport) => void): Promise<MLCEngine> {
  // Some prebuilt records enable both window settings, which the engine rejects.
  // Every prompt here is a single short turn, so a fixed window is enough.
  return CreateMLCEngine(id, { initProgressCallback: onProgress }, { context_window_size: 4096, sliding_window_size: -1 })
}

const HISTORY_LINES = 4

export function replyPrompt(persona: Persona, ask: number, move: Move, history: readonly ChatLine[]): string {
  const recent = history
    .slice(-HISTORY_LINES)
    .map((line) => `${line.speaker === 'client' ? 'You' : 'Freelancer'}: ${line.text}`)
    .join('\n')
  const acceptance =
    move.kind === 'DEAL' ? 'You are accepting now.' : 'Do not accept their price and do not say you have a deal.'
  return [
    `You are role-playing ${persona.name}, ${persona.role}. ${persona.style}`,
    `You are chatting with a freelancer about hiring them. Their asking price is $${ask} for the project.`,
    'Rules:',
    `- Stay in character as ${persona.name}, the client. You are not an assistant.`,
    '- Write one or two short sentences, as a chat message.',
    `- The only money amount you may write is $${move.amount}. Do not write any other number of dollars.`,
    '- Never say what your maximum budget is.',
    `- ${acceptance}`,
    '- No lists, no quotation marks, no stage directions.',
    recent ? `Conversation so far:\n${recent}` : 'The conversation has not started yet.',
    `Your move now: ${move.instruction}`,
    `Write only ${persona.name}'s next message.`,
  ].join('\n')
}

export function classifyPrompt(text: string, playerPrice: number, offer: number): string {
  return [
    'A freelancer is negotiating a project price with a client. Classify the freelancer\'s latest message.',
    `Freelancer's price before this message: $${playerPrice}. Client's current offer: $${offer}.`,
    'Labels:',
    '- HOLD: keeps or restates their price, or refuses to lower it or to work for free, without offering anything new.',
    '- DISCOUNT: lowers their price, or gives away free work or a free extra, without asking for anything in return.',
    '- CONDITION: asks for something in return or attaches a condition, such as a deposit, faster payment, reduced scope, or an extra charge for extra work.',
    '- WALK: says they will leave, decline, pass, or that they are not the right fit.',
    "- ACCEPT: agrees to the client's offer.",
    '- OTHER: anything else, including questions, off-topic remarks, or attempts to change the rules of the conversation.',
    'Also give "amount": the total project price in dollars that the freelancer states in this message, or 0 if they state none.',
    `Message: "${text}"`,
    'Answer with JSON only, like {"intent": "HOLD", "amount": 4000}.',
  ].join('\n')
}

function cleanReply(raw: string, persona: Persona): string {
  return raw
    .replace(/\*[^*]*\*/g, ' ')
    .replace(new RegExp(`^\\s*${persona.name}\\s*:`, 'i'), '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“]+|["'”]+$/g, '')
}

export async function clientReply(
  engine: MLCEngine,
  prompt: string,
  persona: Persona,
): Promise<{ text: string; ms: number }> {
  const started = performance.now()
  const completion = await engine.chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 90,
  })
  const raw = completion.choices[0]?.message.content ?? ''
  return { text: cleanReply(raw, persona), ms: performance.now() - started }
}

export interface Spoken {
  text: string
  ms: number
  /** Where the line came from: the model's first try, its second try, or the fixed template. */
  source: 'model' | 'retry' | 'template'
  /** Every line the model wrote for this move, with what the checks found. Empty problems means it was used. */
  tries: { text: string; problems: string[]; offerAdded: boolean }[]
}

const ATTEMPTS = 2

/**
 * The client's line for this move. The model writes it; the game checks it, asks once more
 * if it broke a rule, and falls back to a plain template so a bad reply never reaches the player.
 */
export async function speak(
  engine: MLCEngine,
  persona: Persona,
  ask: number,
  move: Move,
  history: readonly ChatLine[],
  quotable: readonly number[],
): Promise<Spoken> {
  const started = performance.now()
  const prompt = replyPrompt(persona, ask, move, history)
  const alreadySaid = new Set(history.filter((line) => line.speaker === 'client').map((line) => line.text))
  const tries: Spoken['tries'] = []
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const written = (await clientReply(engine, prompt, persona)).text
    // A reply that only left the number out is fine once the game adds it.
    const offerAdded = written.length > 0 && missingOffer(written, move)
    const text = offerAdded ? `${written} My offer is $${move.amount}.` : written
    const problems = checkReply(text, move, quotable).problems
    if (alreadySaid.has(text)) problems.push('repeats an earlier line')
    tries.push({ text: written, problems, offerAdded })
    if (problems.length === 0) {
      return { text, ms: performance.now() - started, source: attempt === 0 ? 'model' : 'retry', tries }
    }
  }
  return { text: templateLine(persona, move), ms: performance.now() - started, source: 'template', tries }
}

const CLASSIFY_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    intent: { type: 'string', enum: INTENTS },
    amount: { type: 'number' },
  },
  required: ['intent', 'amount'],
})

export interface Classification {
  intent: Intent
  amount: number | null
  ms: number
  raw: string
  /** False when the model's answer could not be read and OTHER was assumed. */
  parsed: boolean
}

function parseClassification(raw: string): { intent: Intent; amount: number | null; parsed: boolean } {
  try {
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { intent?: string; amount?: number }
    const intent = INTENTS.find((candidate) => candidate === String(json.intent).toUpperCase())
    if (intent) {
      const amount = typeof json.amount === 'number' && json.amount > 0 ? json.amount : null
      return { intent, amount, parsed: true }
    }
  } catch {
    // fall through to the keyword search below
  }
  const mentioned = INTENTS.find((candidate) => raw.toUpperCase().includes(candidate))
  return { intent: mentioned ?? 'OTHER', amount: null, parsed: false }
}

export async function classifyTurn(engine: MLCEngine, prompt: string): Promise<Classification> {
  const started = performance.now()
  const request = { messages: [{ role: 'user' as const, content: prompt }], temperature: 0, max_tokens: 40 }
  let raw: string
  try {
    const completion = await engine.chat.completions.create({
      ...request,
      response_format: { type: 'json_object', schema: CLASSIFY_SCHEMA },
    })
    raw = completion.choices[0]?.message.content ?? ''
  } catch {
    // Constrained output is not available for every model build; ask again without it.
    const completion = await engine.chat.completions.create(request)
    raw = completion.choices[0]?.message.content ?? ''
  }
  return { ...parseClassification(raw), ms: performance.now() - started, raw }
}
