// tasks — your task lists on your pod. Same functionality as the losos todo
// (multiple lists, add / complete / edit / delete, filter tabs, and "Move to…"
// a task between lists) but on the SolidOS wf:Tracker model — pilot-compatible:
// one JSON-LD file per list under /public/tracker/, with an embedded issue:[]
// of ical:Vtodo items. So it interoperates with pilot and your trackers.

const appEl = document.getElementById('app')
const TRACKERS = new URL('../../tracker/', location.href) // <pod>/public/tracker/

const authFetch = (url, opts) => ((window.xlogin && window.xlogin.authFetch) || fetch)(url, opts)
const loggedIn = () => !!(window.xlogin && window.xlogin.id)
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const nowIso = () => new Date().toISOString()

const CONTEXT = {
  ical: 'http://www.w3.org/2002/12/cal/ical#', wf: 'http://www.w3.org/2005/01/wf/flow#', dct: 'http://purl.org/dc/terms/',
  summary: 'ical:summary', status: 'ical:status', created: 'dct:created', modified: 'ical:lastModified',
  title: 'dct:title', initialState: 'wf:initialState', issue: 'wf:issue', Tracker: 'wf:Tracker', Vtodo: 'ical:Vtodo'
}
const issuesOf = (d) => (d && (Array.isArray(d.issue) ? d.issue : (d.issue ? [d.issue] : []))) || []
const isDone = (it) => it.status === 'COMPLETED'

function ldpContains(doc) {
  const c = doc['ldp:contains'] || doc['http://www.w3.org/ns/ldp#contains'] || doc.contains || []
  return (Array.isArray(c) ? c : [c]).map((x) => (typeof x === 'string' ? x : x['@id'] || x.id)).filter(Boolean)
}

// --- pod I/O ---
async function listTrackers() {
  const r = await authFetch(TRACKERS, { headers: { Accept: 'application/ld+json' } })
  if (!r.ok) return []
  const urls = ldpContains(await r.json()).map((u) => new URL(u, TRACKERS).href).filter((u) => u.endsWith('.jsonld'))
  const out = []
  for (const u of urls) {
    try { const dr = await authFetch(u, { headers: { Accept: 'application/ld+json' } }); if (dr.ok) out.push({ url: u, doc: await dr.json() }) } catch { /* skip */ }
  }
  out.sort((a, b) => (a.doc.title || '').localeCompare(b.doc.title || ''))
  return out
}
async function loadDoc(url) { const r = await authFetch(url, { headers: { Accept: 'application/ld+json' } }); return r.ok ? r.json() : null }
async function saveDoc(url, doc) {
  const put = () => authFetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, body: JSON.stringify(doc, null, 2) })
  let r = await put()
  if (!r.ok && (r.status === 404 || r.status === 409)) {
    await authFetch(TRACKERS, { method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, body: '' }).catch(() => {})
    r = await put()
  }
  if (!r.ok) throw new Error(`save failed (${r.status})`)
  markSelfWrite(url)
}
async function createTracker(name) {
  const slug = name.toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'list'
  const url = new URL(slug + '-data.jsonld', TRACKERS).href
  await saveDoc(url, { '@context': CONTEXT, '@id': '#this', '@type': 'Tracker', title: name, created: nowIso(), initialState: 'NEEDS-ACTION', issue: [] })
  return url
}
function newIssue(text, doc) {
  return { '@id': '#Iss' + Date.now(), '@type': issuesOf(doc)[0]?.['@type'] || 'Vtodo', summary: text, status: doc.initialState || 'NEEDS-ACTION', created: nowIso(), modified: nowIso() }
}

// --- import from another pod -----------------------------------------------
// Reads a source URL (a single list, a lists index, or a container), normalizes
// the losos schema:ItemList AND wf:Tracker shapes into our wf:Tracker, and
// writes each into this pod's /public/tracker/ (snapshot copy; public sources).
const sList = (d) => Array.isArray(d) ? d : (d ? [d] : [])
async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/ld+json' } })  // cross-origin, public
  if (!r.ok) throw new Error(`fetch ${url.split('/').pop()} → ${r.status}`)
  return r.json()
}
const srcItems = (doc) => doc.issue ? issuesOf(doc) : sList(doc['schema:itemListElement'] || doc.itemListElement || doc['https://schema.org/itemListElement'])
const srcTitle = (doc, fb) => doc.title || doc['dct:title'] || doc['schema:name'] || doc.name || doc['http://purl.org/dc/terms/title'] || fb || 'Imported'
const itemText = (it) => it.summary || it['schema:name'] || it.name || it['ical:summary'] || it['http://schema.org/name'] || '(untitled)'
const itemDone = (it) => ('' + (it.status || it['schema:status'] || it['ical:status'] || '')).toUpperCase().includes('COMPLETED')
const itemCreated = (it) => it.created || it['schema:dateCreated'] || it.dateCreated || it['dct:created'] || nowIso()

