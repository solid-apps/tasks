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

// --- state ---
let ALL = []        // [{url, doc}] — all lists, for the picker + move targets
let OPEN = null     // current list url
let DOC = null      // current list doc (optimistic)
let FILTER = 'all'  // all | active | done

function toast(msg) {
  let t = document.querySelector('.toast')
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t) }
  t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2200)
}

async function render() {
  if (!loggedIn()) { appEl.innerHTML = '<h1>Tasks</h1><div class="signin-note">Sign in (login pill, bottom-right) to read and edit your lists.</div>'; return }
  if (OPEN) await renderTasks()
  else await renderLists()
}

async function renderLists() {
  appEl.innerHTML = '<h1>Tasks</h1><p class="sub muted">Loading…</p>'
  try { ALL = await listTrackers() } catch { ALL = [] }
  appEl.innerHTML = `
    <h1>Tasks</h1>
    <p class="sub">${ALL.length} list${ALL.length === 1 ? '' : 's'}</p>
    <div class="toolbar"><button class="new">+ New list</button></div>
    <div class="lists"></div>`
  appEl.querySelector('.new').onclick = async () => {
    const name = prompt('New list name?'); if (!name) return
    try { OPEN = await createTracker(name); DOC = null; render() } catch (e) { toast(String(e.message || e)) }
  }
  const list = appEl.querySelector('.lists')
  if (!ALL.length) { list.innerHTML = '<p class="muted">No lists yet — create one.</p>'; return }
  ALL.forEach((t) => {
    const open = issuesOf(t.doc).filter((i) => !isDone(i)).length
    const row = document.createElement('div')
    row.className = 'card listrow'
    row.innerHTML = `<span class="l-name">${esc(t.doc.title || t.url.split('/').pop())}</span><span class="l-count">${open}</span>`
    row.onclick = () => { OPEN = t.url; DOC = t.doc; FILTER = 'all'; render() }
    list.appendChild(row)
  })
}

async function renderTasks() {
  if (!DOC) DOC = await loadDoc(OPEN)
  if (!DOC) { appEl.innerHTML = '<h1>Tasks</h1><p class="muted">Could not load list.</p>'; OPEN = null; return }
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
  appEl.querySelector('.back').onclick = () => { OPEN = null; DOC = null; render() }
  appEl.querySelectorAll('.filter').forEach((b) => { b.onclick = () => { FILTER = b.dataset.f; renderTasks() } })

  const input = appEl.querySelector('.add-task')
  const add = async () => { const v = input.value.trim(); if (!v) return; DOC.issue = [...issues, newIssue(v, DOC)]; input.value = ''; await save(); renderTasks() }
  appEl.querySelector('.add-btn').onclick = add
  input.onkeydown = (e) => { if (e.key === 'Enter') add() }

  const shown = FILTER === 'all' ? issues : issues.filter((i) => FILTER === 'done' ? isDone(i) : !isDone(i))
  const box = appEl.querySelector('.issues')
  if (!shown.length) { box.innerHTML = `<p class="muted">${counts.all ? 'Nothing here.' : 'No tasks yet. Add one above.'}</p>`; return }
  shown.forEach((it) => {
    const el = document.createElement('div')
    el.className = 'issue' + (isDone(it) ? ' done' : '')
    el.innerHTML = `<span class="check">${isDone(it) ? '✓' : ''}</span><span class="summary">${esc(it.summary || '')}</span>
      <button class="mv ghost" title="Move to another list">→</button><button class="x ghost" title="Delete">×</button>`
    el.querySelector('.check').onclick = async () => { it.status = isDone(it) ? 'NEEDS-ACTION' : 'COMPLETED'; it.modified = nowIso(); await save(); renderTasks() }
    el.querySelector('.summary').onclick = async () => { const v = prompt('Edit task', it.summary); if (v == null) return; it.summary = v.trim(); it.modified = nowIso(); await save(); renderTasks() }
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

render()
document.addEventListener('xlogin', render)
document.addEventListener('xlogout', render)
