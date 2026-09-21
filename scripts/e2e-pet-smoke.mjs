// 리븐펫 smoke test against a running dev app (electron-vite dev started with
// `-- --remote-debugging-port=9444`). Drives the real renderer over CDP: feeds the
// pet tokens the way the usage poll does, and asserts that it grows, that the
// gauges move, that the save round-trips through pet.json, and that the
// device sleeps while nobody is looking at it.
//
//   npx electron-vite dev -- --remote-debugging-port=9444   (in one shell)
//   RIVEN_CDP_PORT=9444 node scripts/e2e-pet-smoke.mjs
//
// No dependencies: Node 22's global WebSocket + fetch.

const PORT = Number(process.env.RIVEN_CDP_PORT ?? 9444)
const WS_PATH = process.env.RIVEN_WS ?? process.cwd()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      // The app window, not the pet's own one — once it has been popped out
      // there are two page targets and only one of them is riven.
      const page = targets.find(
        (t) => t.type === 'page' && !/devtools/i.test(t.url) && !/pet\.html/.test(t.url)
      )
      if (page) return page
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  throw new Error(`no page target on CDP port ${PORT}`)
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.seq = 0
    this.pending = new Map()
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      }
    })
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', reject, { once: true })
    })
  }
  send(method, params = {}) {
    const id = ++this.seq
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval threw')
    return r.result.value
  }
}

async function findPetWindow() {
  for (let i = 0; i < 20; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    const page = targets.find((t) => t.type === 'page' && /pet\.html/.test(t.url))
    if (page) return page
    await sleep(300)
  }
  return null
}