function toTracker(srcDoc, title) {
  const issue = srcItems(srcDoc).map((it, i) => ({
    '@id': '#Iss' + (Date.now() + i), '@type': 'Vtodo',
    summary: '' + itemText(it), status: itemDone(it) ? 'COMPLETED' : 'NEEDS-ACTION',
    created: '' + itemCreated(it), modified: nowIso()
  }))
  return { '@context': CONTEXT, '@id': '#this', '@type': 'Tracker', title, created: nowIso(), initialState: 'NEEDS-ACTION', issue }
}

async function collectLists(srcUrl, doc) {
  const parts = sList(doc['schema:hasPart'] || doc.hasPart)  // a lists index (CollectionPage)
  if (parts.length) {
    const out = []
    for (const p of parts) {
      const u = ((p['@id'] || p.id || '').split('#')[0]) || (p['schema:url'] || p.url ? new URL(p['schema:url'] || p.url, srcUrl).href : '')
      if (!u) continue
      try { out.push({ title: p['schema:name'] || p.name, doc: await fetchJson(u) }) } catch { /* skip */ }
    }
    return out
  }
  if (doc['ldp:contains'] || doc['http://www.w3.org/ns/ldp#contains'] || doc.contains) {  // a container
    const out = []
    for (const u of ldpContains(doc).map((x) => new URL(x, srcUrl).href).filter((x) => x.endsWith('.jsonld'))) {
      try { out.push({ title: null, doc: await fetchJson(u) }) } catch { /* skip */ }
    }
    return out
  }
  return [{ title: null, doc }]  // a single list
}

const slugify = (s) => ('' + (s || 'imported')).toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'imported'
function uniqueSlug(base, taken) { let s = base, i = 2; while (taken.has(s)) s = `${base}-${i++}`; return s }

async function importFrom(srcUrl) {
  const clean = srcUrl.replace(/#.*$/, '')
  const lists = await collectLists(clean, await fetchJson(clean))
  const taken = new Set((await listTrackers()).map((t) => t.url.split('/').pop().replace(/-data\.jsonld$/, '')))
  let nLists = 0, nTasks = 0
  for (const l of lists) {
    const title = srcTitle(l.doc, l.title)
    const tracker = toTracker(l.doc, title)
    const slug = uniqueSlug(slugify(title), taken); taken.add(slug)
    await saveDoc(new URL(slug + '-data.jsonld', TRACKERS).href, tracker)
    nLists++; nTasks += tracker.issue.length
  }
  return { lists: nLists, tasks: nTasks }
}

// --- state ---
let ALL = []        // [{url, doc}] — all lists, for the picker + move targets
let OPEN = null     // current list url
let DOC = null      // current list doc (optimistic)
let FILTER = localStorage.getItem('filter') || 'all'  // all | active | done

function toast(msg) {
  let t = document.querySelector('.toast')
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t) }
  t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2200)
}

const trackerRel = (u) => (u && u.startsWith(TRACKERS.href) ? u.slice(TRACKERS.href.length) : u)  // store short, pod-relative
const trackerAbs = (p) => (p ? new URL(p, TRACKERS).href : null)
function trackerFromUrl() { return trackerAbs(new URLSearchParams(location.search).get('tracker')) }
function openTracker(url, doc) {
  OPEN = url; DOC = doc || null
  history.pushState({}, '', url ? '?tracker=' + encodeURIComponent(trackerRel(url)) : location.pathname)
  render()
}

async function render() {
  if (!loggedIn()) { appEl.innerHTML = '<h1>Tasks</h1><div class="signin-note">Sign in (login pill, bottom-right) to read and edit your lists.</div>'; return }
  if (OPEN) await renderTasks()
  else await renderLists()
  syncSubs()
}

