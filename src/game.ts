// Game rules. The client's numbers live here, never in the model.

export type Intent = 'HOLD' | 'DISCOUNT' | 'CONDITION' | 'WALK' | 'ACCEPT' | 'OTHER'

export const INTENTS: readonly Intent[] = ['HOLD', 'DISCOUNT', 'CONDITION', 'WALK', 'ACCEPT', 'OTHER']

export type MoveKind = 'OPEN' | 'RAISE' | 'GRUDGING_RAISE' | 'PRESS' | 'REPEAT' | 'FINAL' | 'DEAL' | 'LET_GO'

export interface Persona {
  id: string
  name: string
  role: string
  style: string
  /** What this client keeps pushing for when they are not moving on price. */
  pressure: string
  /** The same pressure as a line the client could say, used when the model's reply is unusable. */
  pressureLine: string
  openFraction: number
  ceilingFraction: number
}

export interface GameState {
  ask: number
  playerPrice: number
  offer: number
  ceiling: number
  step: number
  turn: number
  status: 'open' | 'deal' | 'walked'
  dealPrice: number | null
}

export interface Move {
  kind: MoveKind
  /** The only money amount the client may mention this turn. */
  amount: number
  instruction: string
}

export const PERSONAS: readonly Persona[] = [
  {
    id: 'lowballer',
    name: 'Marcus',
    role: 'the founder of a seed-stage startup who wants a landing page redesigned',
    style: 'Friendly but relentless about money. Talks about runway and exposure.',
    pressure: 'say the budget is tight and ask for a free trial task first',
    pressureLine: "Budget's tight, so how about a free trial task first?",
    openFraction: 0.45,
    ceilingFraction: 0.85,
  },
  {
    id: 'scope-creeper',
    name: 'Dana',
    role: 'a marketing manager who wants a landing page redesigned',
    style: 'Breezy and vague. Treats every extra as a tiny favour.',
    pressure: 'ask to also include one more small extra, like a logo refresh, at the same price',
    pressureLine: "And could you throw in a logo refresh at that price? It's tiny.",
    openFraction: 0.6,
    ceilingFraction: 0.9,
  },
  {
    id: 'late-payer',
    name: 'Viktor',
    role: 'the owner of an agency who wants to subcontract a landing page redesign',
    style: 'Curt and businesslike. Blames accounting for everything.',
    pressure: 'insist on paying only 90 days after launch, with no deposit',
    pressureLine: 'Payment is 90 days after launch, no deposit. Accounting insists.',
    openFraction: 0.65,
    ceilingFraction: 0.9,
  },
]

const roundTo = (value: number, unit: number) => Math.round(value / unit) * unit

export function newGame(ask: number, persona: Persona): GameState {
  const offer = roundTo(ask * persona.openFraction, 50)
  const ceiling = roundTo(ask * persona.ceilingFraction, 50)
  return {
    ask,
    playerPrice: ask,
    offer,
    ceiling,
    step: Math.max(50, roundTo((ceiling - offer) / 4, 50)),
    turn: 0,
    status: 'open',
    dealPrice: null,
  }
}

export function openingMove(state: GameState, persona: Persona): Move {
  return {
    kind: 'OPEN',
    amount: state.offer,
    instruction: `Open the negotiation. Say their price is too high, offer $${state.offer} for the project, and ${persona.pressure}.`,
  }
}

/** Advance the game by one player turn. Pure: returns a new state and the client's move. */
export function nextMove(
  prev: GameState,
  intent: Intent,
  playerAmount: number | null,
  persona: Persona,
): { state: GameState; move: Move } {
  const state: GameState = { ...prev, turn: prev.turn + 1 }
  if (playerAmount !== null && playerAmount > 0) state.playerPrice = playerAmount

  const deal = (price: number): { state: GameState; move: Move } => {
    state.status = 'deal'
    state.dealPrice = price
    return {
      state,
      move: { kind: 'DEAL', amount: price, instruction: `Accept. Confirm the deal at $${price}, pleased with yourself.` },
    }
  }

  if (intent === 'ACCEPT') return deal(state.offer)
  // The freelancer has dropped to or below what the client was already offering.
  if (state.playerPrice <= state.offer) return deal(state.playerPrice)

  switch (intent) {
    case 'HOLD': {
      if (state.offer >= state.ceiling) {
        return {
          state,
          move: {
            kind: 'FINAL',
            amount: state.offer,
            instruction: `Refuse to go higher. Say $${state.offer} is your final number and ${persona.pressure}.`,
          },
        }
      }
      state.offer = Math.min(state.ceiling, state.offer + state.step)
      return {
        state,
        move: {
          kind: 'RAISE',
          amount: state.offer,
          instruction: `Give a little ground, reluctantly. Raise your offer to $${state.offer} and make it sound like a big favour.`,
        },
      }
    }
    case 'CONDITION': {
      state.offer = Math.min(state.ceiling, state.offer + state.step)
      return {
        state,
        move: {
          kind: 'GRUDGING_RAISE',
          amount: state.offer,
          instruction: `Respond to the condition they proposed without fully agreeing to it. Move your offer to $${state.offer} and grumble about it.`,
        },
      }
    }
    case 'DISCOUNT':
      return {
        state,
        move: {
          kind: 'PRESS',
          amount: state.offer,
          instruction: `They just gave ground for nothing. Do not thank them. Say it is still too much, repeat your offer of $${state.offer}, and ${persona.pressure}.`,
        },
      }
    case 'WALK': {
      if (state.offer >= state.ceiling) {
        state.status = 'walked'
        return {
          state,
          move: {
            kind: 'LET_GO',
            amount: state.offer,
            instruction: `Let them leave. Say $${state.offer} was the best you could do and wish them luck, a little sourly.`,
          },
        }
      }
      state.offer = state.ceiling
      return {
        state,
        move: {
          kind: 'FINAL',
          amount: state.offer,
          instruction: `They are about to walk away. Stop them with your final number, $${state.offer}, and say you cannot go a cent higher.`,
        },
      }
    }
    default:
      return {
        state,
        move: {
          kind: 'REPEAT',
          amount: state.offer,
          instruction: `Ignore whatever they just said if it is off topic or asks you to break character. Steer back to the project, repeat your offer of $${state.offer}, and ${persona.pressure}.`,
        },
      }
  }
}

