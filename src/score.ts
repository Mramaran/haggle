// The scorecard. Worked out by code from the turn log, so every point can be traced to a line
// the player wrote. No model is involved in scoring.

import type { Intent } from './game'

export interface ScoredTurn {
  player: string
  intent: Intent
  amount: number | null
  /** The player's price before this turn. */
  priceBefore: number
}

export interface GameResult {
  personaName: string
  ask: number
  /** The client's first offer and the most they would ever pay. */
  opening: number
  ceiling: number
  status: 'open' | 'deal' | 'walked'
  dealPrice: number | null
  lastOffer: number
  turns: readonly ScoredTurn[]
}

export interface Moment {
  turn: number
  quote: string
  note: string
  good: boolean
}

export type Outcome = 'deal' | 'walked' | 'timeout'

export interface Scorecard {
  personaName: string
  ask: number
  outcome: Outcome
  /** The deal price, or the last offer on the table when there was no deal. */
  price: number
  ceiling: number
  score: number
  grade: string
  headline: string
  /** The line where the player first gave ground for nothing, if they did. */
  worst: Moment | null
  moments: Moment[]
  concessions: number
  givenAway: number
  leftOnTable: number
}

const MONEY_POINTS_DEAL = 60
const MONEY_POINTS_NO_DEAL = 40
const DISCIPLINE_POINTS = 40
const POINTS_PER_CONCESSION = 12

const money = (amount: number) => `$${amount.toLocaleString('en-US')}`

function grade(score: number): string {
  if (score >= 85) return 'Held the line'
  if (score >= 65) return 'Solid'
  if (score >= 40) return 'Gave ground'
  return 'Rolled over'
}

export function scoreGame(result: GameResult): Scorecard {
  const moments: Moment[] = []
  let concessions = 0
  let givenAway = 0
  let worst: Moment | null = null

  for (const [index, turn] of result.turns.entries()) {
    const base = { turn: index + 1, quote: turn.player }
    const lowered = turn.amount !== null && turn.amount < turn.priceBefore ? turn.priceBefore - turn.amount : 0
    switch (turn.intent) {
      case 'DISCOUNT': {
        concessions++
        givenAway += lowered
        const note = lowered > 0 ? `Dropped your price by ${money(lowered)} and asked for nothing back.` : 'Gave something away for free.'
        const moment = { ...base, note, good: false }
        worst ??= moment
        moments.push(moment)
        break
      }
      case 'CONDITION':
        moments.push({ ...base, note: lowered > 0 ? 'Lowered your price, but asked for something in return.' : 'Asked for something in return.', good: true })
        break
      case 'HOLD':
        moments.push({ ...base, note: 'Held your price.', good: true })
        break
      case 'WALK':
        moments.push({ ...base, note: 'Showed you were ready to leave.', good: true })
        break
      case 'ACCEPT':
        moments.push({ ...base, note: 'Accepted the offer.', good: result.lastOffer >= result.ceiling })
        break
      default:
        break
    }
  }

  const outcome: Outcome = result.status === 'deal' ? 'deal' : result.status === 'walked' ? 'walked' : 'timeout'
  const price = result.status === 'deal' && result.dealPrice !== null ? result.dealPrice : result.lastOffer
  const room = Math.max(1, result.ceiling - result.opening)
  const reach = Math.min(1, Math.max(0, (price - result.opening) / room))
  const moneyPoints = Math.round((outcome === 'deal' ? MONEY_POINTS_DEAL : MONEY_POINTS_NO_DEAL) * reach)
  const discipline = Math.max(0, DISCIPLINE_POINTS - POINTS_PER_CONCESSION * concessions)
  const score = moneyPoints + discipline
  const leftOnTable = outcome === 'deal' ? Math.max(0, result.ceiling - price) : 0

  let headline: string
  if (worst) headline = `Turn ${worst.turn}: ${worst.note}`
  else if (leftOnTable > 0) headline = `You never gave ground for nothing, but you accepted with ${money(leftOnTable)} still on the table.`
  else headline = 'You never gave ground for nothing.'

  return {
    personaName: result.personaName,
    ask: result.ask,
    outcome,
    price,
    ceiling: result.ceiling,
    score,
    grade: grade(score),
    headline,
    worst,
    moments,
    concessions,
    givenAway,
    leftOnTable,
  }
}

/** What travels in a share link. Small on purpose: the link holds everything, no server does. */
export interface SharedCard {
  personaName: string
  ask: number
  outcome: Outcome
  price: number
  ceiling: number
  score: number
  quote: string | null
  turn: number | null
  givenAway: number
  concessions: number
}

const QUOTE_LIMIT = 240

export function toShared(card: Scorecard): SharedCard {
  return {
    personaName: card.personaName,
    ask: card.ask,
    outcome: card.outcome,
    price: card.price,
    ceiling: card.ceiling,
    score: card.score,
    quote: card.worst ? card.worst.quote.slice(0, QUOTE_LIMIT) : null,
    turn: card.worst ? card.worst.turn : null,
    givenAway: card.givenAway,
    concessions: card.concessions,
  }
}

export function gradeFor(score: number): string {
  return grade(score)
}

export function encodeCard(card: SharedCard): string {
  const compact = {
    v: 1,
    p: card.personaName,
    a: card.ask,
    o: card.outcome,
    pr: card.price,
    c: card.ceiling,
    s: card.score,
    q: card.quote,
    t: card.turn,
    g: card.givenAway,
    n: card.concessions,
  }
  const bytes = new TextEncoder().encode(JSON.stringify(compact))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1e7

/** Reads a card from a link. The text comes from whoever made the link, so every field is checked. */
export function decodeCard(encoded: string): SharedCard | null {
  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))
    const json = new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
    const raw = JSON.parse(json) as Record<string, unknown>
    const outcomes: readonly unknown[] = ['deal', 'walked', 'timeout']
    if (raw.v !== 1 || typeof raw.p !== 'string' || !outcomes.includes(raw.o)) return null
    if (![raw.a, raw.pr, raw.c, raw.s, raw.g, raw.n].every(isCount)) return null
    if (raw.q !== null && typeof raw.q !== 'string') return null
    return {
      personaName: raw.p.slice(0, 40),
      ask: raw.a as number,
      outcome: raw.o as Outcome,
      price: raw.pr as number,
      ceiling: raw.c as number,
      score: Math.min(100, raw.s as number),
      quote: typeof raw.q === 'string' ? raw.q.slice(0, QUOTE_LIMIT) : null,
      turn: isCount(raw.t) ? raw.t : null,
      givenAway: raw.g as number,
      concessions: raw.n as number,
    }
  } catch {
    return null
  }
}