async function renderLists() {
  appEl.innerHTML = '<h1>Tasks</h1><p class="sub muted">Loading…</p>'
  try { ALL = await listTrackers() } catch { ALL = [] }
  appEl.innerHTML = `
    <h1>Tasks</h1>
    <p class="sub">${ALL.length} list${ALL.length === 1 ? '' : 's'}</p>
    <div class="toolbar"><button class="new">+ New list</button><button class="imp ghost">Import…</button></div>
    <div class="lists"></div>`
  appEl.querySelector('.new').onclick = async () => {
    const name = prompt('New list name?'); if (!name) return
    try { openTracker(await createTracker(name), null) } catch (e) { toast(String(e.message || e)) }
  }
  appEl.querySelector('.imp').onclick = async () => {
    const url = prompt('Import lists from another pod.\nPaste a URL to a list, a lists index, or a /todo/ or /public/tracker/ container:')
    if (!url) return
    toast('Importing…')
    try { const r = await importFrom(url.trim()); toast(`Imported ${r.lists} list${r.lists === 1 ? '' : 's'} · ${r.tasks} tasks`); render() }
    catch (e) { toast('Import failed: ' + (e.message || e)) }
  }
  const list = appEl.querySelector('.lists')
  if (!ALL.length) { list.innerHTML = '<p class="muted">No lists yet — create one.</p>'; return }
  ALL.forEach((t) => {
    const open = issuesOf(t.doc).filter((i) => !isDone(i)).length
    const row = document.createElement('div')
    row.className = 'card listrow'
    row.innerHTML = `<span class="l-name">${esc(t.doc.title || t.url.split('/').pop())}</span><span class="l-count">${open}</span>`
    row.onclick = () => openTracker(t.url, t.doc)
    list.appendChild(row)
  })
}

async function renderTasks() {
  if (!DOC) DOC = await loadDoc(OPEN)
  if (!DOC) { appEl.innerHTML = '<h1>Tasks</h1><p class="muted">Could not load list.</p>'; OPEN = null; return }
  if (!ALL.length) listTrackers().then((a) => { ALL = a }).catch(() => {})  // deep-link: populate move targets in bg
  const issues = issuesOf(DOC)
  const counts = { all: issues.length, active: issues.filter((i) => !isDone(i)).length, done: issues.filter(isDone).length }
  const save = async () => { try { await saveDoc(OPEN, DOC); const c = ALL.find((t) => t.url === OPEN); if (c) c.doc = DOC } catch (e) { toast(String(e.message || e)) } }

  appEl.innerHTML = `
    <div class="thead"><button class="back ghost">←</button><h1>${esc(DOC.title || 'List')}</h1></div>
    <div class="add-row"><input class="add-task" placeholder="Add a task…"><button class="add-btn">Add</button></div>
    <div class="filters">
      ${['all', 'active', 'done'].map((f) => `<button class="filter ${FILTER === f ? 'active' : ''}" data-f="${f}">${f[0].toUpperCase() + f.slice(1)} <span class="fc">${counts[f]}</span></button>`).join('')}
    </div>
    <div class="issues"></div>`
  appEl.querySelector('.back').onclick = () => openTracker(null)
  appEl.querySelectorAll('.filter').forEach((b) => { b.onclick = () => { FILTER = b.dataset.f; localStorage.setItem('filter', FILTER); renderTasks() } })

  const input = appEl.querySelector('.add-task')
  const add = async () => { const v = input.value.trim(); if (!v) return; DOC.issue = [...issues, newIssue(v, DOC)]; input.value = ''; await save(); renderTasks() }
  appEl.querySelector('.add-btn').onclick = add
  input.onkeydown = (e) => { if (e.key === 'Enter') add() }

  const shown = (FILTER === 'all' ? issues : issues.filter((i) => FILTER === 'done' ? isDone(i) : !isDone(i))).slice().reverse()
  const box = appEl.querySelector('.issues')
  if (!shown.length) { box.innerHTML = `<p class="muted">${counts.all ? 'Nothing here.' : 'No tasks yet. Add one above.'}</p>`; return }
  shown.forEach((it) => {
    const el = document.createElement('div')
    el.className = 'issue' + (isDone(it) ? ' done' : '')
    el.innerHTML = `<span class="check">${isDone(it) ? '✓' : ''}</span><span class="summary">${esc(it.summary || '')}</span>
      <button class="top ghost" title="Move to top">↑</button><button class="mv ghost" title="Move to another list">→</button><button class="x ghost" title="Delete">×</button>`
    el.querySelector('.check').onclick = async () => { it.status = isDone(it) ? 'NEEDS-ACTION' : 'COMPLETED'; it.modified = nowIso(); await save(); renderTasks() }
    el.querySelector('.summary').onclick = async () => { const v = prompt('Edit task', it.summary); if (v == null) return; it.summary = v.trim(); it.modified = nowIso(); await save(); renderTasks() }
    el.querySelector('.top').onclick = async () => { DOC.issue = [...issues.filter((x) => x['@id'] !== it['@id']), it]; it.modified = nowIso(); await save(); renderTasks() }
    el.querySelector('.x').onclick = async () => { DOC.issue = issues.filter((x) => x['@id'] !== it['@id']); await save(); renderTasks() }
    el.querySelector('.mv').onclick = () => moveDialog(it)
    box.appendChild(el)
  })
}

