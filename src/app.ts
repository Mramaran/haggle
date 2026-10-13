// The playable game: one difficult client, text chat, up to eight turns.

import './app.css'
import type { MLCEngine } from '@mlc-ai/web-llm'
import { PERSONAS, newGame } from './game'
import type { GameState, Persona } from './game'
import { decodeCard, encodeCard, gradeFor, scoreGame, toShared } from './score'
import type { Moment, SharedCard } from './score'
import { hasWebGpu, loadModel, pickGameModel } from './llm'
import type { Spoken } from './llm'
import { MAX_TURNS, isOver, newSession, openGame, openerLine, playTurn } from './session'
import type { Session, TurnRecord } from './session'

const DEFAULT_ASK = 4000
const persona: Persona = PERSONAS[0]
/** `?debug` shows, under each reply, what the model did by itself and what the game's rules changed. */
const showWorkings = new URLSearchParams(location.search).has('debug')

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

function describeReply(spoken: Spoken): string {
  const rejected = spoken.tries.filter((attempt) => attempt.problems.length > 0)
  const from =
    spoken.source === 'template'
      ? 'fixed template (the model failed the checks twice)'
      : spoken.source === 'retry'
        ? "the model's second try"
        : spoken.tries[0]?.offerAdded
          ? 'the model, with the offer added by the game'
          : 'the model'
  const why = rejected.map((attempt) => `rejected "${attempt.text}" (${attempt.problems.join(', ')})`).join('; ')
  return `reply written by: ${from}${why ? `; ${why}` : ''}`
}

function addWorkings(spoken: Spoken, record?: TurnRecord) {
  if (!showWorkings) return
  const reading = record
    ? `model read your line as ${record.classified}; game used ${record.intent}${record.classified === record.intent ? '' : ' (a code rule overrode the model)'}; move ${record.move.kind}. `
    : ''
  addLine('note', `${reading}${describeReply(spoken)}`)
}

/** Fills in the scorecard. `moments` is the turn-by-turn list, which only the player's own card has. */
function renderCard(card: SharedCard, moments: readonly Moment[] | null, worstNote: string | null) {
  $('score').textContent = String(card.score)
  $('grade').textContent = gradeFor(card.score)
  const share = Math.round((card.price / card.ask) * 100)
  $('outcome').textContent =
    card.outcome === 'deal'
      ? `Deal at ${money(card.price)}, ${share}% of the ${money(card.ask)} asked.`
      : card.outcome === 'walked'
        ? `Walked away. ${card.personaName}'s last offer was ${money(card.price)} against an ask of ${money(card.ask)}.`
        : `No deal before ${card.personaName} had to go. The last offer on the table was ${money(card.price)}.`
  const left = card.outcome === 'deal' ? Math.max(0, card.ceiling - card.price) : 0
  const limit = `${card.personaName}'s real limit was ${money(card.ceiling)}.`
  const table = left > 0 ? ` ${money(left)} was still on the table.` : ''
  const given =
    card.concessions > 0
      ? ` Ground given for nothing: ${card.concessions} time${card.concessions === 1 ? '' : 's'}${card.givenAway > 0 ? `, ${money(card.givenAway)} off the price` : ''}.`
      : ' No ground given for nothing.'
  $('detail').textContent = `${limit}${table}${given}`

  $('worst').hidden = card.quote === null
  if (card.quote !== null) {
    $('worstquote').textContent = card.quote
    $('worstnote').textContent = worstNote ?? `Turn ${card.turn ?? '?'}: the first time ground was given for nothing.`
  }

  const list = $('moments')
  list.replaceChildren()
  list.hidden = moments === null
  for (const moment of moments ?? []) {
    const item = document.createElement('li')
    item.className = moment.good ? 'good' : 'bad'
    const note = document.createElement('strong')
    note.textContent = `Turn ${moment.turn}: ${moment.note}`
    const quote = document.createElement('span')
    quote.textContent = moment.quote
    item.append(note, quote)
    list.append(item)
  }
}

let lastCard: SharedCard | null = null

function finish(current: Session) {
  const { state } = current
  const card = scoreGame({
    personaName: persona.name,
    ask: state.ask,
    opening: newGame(state.ask, persona).offer,
    ceiling: state.ceiling,
    status: state.status,
    dealPrice: state.dealPrice,
    lastOffer: state.offer,
    turns: current.records,
  })
  lastCard = toShared(card)
  $('cardtitle').textContent = 'Your scorecard'
  renderCard(lastCard, card.moments, card.worst ? `Turn ${card.worst.turn}: ${card.worst.note}` : null)
  $('copied').textContent = ''
  $('share').hidden = false
  $('again').textContent = 'Play again'
  $('say').hidden = true
  $('end').hidden = false
  $('end').scrollIntoView({ block: 'start' })
}

async function copyShareLink() {
  if (!lastCard) return
  const link = `${location.origin}${location.pathname}#card=${encodeCard(lastCard)}`
  try {
    await navigator.clipboard.writeText(link)
    $('copied').textContent = 'Link copied. It holds your score and the one quoted line, nothing else.'
  } catch {
    $('copied').textContent = `Copy this link: ${link}`
  }
}

/** A link with `#card=...` opens someone's scorecard. It needs no model, so it works on any device. */
function showSharedCard(): boolean {
  if (!location.hash.startsWith('#card=')) return false
  const card = decodeCard(location.hash.slice('#card='.length))
  if (!card) return false
  $('cardtitle').textContent = `A round against ${card.personaName}`
  renderCard(card, null, null)
  $('share').hidden = true
  $('again').textContent = 'Play your own round'
  const end = $('end')
  end.hidden = false
  $('intro').before(end)
  return true
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
    const current = newSession(engine, persona, ask)
    session = current
    $('log').replaceChildren()
    $('say').hidden = false
    $('end').hidden = true
    $('game').after($('end'))
    show('game')
    updateMeta(current.state)
    setBusy(true)
    addLine('freelancer', openerLine(ask))
    const spoken = await whileTyping(() => openGame(current))
    addLine('client', spoken.text)
    addWorkings(spoken)
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
    const record = await whileTyping(() => playTurn(current, text))
    addLine('client', record.reply)
    addWorkings({ text: record.reply, ms: 0, source: record.source, tries: record.tries }, record)
    updateMeta(current.state)
    if (isOver(current)) {
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
    $('end').hidden = true
    $('game').after($('end'))
    history.replaceState(null, '', location.pathname + location.search)
    show('intro')
    $('ask').focus()
  })
  $('share').addEventListener('click', () => void copyShareLink())
  showSharedCard()
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