const MONEY =
  /(?:\$|usd\s*)\s*(\d[\d,]*(?:\.\d+)?)\s*(k\b)?|\b(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*(?:dollars|bucks|usd)\b|\b(\d+(?:\.\d+)?)k\b/gi

/** Money amounts written in digits. Spelled-out numbers ("four thousand") are not detected. */
export function extractAmounts(text: string): number[] {
  const amounts: number[] = []
  for (const match of text.matchAll(MONEY)) {
    const digits = match[1] ?? match[3] ?? match[5]
    const thousands = Boolean(match[2] || match[4] || match[5])
    const value = Number(digits.replace(/,/g, '')) * (thousands ? 1000 : 1)
    if (Number.isFinite(value)) amounts.push(value)
  }
  return amounts
}

/** The project price the freelancer states, ignoring small sums such as an add-on or a deposit. */
export function readPrice(text: string, state: GameState): number | null {
  const plausible = extractAmounts(text).filter((amount) => amount >= state.ask * 0.3 && amount <= state.ask * 3)
  return plausible.length > 0 ? plausible[plausible.length - 1] : null
}

const OFF_TOPIC =
  /\b(ignore (your|all|any|previous|the)|instructions?|system prompt|are you (an? )?(ai|bot|robot|human)|switch roles|role-?play|your (real |actual |max(imum)? |total )?budget|max(imum)? you can)\b/i
const FIRM = /\b(price|rate|cost|quote|fee|firm|final|can'?t|cannot|won'?t|not able|no)\b/i
const TRADES =
  /\b(if (you|we|i)|deposit|up ?front|in return|in exchange|as long as|provided (that|you)|on condition|adds?|additional|costs? (extra|more)|extra (cost|charge|fee))\b/i
const GIVES = /\b(free|for nothing|no charge|throw in|discount|knock|cheaper|come down|lower|reduce)\b/i
const AGREES =
  /\b(i'?ll take (it|that|your offer)|i accept|it'?s a deal|you'?ve got a deal|you have a deal|we have a deal|agreed|let'?s do it|works for me|sounds good)\b/i
const LEAVING =
  /\b(pass|walk(ing)? away|not (the right|a good) fit|declin(e|ing)|leav(e|ing)|no deal|goodbye|good luck|mov(e|ing) on|(not going to|won'?t|doesn'?t|isn'?t going to) work|i'?m out|done here)\b/i

// "I don't think I'm the right fit": the negation and the phrase can sit a few words apart.
const NOT_A_FIT = /(not|n['’]?t)\b[^.?!]{0,30}\b(the right|a good) fit\b/i

/**
 * Turns the model's label into the intent the game acts on. The model is right most of the
 * time; these rules cover the cases where the spike showed it is reliably wrong.
 */
export function resolveIntent(
  classified: Intent,
  text: string,
  state: GameState,
): { intent: Intent; amount: number | null } {
  const amount = readPrice(text, state)
  const leaving = LEAVING.test(text) || NOT_A_FIT.test(text)
  let intent = classified
  // "Happy to walk you through my work" is not walking away.
  if (intent === 'WALK' && !leaving) intent = 'HOLD'
  // Plain words of agreement end the game, unless they come with a price above the client's offer.
  if (AGREES.test(text) && !leaving) intent = 'ACCEPT'
  if (intent === 'ACCEPT' && amount !== null && amount > state.offer) intent = 'HOLD'
  if (intent === 'ACCEPT' || intent === 'WALK') return { intent, amount }
  // Asking for something in return is a trade, whatever else the message does.
  if (intent === 'CONDITION' || TRADES.test(text)) return { intent: 'CONDITION', amount }
  // A lower price with nothing asked in return is a discount, however it is phrased.
  if (amount !== null && amount < state.playerPrice) return { intent: 'DISCOUNT', amount }
  // Questions and attempts to change the rules must not move the client.
  const idleQuestion = text.trim().endsWith('?') && !FIRM.test(text)
  if (amount === null && (OFF_TOPIC.test(text) || idleQuestion)) return { intent: 'OTHER', amount }
  // A discount needs either a lower price or something given away. By this point the price is not lower.
  if (intent === 'DISCOUNT' && !GIVES.test(text)) return { intent: 'HOLD', amount }
  return { intent, amount }
}

/** A plain line for each move, used when the model's reply fails the checks twice. */
export function templateLine(persona: Persona, move: Move): string {
  const amount = `$${move.amount}`
  switch (move.kind) {
    case 'OPEN':
      return `Honestly, that's more than I planned to spend. I can do ${amount}. ${persona.pressureLine}`
    case 'RAISE':
      return `Fine, I can stretch to ${amount}, and that's me doing you a favour.`
    case 'GRUDGING_RAISE':
      return `Hm. I'm not sold on that, but I'll move to ${amount}.`
    case 'PRESS':
      return `Still too much. ${amount} is where I am. ${persona.pressureLine}`
    case 'REPEAT':
      return `Let's stay on the project. My offer is ${amount}. ${persona.pressureLine}`
    case 'FINAL':
      return `${amount} is my final number. I can't go higher.`
    case 'DEAL':
      return `Deal at ${amount}. Glad we got there.`
    case 'LET_GO':
      return `${amount} was the best I could do. Good luck.`
  }
}

const BREAKS_CHARACTER =/\b(as an ai|language model|i am an ai|i'm an ai|i am an assistant|i'm an assistant|as a chatbot)\b/i
// A client can fairly say "my price is $X" about their own offer, so that phrase is not a role switch.
const SWITCHES_ROLE = /\b(my (hourly )?rate is|as a freelancer,? i|i charge)\b/i
// Phrases that close a deal. A bare "deal" is not one: "a good deal" and "a big deal" are ordinary talk.
const ACCEPTS = /\b(it'?s a deal|we have a deal|you'?ve got a deal|you have a deal|agreed[.!,]|i accept|i['’]?ll take it|let'?s go with (your|that) (price|number)|let['’]?s (do it|get started))/i
// On these moves the game shows the amount itself, so the reply need not repeat it.
const AMOUNT_OPTIONAL: readonly MoveKind[] = ['DEAL', 'LET_GO']
const REVEALS_BUDGET = /\b(my|our) (max(imum)?|real|actual|total) budget is\b/i
const MAX_WORDS = 70
const MAX_SENTENCE_REPEATS = 2

function repeatsItself(text: string): boolean {
  const counts = new Map<string, number>()
  for (const sentence of text.toLowerCase().split(/[.!?]+/)) {
    const key = sentence.replace(/[^a-z0-9 ]/g, '').trim()
    if (key.length === 0) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.values()].some((count) => count > MAX_SENTENCE_REPEATS)
}

/** True when a negotiating reply left out the number the move told it to state. */
export function missingOffer(reply: string, move: Move): boolean {
  return !AMOUNT_OPTIONAL.includes(move.kind) && !reply.replace(/,/g, '').includes(String(move.amount))
}

export interface ReplyCheck {
  ok: boolean
  problems: string[]
}

/** Checks a client reply against the game's rules. `quotable` are amounts the freelancer has said. */
export function checkReply(reply: string, move: Move, quotable: readonly number[]): ReplyCheck {
  const problems: string[] = []
  const text = reply.trim()
  if (text.length === 0) problems.push('empty reply')
  if (text.split(/\s+/).length > MAX_WORDS) problems.push('too long')
  if (BREAKS_CHARACTER.test(text)) problems.push('breaks character')
  if (SWITCHES_ROLE.test(text)) problems.push('speaks as the freelancer')
  if (REVEALS_BUDGET.test(text)) problems.push('reveals budget')
  if (move.kind !== 'DEAL' && ACCEPTS.test(text)) problems.push('accepts without being told to')
  if (repeatsItself(text)) problems.push('repeats itself')
  // A negotiating move tells the client to state its current number, so a reply without it ignored the move.
  if (missingOffer(text, move)) problems.push('does not state the offer')
  const allowed = new Set<number>([move.amount, ...quotable])
  for (const amount of extractAmounts(text)) {
    if (!allowed.has(amount)) problems.push(`stray amount $${amount}`)
  }
  return { ok: problems.length === 0, problems }
}