// "Move to…" — list the other lists; moving removes from this list and appends
// to the chosen one (both files saved).
function moveDialog(item) {
  const targets = ALL.filter((t) => t.url !== OPEN)
  const ov = document.createElement('div'); ov.className = 'move-overlay'
  ov.innerHTML = `<div class="move-modal"><div class="move-title">Move to…</div>${targets.length
    ? targets.map((t) => `<button class="move-opt" data-url="${esc(t.url)}">${esc(t.doc.title || t.url.split('/').pop())}</button>`).join('')
    : '<p class="muted" style="padding:4px 0">No other list. Create one first.</p>'}</div>`
  document.body.appendChild(ov)
  ov.onclick = (e) => { if (e.target === ov) ov.remove() }
  ov.querySelectorAll('.move-opt').forEach((b) => { b.onclick = () => { ov.remove(); moveItem(item, b.dataset.url) } })
}
async function moveItem(item, targetUrl) {
  try {
    DOC.issue = issuesOf(DOC).filter((x) => x['@id'] !== item['@id'])
    await saveDoc(OPEN, DOC)
    const tdoc = await loadDoc(targetUrl)
    if (!tdoc) throw new Error('target not found')
    tdoc.issue = [...issuesOf(tdoc), { ...item, modified: nowIso() }]
    await saveDoc(targetUrl, tdoc)
    const tc = ALL.find((t) => t.url === targetUrl); if (tc) tc.doc = tdoc
    const cc = ALL.find((t) => t.url === OPEN); if (cc) cc.doc = DOC
    toast('moved'); renderTasks()
  } catch (e) { toast(String(e.message || e)); DOC = await loadDoc(OPEN); renderTasks() }
}

// --- live updates: Solid WebSocket notifications (solid-0.1) ----------------
// When another client (e.g. an AI agent writing to the pod) changes a tracker,
// the pod pushes `pub <uri>` over ws://<pod>/.notifications; we reload the
// affected view in place — no manual refresh. Tracker data is public, so the
// browser WS (which can't send an auth header) subscribes fine.
const SELF_WRITES = {}                          // url -> ts; ignore our own write-echo
let LIVE = null, SUBBED = new Set()
const liveHref = (u) => (typeof u === 'string' ? u : u.href)
function markSelfWrite(url) { SELF_WRITES[liveHref(url)] = Date.now() }
function wsEndpoint() { return (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/.notifications' }
function liveSub(u) { const url = liveHref(u); if (!LIVE || LIVE.readyState !== 1 || SUBBED.has(url)) return; LIVE.send('sub ' + url); SUBBED.add(url) }
function liveUnsub(u) { const url = liveHref(u); if (!LIVE || LIVE.readyState !== 1 || !SUBBED.has(url)) return; LIVE.send('unsub ' + url); SUBBED.delete(url) }
function syncSubs() {
  if (!LIVE || LIVE.readyState !== 1) return
  liveSub(TRACKERS)                             // always watch the list of lists
  const open = OPEN ? liveHref(OPEN) : null
  for (const u of [...SUBBED]) if (u !== liveHref(TRACKERS) && u !== open) liveUnsub(u)
  if (open) liveSub(open)                        // and the open list's doc
}
function onPub(uri) {
  if (SELF_WRITES[uri] && Date.now() - SELF_WRITES[uri] < 2500) return   // our own write
  if (OPEN && uri === liveHref(OPEN)) reloadOpen()
  else if (uri === liveHref(TRACKERS) && !OPEN) renderLists()
}
async function reloadOpen() {
  const at = OPEN
  const fresh = await loadDoc(at)
  if (!fresh || OPEN !== at) return             // navigated away while loading
  DOC = fresh
  const c = ALL.find((t) => t.url === at); if (c) c.doc = fresh
  const inp = appEl.querySelector('.add-task'); const kept = inp ? inp.value : null
  const had = inp && document.activeElement === inp
  await renderTasks()
  if (kept != null) { const ni = appEl.querySelector('.add-task'); if (ni) { ni.value = kept; if (had) { ni.focus(); ni.selectionStart = ni.selectionEnd = kept.length } } }
}
function connectLive() {
  let ws
  try { ws = new WebSocket(wsEndpoint()) } catch { return }
  LIVE = ws
  ws.onopen = () => { SUBBED = new Set(); syncSubs() }
  ws.onmessage = (e) => { const m = String(e.data || ''); if (m.startsWith('pub ')) onPub(m.slice(4).trim()) }
  ws.onerror = () => { try { ws.close() } catch { /* noop */ } }
  ws.onclose = () => { LIVE = null; SUBBED = new Set(); setTimeout(connectLive, 3000) }
}

connectLive()
OPEN = trackerFromUrl()
render()
window.addEventListener('popstate', () => { OPEN = trackerFromUrl(); DOC = null; render() })
document.addEventListener('xlogin', render)
document.addEventListener('xlogout', render)
