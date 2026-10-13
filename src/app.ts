// The playable game: one difficult client, text chat, up to eight turns.

import './app.css'
import type { MLCEngine } from '@mlc-ai/web-llm'
import { PERSONAS, extractAmounts, newGame, nextMove, openingMove, resolveIntent } from './game'
import type { GameState, Intent, Move, Persona } from './game'
import { classifyPrompt, classifyTurn, hasWebGpu, loadModel, pickGameModel, speak } from './llm'
import type { ChatLine, Spoken } from './llm'

const MAX_TURNS = 8
const DEFAULT_ASK = 4000
const persona: Persona = PERSONAS[0]

/** One exchange, kept for the scorecard. */
export interface TurnRecord {
  player: string
  intent: Intent
  amount: number | null
  offerBefore: number
  move: Move
  reply: string
  source: Spoken['source']
}

interface Session {
  engine: MLCEngine
  state: GameState
  history: ChatLine[]
  quotable: number[]
  records: TurnRecord[]
}

declare global {
  interface Window {
    /** Development only: the live session, for inspection from the console. */
    __haggle?: () => Session | null
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const money = (amount: number) => `$${amount.toLocaleString('en-US')}`

let engine: MLCEngine | null = null
let session: Session | null = null
let warmedUp = false

function show(screen: 'intro' | 'loading' | 'game') {
  for (const id of ['intro', 'loading', 'game']) $(id).hidden = id !== screen
}

function addLine(kind: 'client' | 'freelancer' | 'note', text: string): HTMLLIElement {
  const item = document.createElement('li')
  item.className = kind
  if (kind !== 'note') {
    const who = document.createElement('span')
    who.className = 'who'
    who.textContent = kind === 'client' ? persona.name : 'You'
    item.append(who)
  }
  const body = document.createElement('p')
  body.textContent = text
  item.append(body)
  $('log').append(item)
  item.scrollIntoView({ block: 'end' })
  return item
}

function setBusy(busy: boolean) {
  $<HTMLTextAreaElement>('line').disabled = busy
  $<HTMLButtonElement>('send').disabled = busy
  if (!busy) $('line').focus()
}

function updateMeta(state: GameState) {
  $('turns').textContent = `Turn ${Math.min(state.turn + 1, MAX_TURNS)} of ${MAX_TURNS}`
  $('offer').textContent = `${persona.name}'s offer: ${money(state.offer)}`
  $('yours').textContent = `Your price: ${money(state.playerPrice)}`
}

/** Shows a typing note while the model works, then removes it. */
async function whileTyping<T>(work: () => Promise<T>): Promise<T> {
  const wait = warmedUp ? '' : ' The first reply warms up your GPU and can take half a minute.'
  const note = addLine('note', `${persona.name} is typing…${wait}`)
  try {
    return await work()
  } finally {
    note.remove()
    warmedUp = true
  }
}

async function clientSays(current: Session, move: Move): Promise<Spoken> {
  const spoken = await speak(current.engine, persona, current.state.ask, move, current.history, current.quotable)
  current.history.push({ speaker: 'client', text: spoken.text })
  return spoken
}

function finish(current: Session) {
  const { state } = current
  let outcome: string
  let detail: string
  if (state.status === 'deal' && state.dealPrice !== null) {
    const share = Math.round((state.dealPrice / state.ask) * 100)
    outcome = `Deal at ${money(state.dealPrice)}`
    detail = `That is ${share}% of the ${money(state.ask)} you asked for.`
  } else if (state.status === 'walked') {
    outcome = 'You walked away'
    detail = `${persona.name}'s last offer was ${money(state.offer)}, against your ask of ${money(state.ask)}.`
  } else {
    outcome = 'No deal yet'
    detail = `${persona.name} had to jump on another call. The last offer on the table was ${money(state.offer)}.`
  }
  $('outcome').textContent = outcome
  $('detail').textContent = detail
  $('say').hidden = true
  $('end').hidden = false
  $('again').focus()
}

async function start() {
  const typed = Math.round(Number($<HTMLInputElement>('ask').value) / 50) * 50
  const ask = Number.isFinite(typed) && typed >= 500 ? typed : DEFAULT_ASK
  $('notice').textContent = ''
  show('loading')
  try {
    if (!engine) {
      const model = new URLSearchParams(location.search).get('model') ?? (await pickGameModel())
      engine = await loadModel(model, (report) => {
        $<HTMLProgressElement>('bar').value = report.progress
        $('loadtext').textContent = report.text
      })
    }
    const current: Session = { engine, state: newGame(ask, persona), history: [], quotable: [ask], records: [] }
    session = current
    $('log').replaceChildren()
    $('say').hidden = false
    $('end').hidden = true
    show('game')
    updateMeta(current.state)
    setBusy(true)
    const opener = `My price for this project is ${money(ask)}.`
    addLine('freelancer', opener)
    current.history.push({ speaker: 'freelancer', text: opener })
    const spoken = await whileTyping(() => clientSays(current, openingMove(current.state, persona)))
    addLine('client', spoken.text)
    setBusy(false)
  } catch (error) {
    show('intro')
    $('notice').textContent = `Could not start: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function send(text: string) {
  const current = session
  if (!current || current.state.status !== 'open') return
  addLine('freelancer', text)
  setBusy(true)
  try {
    const spoken = await whileTyping(async () => {
      const prompt = classifyPrompt(text, current.state.playerPrice, current.state.offer)
      const classification = await classifyTurn(current.engine, prompt)
      const { intent, amount } = resolveIntent(classification.intent, text, current.state)
      current.history.push({ speaker: 'freelancer', text })
      current.quotable.push(...extractAmounts(text))
      const offerBefore = current.state.offer
      const next = nextMove(current.state, intent, amount, persona)
      current.state = next.state
      const reply = await clientSays(current, next.move)
      current.records.push({ player: text, intent, amount, offerBefore, move: next.move, reply: reply.text, source: reply.source })
      return reply
    })
    addLine('client', spoken.text)
    updateMeta(current.state)
    if (current.state.status !== 'open' || current.state.turn >= MAX_TURNS) {
      finish(current)
      return
    }
  } catch (error) {
    addLine('note', `Something went wrong (${error instanceof Error ? error.message : String(error)}). Try sending that again.`)
  }
  setBusy(false)
}

function init() {
  $('who').textContent = `${persona.name}, ${persona.role}`
  if (!hasWebGpu()) {
    $('notice').textContent =
      'This browser cannot run the model (no WebGPU). Try a current Chrome or Edge on a computer with a graphics card.'
    $<HTMLButtonElement>('start').disabled = true
  }
  $('start').addEventListener('click', () => void start())
  $('again').addEventListener('click', () => {
    session = null
    show('intro')
  })
  const line = $<HTMLTextAreaElement>('line')
  const submit = () => {
    const text = line.value.trim()
    if (text.length === 0 || line.disabled) return
    line.value = ''
    void send(text)
  }
  $<HTMLFormElement>('say').addEventListener('submit', (event) => {
    event.preventDefault()
    submit()
  })
  line.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  })
  if (import.meta.env.DEV) window.__haggle = () => session
}

init()