// Everything below works the device the way a person does: three buttons.
const PRESS = (k) => `document.querySelector('[data-key="${k}"]').click()`
// A and B mean different things inside a screen (page / act on a row), so every
// sequence starts by backing out to the pet, exactly as you would with the real
// device in your hand.
const HOME = `(async () => {
  for (let i = 0; i < 4; i++) {
    if (document.querySelector('.pet-yard')) break
    ${PRESS('c')}
    await new Promise((r) => setTimeout(r, 160))
  }
})()`
const WALK_TO = (id) => `(async () => {
  await ${HOME}
  for (let i = 0; i < 12; i++) {
    if (document.querySelector('.pet-ic.picked')?.dataset.ic === '${id}') return true
    ${PRESS('a')}
    await new Promise((r) => setTimeout(r, 110))
  }
  return false
})()`
const RUN = (id) => `(async () => {
  const found = await ${WALK_TO(id)}
  if (!found) return false
  ${PRESS('b')}
  await new Promise((r) => setTimeout(r, 300))
  return true
})()`

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  const page = await findPage()
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Runtime.enable')
  // The pet sleeps in an unfocused window (by design), so the window has to be up
  // front for the "it animates" half of the check to mean anything.
  await cdp.send('Page.bringToFront')
  await sleep(500)

  // The device floats over the app and needs no workspace, but open one anyway so
  // the app is in its normal working state.
  await cdp.eval(`__riven.session.getState().openWorkspace(${JSON.stringify(WS_PATH)})`)
  // Make sure it is showing (a previous run may have hidden it) and unfolded.
  await cdp.eval(
    `__riven.settings.getState().set({ petShow: true, petDetached: false, petChrome: 'full', petPos: null })`
  )
  await sleep(900)
  check(
    'the device floats over the workbench without a panel',
    await cdp.eval(`(() => {
      const el = document.querySelector('.pet-device')
      if (!el) return false
      const api = __riven.getActiveApi()
      const noPanel = !api || !api.panels.some((p) => /pet/.test(p.id))
      return getComputedStyle(el).position === 'fixed' && noPanel
    })()`)
  )
  check('the LCD is drawn as dots', await cdp.eval(`(() => {
    const px = document.querySelectorAll('.pet-lcd .pet-px')
    const svg = document.querySelector('.pet-lcd')
    return px.length > 20 && svg.getAttribute('shape-rendering') === 'crispEdges'
  })()`))

  // Start from a known state, then feed like the usage poll does: 2.4M fresh
  // tokens of agent spend is 120 kibble, well past the egg (10 kibble).
  const fed = await cdp.eval(`(() => {
    const s = __riven.pet
    s.getState().reset()
    s.getState().sample({ probe: 0 })        // baseline only
    s.getState().sample({ probe: 2400000 })  // 120 kibble
    const p = s.getState().pet
    return { xp: p.xp, tokens: p.totalTokens, fullness: p.fullness }
  })()`)
  check('tokens become food', fed.xp === 120 && fed.tokens === 2_400_000, JSON.stringify(fed))
  check('fullness fills up', fed.fullness === 100, `fullness=${fed.fullness}`)

  const stage = await cdp.eval(`document.querySelector('.pet-lcd').getAttribute('class')`)
  check('grew past the egg', /pet-s-child/.test(stage), stage)
  const litCells = await cdp.eval(`(async () => {
    await ${RUN('meter')}
    const lit = document.querySelectorAll('.pet-cell.tone-food.on').length
    ${PRESS('c')}
    await new Promise((r) => setTimeout(r, 200))
    return lit
  })()`)
  check('the food gauge fills up, on the meter screen', litCells === 10, `${litCells}/10 cells lit`)

  // Neglect: rewind the tick clock and let the device's tick charge for it. Thirty
  // hours, not twenty: night passes at SLEEP_RATE, so a span that happens to cover
  // two nights spends much less of itself starving.
  // Read back inside the SAME eval — the usage poll is live in a dev app that is
  // watching real accounts, and a refresh landing mid-check would feed the pet.
  const starved = await cdp.eval(`(async () => {
    const s = __riven.pet
    const p = s.getState().pet
    s.setState({ pet: { ...p, lastTickAt: p.lastTickAt - 30 * 3600000, bornAt: p.bornAt - 60 * 3600000 } })
    s.getState().tick()
    const q = s.getState().pet
    // Give React a beat to commit the mood class onto the sprite. A timer, not
    // requestAnimationFrame: a backgrounded window paints no frames.
    await new Promise((r) => setTimeout(r, 150))
    return { fullness: q.fullness, mood: Math.round(q.mood), neglectH: +(q.neglectMs / 3600000).toFixed(1),
             sick: q.sick, face: !!document.querySelector('.pet-lcd.pet-m-sick') }
  })()`)
  check(
    'silence starves it, and starving long enough makes it ill',
    starved.fullness === 0 && starved.neglectH > 10 && starved.sick && starved.face,
    JSON.stringify(starved)
  )

  // Petting lifts the mood, from a mood low enough that the +6 is visible.
  const petted = await cdp.eval(`(async () => {
    const s = __riven.pet
    s.setState({ pet: { ...s.getState().pet, mood: 20, lastPetAt: 0 } })
    await new Promise((r) => setTimeout(r, 150))
    await ${RUN('pet')}
    return s.getState().pet.mood
  })()`)
  check('petting lifts the mood', petted === 26, `20 → ${petted}`)

  // Grown-up form: steadily fed, barely any neglect → radiant.
  await cdp.eval(`(() => {
    const s = __riven.pet
    const now = Date.now()
    s.setState({ pet: { ...s.getState().pet, xp: 900, bornAt: now - 300 * 3600000, neglectMs: 6 * 3600000,
                        fullness: 90, mood: 90, sick: false, illHours: 0, poops: 0, lastTickAt: now } })
  })()`)
  await sleep(300)
  const adult = await cdp.eval(`document.querySelector('.pet-lcd').getAttribute('class')`)
  check('a well-raised adult is radiant', /pet-s-adult/.test(adult) && /pet-f-radiant/.test(adult), adult)

  // Animation must stop when nobody is looking. A CDP-driven app is never really
  // in front — the driver's own terminal is, which leaves the window occluded
  // (`visibilityState: 'hidden'`) and unfocused — so both signals are stubbed to
  // exercise the device's wiring instead of stealing the user's focus.
  const SEE = `Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })`
  const state = () => `(() => ({
    cls: document.querySelector('.pet-device').className.trim(),
    play: getComputedStyle(document.querySelector('.pet-sprite')).animationPlayState
  }))()`
  const awake = await cdp.eval(`(async () => {
    ${SEE}
    document.hasFocus = () => true
    window.dispatchEvent(new Event('focus'))
    await new Promise((r) => setTimeout(r, 150))
    return ${state()}
  })()`)
  check(
    'animates while the window is focused',
    !/pet-asleep/.test(awake.cls) && awake.play === 'running',
    JSON.stringify(awake)
  )
  const blurred = await cdp.eval(`(async () => {
    document.hasFocus = () => false
    window.dispatchEvent(new Event('blur'))
    await new Promise((r) => setTimeout(r, 150))
    return ${state()}
  })()`)
  check(
    'sleeps when the window goes to the background',
    /pet-asleep/.test(blurred.cls) && blurred.play === 'paused',
    JSON.stringify(blurred)
  )
  const rewoken = await cdp.eval(`(async () => {
    ${SEE}
    document.hasFocus = () => true
    window.dispatchEvent(new Event('focus'))
    await new Promise((r) => setTimeout(r, 150))
    return ${state()}
  })()`)
  check('wakes up when the window comes back', rewoken.play === 'running', JSON.stringify(rewoken))

  // The size is changed from the device's OWN setup screen — no hover controls.
  const chrome = async (level) =>
    cdp.eval(`(async () => {
      await ${RUN('settings')}
      // Walk the row cursor onto "size", then press B until it reads the level.
      for (let i = 0; i < 6; i++) {
        if (document.querySelector('.pet-row.picked')?.dataset.row === 'size') break
        ${PRESS('a')}
        await new Promise((r) => setTimeout(r, 120))
      }
      for (let i = 0; i < 4; i++) {
        if (__riven.settings.getState().settings.petChrome === '${level}') break
        ${PRESS('b')}
        await new Promise((r) => setTimeout(r, 250))
      }
      await new Promise((r) => setTimeout(r, 350))
      return { cls: document.querySelector('.pet-device').className,
               case: !!document.querySelector('.pet-case'),
               bezel: !!document.querySelector('.pet-bezel'),
               icons: document.querySelectorAll('.pet-ic').length,
               keys: document.querySelectorAll('.pet-key').length,
               creature: !!document.querySelector('.pet-lcd'),
               gauges: document.querySelectorAll('.pet-gauge').length,
               saved: __riven.settings.getState().settings.petChrome }
    })()`)
  const screenOnly = await chrome('screen')
  check(
    'folds down to the glass and its buttons, from its own setup screen',
    screenOnly.saved === 'screen' && screenOnly.bezel && !screenOnly.case && screenOnly.keys === 3,
    JSON.stringify(screenOnly)
  )
  const bare = await cdp.eval(`(async () => {
    __riven.settings.getState().set({ petChrome: 'bare' })
    await new Promise((r) => setTimeout(r, 300))
    return { cls: document.querySelector('.pet-device').className,
             bezel: !!document.querySelector('.pet-bezel'),
             keys: document.querySelectorAll('.pet-key').length,
             icons: document.querySelectorAll('.pet-ic').length,
             creature: !!document.querySelector('.pet-lcd'),
             gauges: document.querySelectorAll('.pet-gauge').length,
             escape: document.querySelectorAll('.pet-tools .pet-icon').length }
  })()`)
  check(
    'hides every bit of UI but the creature',
    /pet-chrome-bare/.test(bare.cls) && !bare.bezel && bare.keys === 0 && bare.icons === 0 &&
      bare.gauges === 0 && bare.creature && bare.escape === 2,
    JSON.stringify(bare)
  )
  await cdp.eval(`__riven.settings.getState().set({ petChrome: 'full' })`)
  await sleep(350)

  // The eight functions are segments of the screen, not buttons on the case, and
  // nothing is hidden behind a hover.
  const onGlass = await cdp.eval(`(() => ({
    icons: [...document.querySelectorAll('.pet-screen .pet-ic')].map((b) => b.dataset.ic),
    clickable: [...document.querySelectorAll('.pet-ic')].filter((e) => e.tagName === 'BUTTON').length,
    keys: document.querySelectorAll('.pet-key').length,
    hoverOnly: document.querySelectorAll('.pet-tools').length
  }))()`)
  check(
    'its eight functions live on the glass and only three buttons work them',
    onGlass.hoverOnly === 0 && onGlass.keys === 3 && onGlass.clickable === 0 &&
      ['feed', 'play', 'clean', 'medicine', 'pet', 'meter', 'album', 'settings'].every((id) =>
        onGlass.icons.includes(id)
      ),
    onGlass.icons.join(' · ')
  )

  // A walks the highlight, B runs what it is on, C backs out.
  const abc = await cdp.eval(`(async () => {
    await ${HOME}
    const first = document.querySelector('.pet-ic.picked')?.dataset.ic ?? null
    ${PRESS('a')}
    await new Promise((r) => setTimeout(r, 250))
    const moved = document.querySelector('.pet-ic.picked')?.dataset.ic ?? null
    await ${RUN('album')}
    const opened = document.querySelector('.pet-screen-top span').textContent
    ${PRESS('c')}
    await new Promise((r) => setTimeout(r, 250))
    const backHome = !!document.querySelector('.pet-yard')
    return { first, moved, opened, backHome }
  })()`)
  check(
    'A moves the highlight, B runs it, C comes back',
    abc.moved !== abc.first && /도감|ALBUM/.test(abc.opened) && abc.backHome,
    JSON.stringify(abc)
  )

  // Care: it makes a mess, you clean it; it falls ill, you medicate it.
  const mess = await cdp.eval(`(async () => {
    const s = __riven.pet
    s.setState({ pet: { ...s.getState().pet, poops: 2, sick: false, fullness: 70, mood: 70, lastTickAt: Date.now() } })
    await new Promise((r) => setTimeout(r, 250))
    const onFloor = document.querySelectorAll('.pet-poop').length
    const alerts = !!document.querySelector('[data-ic="clean"].alert')
    await ${RUN('clean')}
    await new Promise((r) => setTimeout(r, 250))
    return { onFloor, alerts, left: s.getState().pet.poops, cleared: document.querySelectorAll('.pet-poop').length }
  })()`)
  check(
    'droppings show up and can be cleaned',
    mess.onFloor === 2 && mess.alerts && mess.left === 0 && mess.cleared === 0,
    JSON.stringify(mess)
  )

  const ill = await cdp.eval(`(async () => {
    const s = __riven.pet
    s.setState({ pet: { ...s.getState().pet, sick: true, illHours: 9, lastTickAt: Date.now() } })
    await new Promise((r) => setTimeout(r, 250))
    const looksIll = !!document.querySelector('.pet-lcd.pet-m-sick') && !!document.querySelector('.pet-cross')
    await ${RUN('medicine')}
    await new Promise((r) => setTimeout(r, 250))
    return { looksIll, stillSick: s.getState().pet.sick }
  })()`)
  check('illness shows, and medicine cures it', ill.looksIll && !ill.stillSick, JSON.stringify(ill))

  // The guessing game.
  const game = await cdp.eval(`(async () => {
    const s = __riven.pet
    s.setState({ pet: { ...s.getState().pet, fullness: 80, mood: 50, lastPlayAt: 0, plays: 0 } })
    await new Promise((r) => setTimeout(r, 200))
    await ${RUN('play')}
    const arrows = document.querySelectorAll('.pet-arrow').length
    ${PRESS('a')}   // guess left
    await new Promise((r) => setTimeout(r, 300))
    const p = s.getState().pet
    return { arrows, plays: p.plays, mood: Math.round(p.mood), said: document.querySelector('.pet-screen-mood').textContent }
  })()`)
  check(
    'playing a round lifts the mood',
    game.arrows === 2 && game.plays === 1 && game.mood > 50,
    JSON.stringify(game)
  )

  // What it ate is recorded per model, and shows up as a taste.
  const diet = await cdp.eval(`(async () => {
    const s = __riven.pet
    s.getState().reset()
    s.setState({ seen: {} })
    s.getState().sample({ 'work::opus': 0, 'work::haiku': 0 })
    s.getState().sample({ 'work::opus': 2000000, 'work::haiku': 400000 })
    await new Promise((r) => setTimeout(r, 300))
    const p = s.getState().pet
    return { diet: p.diet, xp: p.xp, story: p.evolutions.map((e) => e.stage) }
  })()`)
  check(
    'each meal is recorded under the model that paid for it',
    diet.diet.opus === 100 && diet.diet.haiku === 20 && diet.xp === 120,
    JSON.stringify(diet.diet)
  )
  check(
    'growing up is logged as a life story',
    diet.story[0] === 'egg' && diet.story.includes('child'),
    diet.story.join(' → ')
  )

  // Growing up is celebrated on the screen.
  const evolved = await cdp.eval(`(() => ({
    burst: !!document.querySelector('.pet-burst'),
    line: document.querySelector('.pet-screen-mood').textContent
  }))()`)
  check('evolving bursts on screen', evolved.burst && /됐다|Grew/.test(evolved.line), JSON.stringify(evolved))

  // It says what it needs, in one short line.
  const bubble = async (patch) =>
    cdp.eval(`(async () => {
      // C shuts it up: an answer stays on screen for seconds, and this check is
      // about the ambient line underneath.
      ${PRESS('c')}
      const s = __riven.pet
      s.setState({ pet: { ...s.getState().pet, lastTickAt: Date.now(), ...${JSON.stringify(patch).replace(/"(\w+)":/g, '$1:')} } })
      await new Promise((r) => setTimeout(r, 2000))
      return document.querySelector('.pet-balloon')?.textContent ?? null
    })()`)
  const hungrySays = await bubble({ fullness: 10, mood: 60, poops: 0, sick: false })
  const wellSays = await bubble({ fullness: 90, mood: 90, poops: 0, sick: false })
  check(
    'says what it needs, and keeps quiet when it needs nothing',
    !!hungrySays && wellSays === null,
    `hungry: ${hungrySays} · content: ${wellSays}`
  )

  // Night: it sleeps, and will not be played with.
  const night = await cdp.eval(`(async () => {
    const orig = Date.prototype.getHours
    Date.prototype.getHours = function () { return 3 }
    try {
      const s = __riven.pet
      s.setState({ pet: { ...s.getState().pet, sick: false, fullness: 80, mood: 80, lastTickAt: Date.now() } })
      await new Promise((r) => setTimeout(r, 500))
      const before = s.getState().pet.plays
      const declined = s.getState().playRound('left') === null
      return { face: document.querySelector('.pet-lcd').getAttribute('class'),
               zzz: !!document.querySelector('.pet-zzz'),
               said: document.querySelector('.pet-balloon')?.textContent,
               declined, plays: s.getState().pet.plays === before }
    } finally {
      Date.prototype.getHours = orig
    }
  })()`)
  check(
    'sleeps through the night and will not be played with',
    /pet-m-asleep/.test(night.face) && night.zzz && night.declined && night.plays,
    JSON.stringify(night)
  )

  // Awards light up as they are earned — the meter's second page.
  const awards = await cdp.eval(`(async () => {
    const s = __riven.pet
    s.setState({ pet: { ...s.getState().pet, xp: 900, totalTokens: 12000000, bornAt: Date.now() - 300 * 3600000,
                        neglectMs: 2 * 3600000, plays: 12, wins: 6, everSick: false, sick: false, lastTickAt: Date.now() } })
    await new Promise((r) => setTimeout(r, 300))
    await ${RUN('meter')}
    ${PRESS('a')}
    await new Promise((r) => setTimeout(r, 300))
    const out = { title: document.querySelector('.pet-screen-top span').textContent,
                  total: document.querySelectorAll('.pet-award').length,
                  done: document.querySelectorAll('.pet-award.done').length }
    ${PRESS('c')}
    await new Promise((r) => setTimeout(r, 200))
    return out
  })()`)
  check(
    'awards light up as they are earned',
    awards.total === 10 && awards.done >= 8 && awards.done < 10,
    JSON.stringify(awards)
  )

  // Each icon opens its own screen. The loop lives in the PAGE, not here: the
  // driver helpers above are interpolated by Node, so a loop variable of ours is
  // not in scope inside them.
  const screens = await cdp.eval(`(async () => {
    const press = (k) => document.querySelector('[data-key="' + k + '"]').click()
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const home = async () => {
      for (let i = 0; i < 4; i++) {
        if (document.querySelector('.pet-yard')) break
        press('c')
        await wait(160)
      }
    }
    const open = async (id) => {
      await home()
      for (let i = 0; i < 12; i++) {
        if (document.querySelector('.pet-ic.picked')?.dataset.ic === id) break
        press('a')
        await wait(110)
      }
      press('b')
      await wait(300)
    }
    const titles = []
    for (const id of ['feed', 'meter', 'album', 'settings']) {
      await open(id)
      titles.push(document.querySelector('.pet-screen-top span').textContent)
      press('c')
      await wait(200)
    }
    return titles
  })()`)
  check(
    'each icon on the glass opens its own screen',
    screens.length === 4 && new Set(screens).size === 4,
    screens.join(' · ')
  )

  // Inside the meter, A turns the page — status, then awards — and C comes out.
  const meterPages = await cdp.eval(`(async () => {
    await ${RUN('meter')}
    const first = document.querySelector('.pet-screen-top span').textContent
    ${PRESS('a')}
    await new Promise((r) => setTimeout(r, 250))
    const second = document.querySelector('.pet-screen-top span').textContent
    const awards = document.querySelectorAll('.pet-award').length
    ${PRESS('c')}
    await new Promise((r) => setTimeout(r, 200))
    return { first, second, awards, home: !!document.querySelector('.pet-yard') }
  })()`)
  check(
    'the meter turns its pages with A and closes with C',
    meterPages.first !== meterPages.second && meterPages.awards === 10 && meterPages.home,
    JSON.stringify(meterPages)
  )

  // With nothing highlighted, B shows the clock — as on the original.
  const clock = await cdp.eval(`(async () => {
    await ${HOME}
    ${PRESS('c')}
    await new Promise((r) => setTimeout(r, 150))
    const cleared = !document.querySelector('.pet-ic.picked')
    ${PRESS('b')}
    await new Promise((r) => setTimeout(r, 300))
    const shown = document.querySelector('.pet-clock b')?.textContent ?? null
    ${PRESS('c')}
    await new Promise((r) => setTimeout(r, 200))
    return { cleared, shown, home: !!document.querySelector('.pet-yard') }
  })()`)
  check(
    'C clears the highlight and B then shows the clock',
    clock.cleared && /\d/.test(clock.shown ?? '') && clock.home,
    JSON.stringify(clock)
  )

  // Out of riven's window entirely, and back.
  const out = await cdp.eval(`(async () => {
    __riven.settings.getState().set({ petDetached: true })
    await new Promise((r) => setTimeout(r, 2000))
    return { inApp: !!document.querySelector('.pet-device'), windowOpen: await window.api.pet.isOpen() }
  })()`)
  check('pops out into its own desktop window', out.windowOpen && !out.inApp, JSON.stringify(out))

  // ...and the window is the size of the device. It used to be measured wrong,
  // which cut the buttons off the bottom of the case.
  const petPage = await findPetWindow()
  let fit = { error: 'no pet window' }
  if (petPage) {
    const petCdp = new Cdp(petPage.webSocketDebuggerUrl)
    await petCdp.open()
    await petCdp.send('Runtime.enable')
    fit = await petCdp.eval(`(async () => {
      // Its own window boots its own React app; wait for the device to exist
      // before pressing anything on it.
      for (let i = 0; i < 40; i++) {
        if (document.querySelector('[data-key="c"]')) break
        await new Promise((r) => setTimeout(r, 150))
      }
      if (!document.querySelector('[data-key="c"]'))
        return { error: 'the floating device never showed its buttons',
                 cls: document.querySelector('.pet-device')?.className ?? 'no device' }
      // Resizing the window is a round trip (renderer → main → setBounds → new
      // viewport), so a size read the instant the class flips is reading the OLD
      // window. Wait for innerHeight to hold still first.
      const read = async () => {
        let last = -1
        for (let i = 0; i < 20; i++) {
          if (innerHeight === last) break
          last = innerHeight
          await new Promise((r) => setTimeout(r, 100))
        }
        const r = document.querySelector('.pet-device').getBoundingClientRect()
        return { h: innerHeight, bottom: Math.round(r.bottom), clipped: r.bottom > innerHeight }
      }
      const before = await read()
      // Fold it down and back from its own setup screen: the window must follow,
      // and must not creep.
      const press = (k) => document.querySelector('[data-key="' + k + '"]')?.click()
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const is = (want) => document.querySelector('.pet-device').className.includes('pet-chrome-' + want)
      // Stepping the size row walks full → screen → creature-only, and in that
      // last one the buttons are gone by design — the pet itself is the way back.
      const size = async (want) => {
        for (let i = 0; i < 8; i++) {
          if (is(want)) return
          if (is('bare')) {
            document.querySelector('.pet-bare').click()
            await wait(350)
            continue
          }
          for (let j = 0; j < 4; j++) { if (document.querySelector('.pet-yard')) break; press('c'); await wait(160) }
          for (let j = 0; j < 12; j++) {
            if (document.querySelector('.pet-ic.picked')?.dataset.ic === 'settings') break
            press('a'); await wait(110)
          }
          press('b')
          await wait(300)
          for (let j = 0; j < 6; j++) {
            if (document.querySelector('.pet-row.picked')?.dataset.row === 'size') break
            press('a'); await wait(120)
          }
          press('b')
          await wait(350)
        }
      }
      await size('screen')
      const folded = await read()
      await size('full')
      const back = await read()
      return { before, folded, back }
    })()`)
    // The floating window is moved by the OS through -webkit-app-region, which
    // does NOT inherit: setting it on the root alone leaves every visible pixel
    // computing to `none` and the window cannot be picked up at all. That is a
    // different mechanism from the in-app drag, which is why the two used to
    // regress one at a time — so both are checked, every run.
    const grabbable = await petCdp.eval(`(async () => {
      // Back to the pet screen: the creature only exists there.
      for (let i = 0; i < 4; i++) {
        if (document.querySelector('.pet-yard')) break
        document.querySelector('[data-key="c"]').click()
        await new Promise((r) => setTimeout(r, 160))
      }
      const g = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).webkitAppRegion : null }
      return { device: g('.pet-device'), case: g('.pet-case'), deck: g('.pet-deck'),
               screen: g('.pet-screen'), creature: g('.pet-lcd'), key: g('[data-key="a"]') }
    })()`)
    check(
      'its own window can be picked up anywhere but its buttons',
      ['device', 'case', 'deck', 'screen', 'creature'].every((k) => grabbable[k] === 'drag') &&
        grabbable.key === 'no-drag',
      JSON.stringify(grabbable)
    )

    // The three keys are bound to Mod+Alt+a/s/d. The keystroke lands in whichever
    // riven window has focus, so the press is relayed through main to every
    // window — pressing from the APP has to drive the device in its OWN window.
    const relayed = await (async () => {
      await petCdp.eval(`(async () => {
        for (let i = 0; i < 4; i++) {
          if (document.querySelector('.pet-yard')) break
          document.querySelector('[data-key="c"]').click()
          await new Promise((r) => setTimeout(r, 160))
        }
      })()`)
      // A walks the icon strip. Stop on an icon that OPENS something (meter) so
      // B and C have a visible effect: the screen shows, then C comes home.
      let landed = null
      for (let i = 0; i < 12; i++) {
        landed = await petCdp.eval(`document.querySelector('.pet-ic.picked')?.dataset.ic ?? null`)
        if (landed === 'meter') break
        await cdp.eval(`window.api.pet.press('a')`)
        await sleep(200)
      }
      await cdp.eval(`window.api.pet.press('b')`)
      await sleep(400)
      const opened = await petCdp.eval(`!document.querySelector('.pet-yard')`)
      await cdp.eval(`window.api.pet.press('c')`)
      await sleep(400)
      const home = await petCdp.eval(`!!document.querySelector('.pet-yard')`)
      return { landed, opened, home }
    })()
    check(
      'the keyboard shortcuts reach the device in its own window',
      relayed.landed === 'meter' && relayed.opened && relayed.home,
      JSON.stringify(relayed)
    )

    // Nothing may paint behind the frameless window: a background on the page or
    // a drop shadow on the case shows up as a grey smudge on the desktop.
    const clean = await petCdp.eval(`(() => {
      const bg = (el) => getComputedStyle(el).backgroundColor
      const clear = (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent'
      const outer = [...document.querySelectorAll('.pet-case, .pet-mini, .pet-stand, .pet-stand i')]
        .map((e) => getComputedStyle(e).boxShadow)
        .filter((v) => v && v !== 'none' && !v.includes('inset'))
      return { html: bg(document.documentElement), body: bg(document.body), root: bg(document.getElementById('root')),
               transparent: [document.documentElement, document.body, document.getElementById('root')].every((e) => clear(bg(e))),
               outer }
    })()`)
    check(
      'nothing paints behind its window',
      clean.transparent && clean.outer.length === 0,
      JSON.stringify(clean)
    )

    check(
      'its window fits the device exactly, whatever is showing',
      !fit.error &&
        !fit.before.clipped &&
        !fit.folded.clipped &&
        !fit.back.clipped &&
        fit.back.h === fit.before.h,
      JSON.stringify(fit)
    )
  } else {
    check('its window fits the device exactly, whatever is showing', false, 'no pet window target')
  }
  const back = await cdp.eval(`(async () => {
    __riven.settings.getState().set({ petDetached: false })
    await new Promise((r) => setTimeout(r, 1200))
    return { inApp: !!document.querySelector('.pet-device'), windowOpen: await window.api.pet.isOpen() }
  })()`)
  check('comes back inside the app', !back.windowOpen && back.inApp, JSON.stringify(back))

  // ---- it answers questions about the workspaces ----
  //
  // A real pane is used (a terminal — no agent, no tokens): the pet names the
  // workspace a busy pane belongs to, and that comes from the dock layout, so a
  // made-up pane key has no workspace and is deliberately ignored.
  const talk = await cdp.eval(`(async () => {
    __riven.addTerminal()
    await new Promise((r) => setTimeout(r, 900))
    const term = __riven.getActiveApi().panels.map((p) => p.id).filter((id) => id.startsWith('term-')).pop()
    __riven.roster.getState().patch(term, { busy: true, tabTitle: 'build' })
    // A plan window, injected and read in one beat: this account may report none,
    // and the live poll rewrites the store every minute.
    __riven.usage.setState({ accounts: [{ id: 'claude', cli: 'claude', label: '', today: null,
      limits: { session: { usedPct: 94, resetsAt: new Date(Date.now() + 3600000).toISOString() }, weekly: null } }] })
    await new Promise((r) => setTimeout(r, 500))

    const press = (k) => document.querySelector('[data-key="' + k + '"]').click()
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    for (let i = 0; i < 4; i++) { if (document.querySelector('.pet-yard')) break; press('c'); await wait(160) }
    for (let i = 0; i < 14; i++) {
      if (document.querySelector('.pet-ic.picked')?.dataset.ic === 'talk') break
      press('a')
      await wait(110)
    }
    press('b')
    await wait(300)
    const ask = async (q) => {
      const i = document.querySelector('.pet-ask input')
      if (!i) return null
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      set.call(i, q)
      i.dispatchEvent(new Event('input', { bubbles: true }))
      i.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await wait(350)
      return document.querySelector('.pet-balloon')?.textContent ?? null
    }
    const busy = await ask('지금 바빠?')
    const spokeOnPet = !!document.querySelector('.pet-yard')
    const limit = await ask('한도 남았어?')
    const dunno = await ask('ㅁㄴㅇㄹ')
    const size = parseFloat(getComputedStyle(document.querySelector('.pet-balloon')).fontSize)
    const noLog = document.querySelectorAll('.pet-said').length
    // Put the workspace back.
    __riven.roster.getState().patch(term, { busy: false })
    const api = __riven.getActiveApi()
    const p = api.getPanel(term)
    if (p) api.removePanel(p)
    press('c')
    await wait(250)
    return { busy, limit, dunno, spokeOnPet, size, noLog, closed: !document.querySelector('.pet-ask input'),
             picked: document.querySelector('.pet-ic.picked')?.dataset.ic ?? null,
             hadInput: !!document.querySelector('.pet-screen') }
  })()`)
  check(
    'answers what is running, and where',
    /1/.test(talk.busy ?? '') && /riven/.test(talk.busy ?? ''),
    String(talk.busy)
  )
  check(
    'answers how much of the plan is left',
    // The number is whatever the live account has left today, so the shape is
    // what is checked: a percentage, and when the window rolls over.
    /\d+%/.test(talk.limit ?? '') && /리셋|resets/.test(talk.limit ?? ''),
    String(talk.limit)
  )
  check(
    'says it in a balloon on the pet screen, not as a chat log',
    talk.spokeOnPet && talk.noLog === 0 && talk.size >= 10,
    `${talk.size}px · log lines: ${talk.noLog}`
  )
  check(
    'admits what it did not understand, and closes with C',
    !!talk.dunno && talk.dunno !== talk.busy && talk.closed,
    `${talk.dunno}`
  )

  // Hiding removes it; the status-bar button is how it comes back.
  const hidden = await cdp.eval(`(async () => {
    __riven.settings.getState().set({ petShow: false })
    await new Promise((r) => setTimeout(r, 300))
    const gone = !document.querySelector('.pet-device')
    const toggle = document.querySelector('.status-item.pet-toggle')
    toggle.click()
    await new Promise((r) => setTimeout(r, 400))
    return { gone, hadToggle: !!toggle, back: !!document.querySelector('.pet-device') }
  })()`)
  check(
    'hides, and the status-bar button brings it back',
    hidden.gone && hidden.hadToggle && hidden.back,
    JSON.stringify(hidden)
  )

  // Dragging it parks it somewhere else, and that survives a reload.
  const moved = await cdp.eval(`(async () => {
    const el = document.querySelector('.pet-device')
    el.setPointerCapture = () => {}
    el.releasePointerCapture = () => {}
    const r = el.getBoundingClientRect()
    const mk = (type, x, y) =>
      new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1,
                               isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y })
    el.dispatchEvent(mk('pointerdown', r.left + 40, r.top + 6))
    await new Promise((r2) => setTimeout(r2, 80))
    el.dispatchEvent(mk('pointermove', 300, 200))
    await new Promise((r2) => setTimeout(r2, 80))
    document.querySelector('.pet-device').dispatchEvent(mk('pointerup', 300, 200))
    await new Promise((r2) => setTimeout(r2, 250))
    const after = document.querySelector('.pet-device').getBoundingClientRect()
    return { from: Math.round(r.left), to: Math.round(after.left),
             saved: __riven.settings.getState().settings.petPos }
  })()`)
  check(
    'can be dragged anywhere and remembers where',
    moved.to !== moved.from && !!moved.saved,
    JSON.stringify(moved)
  )
  // Dragging must not go through React: re-rendering a hundred-odd sprite dots
  // per pointermove is exactly what made it feel like it was lagging behind.
  const smooth = await cdp.eval(`(async () => {
    const el = document.querySelector('.pet-device')
    el.setPointerCapture = () => {}
    el.releasePointerCapture = () => {}
    const firstDot = document.querySelector('.pet-lcd .pet-px')
    const r = el.getBoundingClientRect()
    const mk = (type, x, y) =>
      new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1,
                               isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y })
    el.dispatchEvent(mk('pointerdown', r.left + 40, r.top + 30))
    const t0 = performance.now()
    for (let i = 0; i < 40; i++) el.dispatchEvent(mk('pointermove', 320 + i * 3, 220 + i * 2))
    const ms = performance.now() - t0
    const reused = document.querySelector('.pet-lcd .pet-px') === firstDot
    el.dispatchEvent(mk('pointerup', 320 + 39 * 3, 220 + 39 * 2))
    await new Promise((r2) => setTimeout(r2, 300))
    return { perMove: +(ms / 40).toFixed(2), reused }
  })()`)
  // A drag that never heard the release used to stay armed, and after that the
  // pet fled from the pointer. It has to end on a release ANYWHERE, on a move
  // with no button held, and on the window losing focus.
  const released = await cdp.eval(`(async () => {
    const el = () => document.querySelector('.pet-device')
    const at = () => { const r = el().getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)] }
    const mk = (type, x, y, buttons = 1) =>
      new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1,
                               isPrimary: true, button: 0, buttons, clientX: x, clientY: y })
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const flees = async (release) => {
      const s = at()
      el().dispatchEvent(mk('pointerdown', s[0] + 40, s[1] + 40))
      window.dispatchEvent(mk('pointermove', s[0] + 90, s[1] + 90))
      await wait(60)
      await release()
      const before = at()
      window.dispatchEvent(mk('pointermove', before[0] + 40, before[1] + 40, 0))
      await wait(120)
      const after = at()
      return before[0] !== after[0] || before[1] !== after[1]
    }
    const elsewhere = await flees(async () => { document.body.dispatchEvent(mk('pointerup', 900, 900, 0)) })
    const noButton = await flees(async () => { window.dispatchEvent(mk('pointermove', 500, 500, 0)) })
    const blurred = await flees(async () => { window.dispatchEvent(new Event('blur')) })
    return { elsewhere, noButton, blurred }
  })()`)
  check(
    'a drag ends even when the release goes missing',
    !released.elsewhere && !released.noButton && !released.blurred,
    JSON.stringify(released)
  )

  // The point you grabbed stays under the pointer, re-renders and all.
  const stuck = await cdp.eval(`(async () => {
    const el = () => document.querySelector('.pet-device')
    const mk = (type, x, y, buttons = 1) =>
      new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1,
                               isPrimary: true, button: 0, buttons, clientX: x, clientY: y })
    const r0 = el().getBoundingClientRect()
    const grab = { x: r0.left + 60, y: r0.top + 50 }
    el().dispatchEvent(mk('pointerdown', grab.x, grab.y))
    let worst = 0
    for (let i = 1; i <= 24; i++) {
      const cx = grab.x + i * 7
      const cy = grab.y + i * 5
      window.dispatchEvent(mk('pointermove', cx, cy))
      if (i % 8 === 0) {
        // Re-render mid-drag, as a tick or a roster change would.
        const s = __riven.pet
        s.setState({ pet: { ...s.getState().pet, mood: (s.getState().pet.mood + 1) % 100 } })
        await new Promise((r) => setTimeout(r, 40))
        const r = el().getBoundingClientRect()
        worst = Math.max(worst, Math.abs(cx - r.left - 60), Math.abs(cy - r.top - 50))
      }
    }
    window.dispatchEvent(mk('pointerup', 0, 0, 0))
    await new Promise((r) => setTimeout(r, 200))
    return worst
  })()`)
  check('the point you grabbed stays under the pointer', stuck <= 1, `worst drift: ${stuck}px`)

  check(
    'dragging moves the node without rebuilding the sprite',
    smooth.reused && smooth.perMove < 2,
    `${smooth.perMove}ms per move, sprite reused: ${smooth.reused}`
  )

  // Persistence: the debounced save has to reach pet.json.
  await cdp.eval(`__riven.pet.getState().rename('스모크')`)
  await sleep(2500) // debounce + a hidden window's throttled timers
  const saved = await cdp.eval(
    `window.api.config.load('pet.json').then(o => JSON.stringify({ name: o && o.name, xp: o && o.xp }))`
  )
  check('state persists to pet.json', /"name":"스모크"/.test(saved), saved)

  // Put the window's real visibility back.
  await cdp.eval(`delete document.visibilityState`)

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
