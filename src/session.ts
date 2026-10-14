// One negotiation from opening line to ending. Shared by the game and the test page so
// both run exactly the same steps: the model labels the turn, code rules settle the clear
// cases, the game picks the client's move, and the model phrases it.

import type { MLCEngine } from '@mlc-ai/web-llm'
import { extractAmounts, newGame, nextMove, openingMove, resolveIntent, ruleIntent, templateLine } from './game'
import type { GameState, Intent, Move, Persona } from './game'
import { classifyPrompt, classifyTurn, speak } from './llm'
import type { ChatLine, Spoken } from './llm'

export const MAX_TURNS = 8

/** One exchange, kept for the scorecard and for seeing what the model did on its own. */
export interface TurnRecord {
  player: string
  /** The model's own label for the player's line, before any code rule. */
  classified: Intent
  classifiedRaw: string
  /** The label the game acted on. Differs from `classified` when a code rule overrode the model. */
  intent: Intent
  amount: number | null
  /** The player's own price before this turn, so the scorecard can see how far they dropped. */
  priceBefore: number
  offerBefore: number
  move: Move
  reply: string
  source: Spoken['source']
  tries: Spoken['tries']
}

/** What reads the player's lines and writes the client's: the open model, or rules and fixed lines. */
export interface Brain {
  kind: 'model' | 'scripted'
  read(text: string, state: GameState): Promise<{ classified: Intent; raw: string; intent: Intent; amount: number | null }>
  reply(persona: Persona, ask: number, move: Move, history: readonly ChatLine[], quotable: readonly number[]): Promise<Spoken>
}

/** The real game: the model labels each turn and phrases each reply, with code rules on top. */
export function modelBrain(engine: MLCEngine): Brain {
  return {
    kind: 'model',
    async read(text, state) {
      const classification = await classifyTurn(engine, classifyPrompt(text, state.playerPrice, state.offer))
      return { classified: classification.intent, raw: classification.raw, ...resolveIntent(classification.intent, text, state) }
    },
    reply: (persona, ask, move, history, quotable) => speak(engine, persona, ask, move, history, quotable),
  }
}

/**
 * No model at all: word cues read the turn and fixed lines answer it. Used where the browser
 * cannot run the model, and as the baseline the model is compared against.
 */
export function scriptedBrain(): Brain {
  let lineCount = 0
  return {
    kind: 'scripted',
    async read(text, state) {
      const reading = ruleIntent(text, state)
      return { classified: reading.intent, raw: '(rules only)', ...reading }
    },
    async reply(persona, _ask, move) {
      return { text: templateLine(persona, move, lineCount++), ms: 0, source: 'template', tries: [] }
    },
  }
}

export interface Session {
  brain: Brain
  persona: Persona
  state: GameState
  history: ChatLine[]
  quotable: number[]
  opening: Spoken | null
  records: TurnRecord[]
}

export function newSession(brain: Brain, persona: Persona, ask: number): Session {
  return { brain, persona, state: newGame(ask, persona), history: [], quotable: [ask], opening: null, records: [] }
}

export function openerLine(ask: number): string {
  return `My price for this project is $${ask.toLocaleString('en-US')}.`
}

async function clientSays(session: Session, move: Move): Promise<Spoken> {
  const spoken = await session.brain.reply(session.persona, session.state.ask, move, session.history, session.quotable)
  session.history.push({ speaker: 'client', text: spoken.text })
  return spoken
}

/** The freelancer states their price and the client opens. */
export async function openGame(session: Session): Promise<Spoken> {
  session.history.push({ speaker: 'freelancer', text: openerLine(session.state.ask) })
  session.opening = await clientSays(session, openingMove(session.state, session.persona))
  return session.opening
}

export async function playTurn(session: Session, text: string): Promise<TurnRecord> {
  const { state } = session
  const { classified, raw, intent, amount } = await session.brain.read(text, state)
  session.history.push({ speaker: 'freelancer', text })
  session.quotable.push(...extractAmounts(text))
  const next = nextMove(state, intent, amount, session.persona)
  session.state = next.state
  const spoken = await clientSays(session, next.move)
  const record: TurnRecord = {
    player: text,
    classified,
    classifiedRaw: raw,
    intent,
    amount,
    priceBefore: state.playerPrice,
    offerBefore: state.offer,
    move: next.move,
    reply: spoken.text,
    source: spoken.source,
    tries: spoken.tries,
  }
  session.records.push(record)
  return record
}

export function isOver(session: Session): boolean {
  return session.state.status !== 'open' || session.state.turn >= MAX_TURNS
}
