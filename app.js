// MAKO CABINETS — Kitchen CRM
// Backend: Supabase (auth + Postgres + RLS + realtime)
// Routing: hash-based.

import * as db from './db.js';
import { supabase } from './db.js';

// ----- Constants -----

const LEAD_STAGES = [
  { id: 'lead',   label: 'New Lead',     customer: 'Inquiry received' },
  { id: 'quoted', label: 'Quote Sent',   customer: 'Quote sent' },
];

const ACTIVE_STAGES = [
  { id: 'dealClosed', label: 'Deal Closed',        customer: 'Order confirmed' },
  { id: 'deposit',    label: 'Deposit Received',   customer: 'Deposit received' },
  { id: 'specSigned', label: 'Plans Approved',     customer: 'Plans & spec approved' },
  { id: 'production', label: 'In Production',      customer: 'In production' },
  { id: 'delivery',   label: 'Delivery Scheduled', customer: 'Delivery scheduled' },
  { id: 'installed',  label: 'Installed',          customer: 'Kitchen installed' },
  { id: 'stone',      label: 'Stone Installed',    customer: 'Stone installed' },
  { id: 'completed',  label: 'Completed',          customer: 'Project completed' },
];

const ALL_STAGES = [...LEAD_STAGES, ...ACTIVE_STAGES];

function stageIndexOf(stageId) {
  return ALL_STAGES.findIndex(s => s.id === stageId);
}
function stageDef(stageId) {
  return ALL_STAGES.find(s => s.id === stageId) || ALL_STAGES[0];
}
function stagePhase(stageId) {
  if (LEAD_STAGES.some(s => s.id === stageId)) return 'lead';
  if (stageId === 'completed') return 'completed';
  return 'active';
}

const ROLES = {
  admin:        { label: 'Admin',        perms: ['*'] },
  sales:        { label: 'Sales',        perms: ['leads', 'projects', 'customers', 'tasks.assigned', 'files'] },
  production:   { label: 'Production',   perms: ['projects.read', 'production', 'tasks.assigned', 'files'] },
  installation: { label: 'Installation', perms: ['projects.read', 'installation', 'tasks.assigned', 'files'] },
  service:      { label: 'Service',      perms: ['projects.read', 'service', 'tasks.assigned', 'files'] },
};

const PRIORITIES = [
  { id: 'urgent', label: 'Urgent', tag: 'danger', sort: 0 },
  { id: 'high',   label: 'High',   tag: 'warn',   sort: 1 },
  { id: 'normal', label: 'Normal', tag: '',       sort: 2 },
  { id: 'low',    label: 'Low',    tag: 'dim',    sort: 3 },
];
function priorityDef(id) {
  return PRIORITIES.find(p => p.id === id) || PRIORITIES.find(p => p.id === 'normal');
}

// ----- Storage layer (Supabase-backed; in-memory cache for renders) -----

// Dirty tracking: any property mutation on a wrapped entity adds its id to _dirty[table].
// saveStore() flushes those entities to the DB.
const _dirty = { customers: new Set(), projects: new Set(), tasks: new Set() };
const _entityTable = new WeakMap();

function trackedEntity(table, obj) {
  if (!obj || typeof obj !== 'object') return obj;
  _entityTable.set(obj, table);
  return new Proxy(obj, {
    set(t, k, v) {
      const ok = Reflect.set(t, k, v);
      if (t.id) _dirty[table].add(t.id);
      return ok;
    },
    get(t, k) {
      const v = Reflect.get(t, k);
      if (v && typeof v === 'object' && k !== '__raw') {
        // Wrap nested objects/arrays to bubble mutations up.
        return nestedProxy(v, table, t.id);
      }
      return v;
    },
  });
}

function nestedProxy(obj, table, id) {
  if (!obj || typeof obj !== 'object') return obj;
  return new Proxy(obj, {
    set(t, k, v) {
      const ok = Reflect.set(t, k, v);
      if (id) _dirty[table].add(id);
      return ok;
    },
    deleteProperty(t, k) {
      const ok = Reflect.deleteProperty(t, k);
      if (id) _dirty[table].add(id);
      return ok;
    },
    get(t, k) {
      const v = Reflect.get(t, k);
      if (Array.isArray(t) && typeof v === 'function' && ['push','pop','splice','shift','unshift','sort','reverse'].includes(k)) {
        return (...args) => {
          const r = v.apply(t, args);
          if (id) _dirty[table].add(id);
          return r;
        };
      }
      if (v && typeof v === 'object') return nestedProxy(v, table, id);
      return v;
    },
  });
}

function trackedArray(table, arr) {
  // Wrap a top-level array (state.store.customers, .projects, .tasks) so:
  //  - push(newRow) wraps the row and marks it dirty
  //  - splice removals are NOT auto-deleted in DB (we use explicit db.*.remove)
  return new Proxy(arr, {
    get(t, k) {
      const v = Reflect.get(t, k);
      if (k === 'push') {
        return (...rows) => {
          const wrapped = rows.map(r => {
            const w = trackedEntity(table, r);
            if (r.id) _dirty[table].add(r.id);
            return w;
          });
          return Array.prototype.push.apply(t, wrapped);
        };
      }
      return v;
    },
  });
}

async function loadAll() {
  const [profiles, customers, projects, tasks] = await Promise.all([
    db.profiles.list(),
    db.customers.list(),
    db.projects.list(),
    db.tasks.list(),
  ]);
  _dirty.customers.clear(); _dirty.projects.clear(); _dirty.tasks.clear();
  state.store = {
    schemaVersion: 3,
    users: profiles,
    customers: trackedArray('customers', customers.map(c => trackedEntity('customers', c))),
    projects: trackedArray('projects', projects.map(p => trackedEntity('projects', p))),
    tasks: trackedArray('tasks', tasks.map(t => trackedEntity('tasks', t))),
    activity: [],          // loaded per-project on demand
    filesByProject: {},    // loaded per-project on demand
    activityByProject: {}, // loaded per-project on demand
    settings: { businessName: 'MAKO CABINETS', currency: 'USD' },
  };
}

// Explicit create/delete helpers (proxy can't intercept async DB calls cleanly)
async function addCustomer(obj) {
  const c = await db.customers.create(obj);
  const w = trackedEntity('customers', c);
  state.store.customers.unshift(w);
  return w;
}
async function addProject(obj) {
  const p = await db.projects.create(obj);
  const w = trackedEntity('projects', p);
  state.store.projects.unshift(w);
  return w;
}
async function addTask(obj) {
  const t = await db.tasks.create(obj);
  const w = trackedEntity('tasks', t);
  state.store.tasks.unshift(w);
  return w;
}
async function removeProject(id) {
  await db.projects.remove(id);
  state.store.projects = trackedArray('projects', state.store.projects.filter(p => p.id !== id));
}
async function removeCustomer(id) {
  await db.customers.remove(id);
  state.store.customers = trackedArray('customers', state.store.customers.filter(c => c.id !== id));
}
async function removeTask(id) {
  await db.tasks.remove(id);
  state.store.tasks = trackedArray('tasks', state.store.tasks.filter(t => t.id !== id));
}

// Persist locally-mutated entities to Supabase. Fire-and-forget; renders use optimistic local state.
function saveStore() {
  const tasks = [];
  for (const id of _dirty.customers) {
    const c = state.store.customers.find(x => x.id === id);
    if (c) tasks.push(db.customers.update(id, c).catch(e => console.error('customer save', e)));
  }
  for (const id of _dirty.projects) {
    const p = state.store.projects.find(x => x.id === id);
    if (p) tasks.push(db.projects.update(id, p).catch(e => console.error('project save', e)));
  }
  for (const id of _dirty.tasks) {
    const t = state.store.tasks.find(x => x.id === id);
    if (t) tasks.push(db.tasks.update(id, t).catch(e => console.error('task save', e)));
  }
  _dirty.customers.clear(); _dirty.projects.clear(); _dirty.tasks.clear();
  return Promise.all(tasks);
}

// Wrap an async mutation with a re-render after success.
async function mutate(fn) {
  try {
    await fn();
    render();
  } catch (e) {
    console.error('mutation failed', e);
    toast('Error: ' + (e.message || 'failed'));
  }
}

function _seed_unused() {
  const adminId = uid();
  return {
    schemaVersion: 2,
    users: [
      { id: adminId,  username: 'admin',  password: 'admin',  name: 'Owner',          role: 'admin', active: true },
      { id: uid(),    username: 'sales1', password: 'sales1', name: 'Sales Rep',      role: 'sales', active: true },
      { id: uid(),    username: 'prod1',  password: 'prod1',  name: 'Production Mgr', role: 'production', active: true },
    ],
    customers: [],
    projects: [],
    tasks: [],
    activity: [],
    settings: { businessName: 'MAKO CABINETS', currency: 'USD' },
  };
}

function migrate(store) {
  if (store.schemaVersion === 2) return store;

  // v1 → v2: split monolithic customers into customers (contact) + projects (job)
  const oldStageMap = { approved: 'dealClosed' }; // any old "approved" stage rolls to "dealClosed"
  const customers = [];
  const projects = [];
  const idMap = {}; // oldCustomerId -> { customerId, projectId }

  for (const c of (store.customers || [])) {
    const customerId = c.id; // keep the id stable so activity links still work
    customers.push({
      id: customerId,
      name: c.name || '',
      phone: c.phone || '',
      email: c.email || '',
      generalAddress: c.address || '',
      notes: c.notes || '',
      createdAt: c.createdAt || new Date().toISOString(),
    });
    const stage = oldStageMap[c.stage] || c.stage || 'lead';
    const projId = uid();
    projects.push({
      id: projId,
      customerId,
      address: c.address || '',
      source: c.source || '',
      assignedTo: c.assignedTo || null,
      createdAt: c.createdAt || new Date().toISOString(),
      trackingToken: c.trackingToken || token(),
      stage,
      quote: c.quote || { amount: null, sentAt: null, validUntil: null, approvedAt: null },
      deposit: c.deposit || { amount: null, receivedAt: null },
      spec: c.spec || defaultSpec(),
      subProducts: c.subProducts || [],
      files: c.files || [],
      schedule: c.schedule || { productionStart: null, deliveryDate: null, installDate: null, stoneDate: null },
      signedSpecAt: c.signedSpecAt || null,
      serviceTickets: c.serviceTickets || [],
    });
    idMap[customerId] = { customerId, projectId: projId };
  }

  const tasks = (store.tasks || []).map(t => {
    const ref = t.customerId ? idMap[t.customerId] : null;
    return { ...t, projectId: ref?.projectId || t.projectId || null };
  });
  const activity = (store.activity || []).map(a => {
    const ref = a.customerId ? idMap[a.customerId] : null;
    return { ...a, projectId: ref?.projectId || a.projectId || null };
  });

  return {
    schemaVersion: 2,
    users: store.users || [],
    customers,
    projects,
    tasks,
    activity,
    settings: { ...(store.settings || {}), businessName: 'MAKO CABINETS', currency: 'USD' },
  };
}

function defaultSpec() {
  return {
    kitchen: { layout: '', cabinets: '', finish: '', color: '', dimensions: '', notes: '' },
    stone:   { required: false, type: '', color: '', edge: '', sqft: '', notes: '' },
    handles: '',
    appliances: '',
    otherAccessories: '',
  };
}

function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
function token() { return Math.random().toString(36).slice(2, 12); }

// ----- App state -----

const state = {
  store: null,
  session: null,
  route: { name: 'dashboard', params: {} },
};

function currentUser() {
  if (!state.session) return null;
  return state.store.users.find(u => u.id === state.session.userId);
}

// ----- Routing -----

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  if (!h) return { name: 'dashboard', params: {} };
  const parts = h.split(/[\/?]/);
  switch (parts[0]) {
    case 'dashboard': return { name: 'dashboard', params: {} };
    case 'leads':     return { name: 'leads', params: {} };
    case 'projects':  return parts[1] ? { name: 'project', params: { id: parts[1], tab: parts[2] || 'overview' } } : { name: 'projects', params: {} };
    case 'customers': return parts[1] ? { name: 'customer', params: { id: parts[1] } } : { name: 'customers', params: {} };
    case 'tasks':     return { name: 'tasks', params: {} };
    case 'users':     return { name: 'users', params: {} };
    case 'track':     return { name: 'track', params: { token: parts[1] } };
    default:          return { name: 'dashboard', params: {} };
  }
}
function navigate(path) { location.hash = '#/' + path; }
window.addEventListener('hashchange', () => {
  state.route = parseHash();
  render();
});

// ----- Activity log -----

function logActivity(projectId, message) {
  // Fire-and-forget. Errors are logged but don't block the user action.
  db.activity.log(projectId, message);
  // Cache the entry locally so the Activity tab shows it immediately without re-fetch.
  if (!state.store.activityByProject[projectId]) state.store.activityByProject[projectId] = [];
  state.store.activityByProject[projectId].unshift({
    id: 'local-' + Math.random().toString(36).slice(2),
    project_id: projectId,
    user_id: state.session?.userId,
    action: message,
    created_at: new Date().toISOString(),
  });
}

// ----- Helpers for project/customer -----

function customerOf(project) { return state.store.customers.find(c => c.id === project.customerId); }
function projectsOfCustomer(cid) { return state.store.projects.filter(p => p.customerId === cid); }
function projectLabel(p) {
  const c = customerOf(p);
  return (c?.name || 'Customer') + ' · ' + (p.address || 'no address');
}

function setStage(p, stageId, opts = {}) {
  if (p.stage === stageId) return;
  p.stage = stageId;
  logActivity(p.id, `Stage set to "${stageDef(stageId).label}"` + (opts.note ? ` (${opts.note})` : ''));
}

// ----- Rendering core -----

const $app = document.getElementById('app');
const $modalRoot = document.getElementById('modal-root');
const $toastRoot = document.getElementById('toast-root');

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v);
  }
  const arr = Array.isArray(children) ? children : [children];
  for (const c of arr) {
    if (c === null || c === undefined || c === false) continue;
    if (typeof c === 'string' || typeof c === 'number') el.appendChild(document.createTextNode(c));
    else el.appendChild(c);
  }
  return el;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

const ICONS = {
  dashboard:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  leads:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v3M4 7l2 2M20 7l-2 2"/><path d="M12 7a6 6 0 0 0-3 11l1 1v2h4v-2l1-1a6 6 0 0 0-3-11Z"/></svg>',
  projects:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V8l5-3 5 3v13"/><path d="M15 21v-7h4v7"/><path d="M9 14h2"/></svg>',
  customers:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="10" r="2.6"/><path d="M14.5 19a4.5 4.5 0 0 1 6.5-4"/></svg>',
  tasks:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 10l2.5 2.5L15 8"/><path d="M8 16h8"/></svg>',
  users:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 6v6c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/></svg>',
  plus:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  arrowRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  inbox:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13l3-8h12l3 8"/><path d="M3 13v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6"/><path d="M3 13h5l1.5 2h5L16 13h5"/></svg>',
  dollar:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M16 7H10a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6H8"/></svg>',
  calendar:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  spark:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.7 4.6L18 9l-4.3 1.4L12 15l-1.7-4.6L6 9l4.3-1.4L12 3Z"/><path d="M19 16l.7 1.8L21 18l-1.3.4L19 20l-.7-1.6L17 18l1.3-.2L19 16Z"/></svg>',
};

function icon(name, cls = 'ico') {
  const span = document.createElement('span');
  span.className = cls;
  span.innerHTML = ICONS[name] || '';
  span.setAttribute('aria-hidden', 'true');
  return span;
}

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]).join('').toUpperCase();
}

function toast(msg) {
  clear($toastRoot);
  const el = h('div', { class: 'toast' }, [msg]);
  $toastRoot.appendChild(el);
  setTimeout(() => { if (el.parentNode === $toastRoot) $toastRoot.removeChild(el); }, 2400);
}

function modal(opts) {
  clear($modalRoot);
  const overlay = h('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) closeModal(); } });
  const m = h('div', { class: 'modal' + (opts.size === 'lg' ? ' lg' : '') });
  m.appendChild(h('div', { class: 'modal-header' }, [
    h('h2', {}, [opts.title || '']),
    h('button', { class: 'btn btn-ghost btn-sm', onclick: closeModal }, ['Close']),
  ]));
  const body = h('div', { class: 'modal-body' });
  if (opts.body) body.appendChild(opts.body);
  m.appendChild(body);
  if (opts.footer) {
    const f = h('div', { class: 'modal-footer' });
    f.appendChild(opts.footer);
    m.appendChild(f);
  }
  overlay.appendChild(m);
  $modalRoot.appendChild(overlay);
}
function closeModal() { clear($modalRoot); }

// ----- Top-level render -----

function render() {
  clear($app);

  if (state.route.name === 'track') {
    $app.appendChild(renderPublicTrack(state.route.params.token));
    return;
  }
  if (!state.session) {
    $app.appendChild(renderLogin());
    return;
  }
  if (!state.store) {
    $app.appendChild(h('div', { class: 'boot' }, ['Loading…']));
    return;
  }
  $app.appendChild(renderShell());
}

// ----- Login -----

function renderLogin() {
  const errEl = h('div', { class: 'err' });
  const emailEl = h('input', { type: 'email', placeholder: 'you@company.com', autocomplete: 'email' });
  const passEl  = h('input', { type: 'password', placeholder: 'password', autocomplete: 'current-password' });
  const nameEl  = h('input', { type: 'text', placeholder: 'Your name', autocomplete: 'name' });
  const submitBtn = h('button', { class: 'btn btn-primary', style: 'width:100%; margin-top:8px;' }, ['Sign in']);

  let mode = 'signin';
  const toggleEl = h('a', { href: '#', onclick: (e) => { e.preventDefault(); mode = (mode === 'signin' ? 'signup' : 'signin'); update(); } });

  function update() {
    submitBtn.textContent = (mode === 'signin' ? 'Sign in' : 'Create account');
    nameField.style.display = (mode === 'signin' ? 'none' : '');
    toggleEl.textContent = (mode === 'signin' ? 'Need an account? Sign up' : 'Have an account? Sign in');
    errEl.textContent = '';
  }

  const submit = async () => {
    errEl.textContent = '';
    submitBtn.disabled = true;
    try {
      if (mode === 'signin') {
        await db.auth.signIn(emailEl.value.trim(), passEl.value);
      } else {
        await db.auth.signUp(emailEl.value.trim(), passEl.value, nameEl.value.trim());
        // After signup, sign them in (Supabase may also send confirmation email if configured)
        await db.auth.signIn(emailEl.value.trim(), passEl.value);
      }
      // The auth state change listener (set up in boot) will reload data and re-render.
    } catch (e) {
      errEl.textContent = e.message || 'Failed';
      submitBtn.disabled = false;
    }
  };

  const nameField = h('div', { class: 'field' }, [h('label', {}, ['Name']), nameEl]);
  const form = h('form', { onsubmit: (e) => { e.preventDefault(); submit(); } }, [
    nameField,
    h('div', { class: 'field' }, [ h('label', {}, ['Email']), emailEl ]),
    h('div', { class: 'field' }, [ h('label', {}, ['Password']), passEl ]),
    errEl,
    submitBtn,
  ]);
  // Initial mode setup
  setTimeout(update, 0);

  return h('div', { class: 'login-wrap' }, [
    h('div', { class: 'login-card' }, [
      h('div', { class: 'brand-mark' }, ['◆ ' + (state.store?.settings?.businessName || 'MAKO CABINETS').toUpperCase()]),
      h('h1', {}, ['Sign in']),
      h('div', { class: 'sub' }, ['Internal CRM']),
      form,
      h('div', { class: 'login-hint', style: 'text-align:center;' }, [toggleEl]),
    ]),
  ]);
}

// ----- Shell -----

function renderShell() {
  const layout = h('div', { class: 'layout' });
  layout.appendChild(renderSidebar());
  const main = h('div', { class: 'main' });

  switch (state.route.name) {
    case 'dashboard': main.appendChild(renderDashboard()); break;
    case 'leads':     main.appendChild(renderLeadsList()); break;
    case 'projects':  main.appendChild(renderProjectsList()); break;
    case 'project':   main.appendChild(renderProjectDetail(state.route.params.id, state.route.params.tab)); break;
    case 'customers': main.appendChild(renderCustomersList()); break;
    case 'customer':  main.appendChild(renderCustomerDetail(state.route.params.id)); break;
    case 'tasks':     main.appendChild(renderTasksPage()); break;
    case 'users':     main.appendChild(renderUsersPage()); break;
    default:          main.appendChild(renderDashboard());
  }

  layout.appendChild(main);
  return layout;
}

function renderSidebar() {
  const sb = h('div', { class: 'sidebar' });
  sb.appendChild(h('div', { class: 'brand' }, [
    h('div', { class: 'brand-mark' }, ['◆']),
    h('div', { class: 'brand-name' }, [state.store.settings.businessName]),
  ]));

  const nav = h('div', { class: 'nav' });
  const u = currentUser();

  const leadCount    = state.store.projects.filter(p => stagePhase(p.stage) === 'lead').length;
  const projectCount = state.store.projects.filter(p => stagePhase(p.stage) === 'active').length;
  const myTasks      = state.store.tasks.filter(t => !t.completed && t.assignedTo === u.id).length;

  const navItems = [
    { route: 'dashboard', label: 'Dashboard', ico: 'dashboard' },
    { route: 'leads',     label: 'Leads',     ico: 'leads',     count: leadCount },
    { route: 'projects',  label: 'Projects',  ico: 'projects',  count: projectCount },
    { route: 'customers', label: 'Customers', ico: 'customers', count: state.store.customers.length },
    { route: 'tasks',     label: 'Tasks',     ico: 'tasks',     count: myTasks },
  ];
  if (u.role === 'admin') navItems.push({ route: 'users', label: 'Users & Roles', ico: 'users' });

  for (const item of navItems) {
    const active = state.route.name === item.route ||
      (item.route === 'projects' && state.route.name === 'project') ||
      (item.route === 'customers' && state.route.name === 'customer');
    const navEl = h('div', { class: 'nav-item' + (active ? ' active' : ''), onclick: () => navigate(item.route) }, [
      icon(item.ico),
      h('span', { class: 'lbl' }, [item.label]),
      item.count != null && item.count > 0 ? h('span', { class: 'nav-count' }, [String(item.count)]) : null,
    ]);
    nav.appendChild(navEl);
  }
  sb.appendChild(nav);

  sb.appendChild(h('div', { class: 'user-card' }, [
    h('div', { class: 'user-avatar' }, [initials(u.name)]),
    h('div', { class: 'user-meta' }, [
      h('div', { class: 'user-name' }, [u.name]),
      h('div', { class: 'user-role' }, [ROLES[u.role].label]),
    ]),
    h('button', { class: 'btn btn-ghost btn-sm', title: 'Sign out', onclick: async () => { await db.auth.signOut(); } }, ['Sign out']),
  ]));

  return sb;
}

function topbar(crumbs, actions, opts = {}) {
  const titles = h('div', { class: 'titles' });
  const list = Array.isArray(crumbs) ? crumbs : [crumbs];
  const main = list[0] || '';
  const trail = list.slice(1);
  if (trail.length) {
    const c = h('div', { class: 'crumb' });
    trail.forEach((b, i) => {
      if (i > 0) c.appendChild(h('span', { class: 'sep' }, ['/']));
      c.appendChild(h('span', {}, [b]));
    });
    titles.appendChild(c);
  }
  titles.appendChild(h('h1', {}, [main]));
  if (opts.subtitle) titles.appendChild(h('div', { class: 'sub' }, [opts.subtitle]));
  return h('div', { class: 'topbar' }, [
    titles,
    h('div', { class: 'topbar-actions' }, actions || []),
  ]);
}

// ----- Dashboard -----

function renderDashboard() {
  const u = currentUser();
  const today = new Date().toISOString().slice(0, 10);
  const myOpenTasks = state.store.tasks.filter(t => !t.completed && t.assignedTo === u.id)
    .sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));
  const overdueCount = myOpenTasks.filter(t => t.dueDate && t.dueDate < today).length;
  const recentLeads = state.store.projects
    .filter(p => stagePhase(p.stage) === 'lead')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 6);
  const activeProjects = state.store.projects
    .filter(p => stagePhase(p.stage) === 'active')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 6);
  const allLeads = state.store.projects.filter(p => stagePhase(p.stage) === 'lead');
  const pipelineValue = allLeads.reduce((sum, p) => sum + (p.quote.amount || 0), 0)
    + state.store.projects.filter(p => stagePhase(p.stage) === 'active').reduce((sum, p) => sum + (p.quote.amount || 0), 0);
  const monthAgo = new Date(); monthAgo.setDate(monthAgo.getDate() - 30);
  const newLeadsLast30 = state.store.projects.filter(p => stagePhase(p.stage) === 'lead' && new Date(p.createdAt) >= monthAgo).length;
  const activeCount = state.store.projects.filter(p => stagePhase(p.stage) === 'active').length;

  const greeting = (() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  })();

  const wrap = h('div');
  wrap.appendChild(topbar('Dashboard', [
    h('button', { class: 'btn btn-primary', onclick: openNewLead }, [icon('plus'), 'New Lead']),
  ], { subtitle: `${greeting}, ${u.name.split(' ')[0]}. Here's your pipeline at a glance.` }));

  const content = h('div', { class: 'content' });

  const stats = h('div', { class: 'stats' });
  stats.appendChild(statCard({
    icon: 'dollar',
    label: 'Pipeline value',
    value: pipelineValue ? fmtMoney(pipelineValue) : '—',
    valueMuted: !pipelineValue,
    sub: pipelineValue
      ? `${allLeads.length} ${allLeads.length === 1 ? 'lead' : 'leads'} · ${activeCount} active`
      : 'No quoted projects yet',
  }));
  stats.appendChild(statCard({
    icon: 'spark',
    label: 'New leads · 30 days',
    value: String(newLeadsLast30),
    valueMuted: newLeadsLast30 === 0,
    sub: newLeadsLast30 ? 'Fresh in the funnel' : 'Add a lead to track inflow',
  }));
  stats.appendChild(statCard({
    icon: 'projects',
    label: 'Active projects',
    value: String(activeCount),
    valueMuted: activeCount === 0,
    sub: activeCount ? 'Deal closed → installed' : 'No live jobs in production',
  }));
  stats.appendChild(statCard({
    icon: 'tasks',
    label: 'My open tasks',
    value: String(myOpenTasks.length),
    valueMuted: myOpenTasks.length === 0,
    sub: overdueCount > 0
      ? h('span', {}, [h('span', { class: 'danger' }, [String(overdueCount) + ' overdue']), ' need attention'])
      : (myOpenTasks.length ? 'On track' : 'Inbox clear'),
  }));
  content.appendChild(stats);

  // Recent leads card
  content.appendChild(panelCard({
    title: 'Recent leads',
    sub: allLeads.length > 6 ? `Showing 6 of ${allLeads.length}` : null,
    actions: allLeads.length ? [h('button', { class: 'btn btn-sm btn-ghost', onclick: () => navigate('leads') }, ['View all', icon('arrowRight')])] : null,
    body: recentLeads.length === 0
      ? emptyState({ icon: 'leads', title: 'No active leads', text: 'Capture your first inquiry to start the pipeline.' })
      : renderProjectTable(recentLeads, { compact: true }),
  }));
  content.appendChild(h('div', { style: 'height:18px;' }));

  // Active projects
  content.appendChild(panelCard({
    title: 'Active projects',
    actions: activeCount > 0 ? [h('button', { class: 'btn btn-sm btn-ghost', onclick: () => navigate('projects') }, ['View all', icon('arrowRight')])] : null,
    body: activeProjects.length === 0
      ? emptyState({ icon: 'projects', title: 'No active projects yet', text: 'Once a quote is approved, the deal moves here.' })
      : renderProjectTable(activeProjects, { compact: true }),
  }));
  content.appendChild(h('div', { style: 'height:18px;' }));

  // Tasks
  content.appendChild(panelCard({
    title: 'My open tasks',
    sub: myOpenTasks.length > 8 ? `Showing 8 of ${myOpenTasks.length}` : null,
    actions: myOpenTasks.length > 0 ? [h('button', { class: 'btn btn-sm btn-ghost', onclick: () => navigate('tasks') }, ['View all', icon('arrowRight')])] : null,
    body: myOpenTasks.length === 0
      ? emptyState({ icon: 'tasks', title: 'Inbox clear', text: 'No tasks need your attention right now.' })
      : (() => {
          const list = h('div');
          myOpenTasks.slice(0, 8).forEach(t => list.appendChild(renderTaskRow(t, true)));
          return list;
        })(),
  }));

  wrap.appendChild(content);
  return wrap;
}

function statCard({ icon: iconName, label, value, valueMuted, sub }) {
  return h('div', { class: 'stat-card' }, [
    h('div', { class: 'lbl' }, [icon(iconName), label]),
    h('div', { class: 'val' + (valueMuted ? ' muted' : '') }, [value]),
    sub != null ? h('div', { class: 'sub' }, [sub]) : null,
  ]);
}

function panelCard({ title, sub, actions, body }) {
  const head = h('div', { class: 'card-head' }, [
    h('div', {}, [
      h('h3', {}, [title]),
      sub ? h('div', { class: 'sub' }, [sub]) : null,
    ]),
    actions ? h('div', { style: 'display:flex; gap:6px;' }, actions) : null,
  ]);
  return h('div', { class: 'card' }, [
    head,
    h('div', { class: 'card-body tight' }, [body]),
  ]);
}

function emptyState({ icon: iconName, title, text }) {
  return h('div', { class: 'empty' }, [
    h('div', { class: 'empty-icon' }, [icon(iconName || 'inbox')]),
    h('div', { class: 'empty-title' }, [title || 'Nothing here yet']),
    text ? h('div', { class: 'empty-text' }, [text]) : null,
  ]);
}

// ----- Reusable project table -----

function renderProjectTable(list, opts = {}) {
  const tbl = h('table', { class: 'flat' });
  tbl.appendChild(h('thead', {}, [h('tr', {}, [
    h('th', {}, ['Customer']),
    h('th', {}, ['Project address']),
    h('th', {}, ['Stage']),
    h('th', {}, ['Quote']),
    h('th', {}, ['Assigned']),
    h('th', {}, ['Created']),
  ])]));
  const tb = h('tbody');
  list.forEach(p => {
    const c = customerOf(p);
    const assignee = state.store.users.find(u => u.id === p.assignedTo);
    tb.appendChild(h('tr', { onclick: () => navigate('projects/' + p.id) }, [
      h('td', {}, [c?.name || '(no customer)']),
      h('td', {}, [p.address || h('span', { class: 'faint-text' }, ['—'])]),
      h('td', {}, [h('span', { class: 'tag' + (stagePhase(p.stage) === 'lead' ? ' gold' : '') }, [stageDef(p.stage).label])]),
      h('td', {}, [p.quote.amount ? fmtMoney(p.quote.amount) : h('span', { class: 'faint-text' }, ['—'])]),
      h('td', {}, [assignee ? assignee.name : '—']),
      h('td', {}, [fmtDate(p.createdAt)]),
    ]));
  });
  tbl.appendChild(tb);
  return tbl;
}

// ----- Leads page -----

function renderLeadsList() {
  const wrap = h('div');
  wrap.appendChild(topbar(['Leads'], [
    h('button', { class: 'btn btn-primary', onclick: openNewLead }, [icon('plus'), 'New Lead']),
  ]));

  const content = h('div', { class: 'content' });

  const search = h('input', { type: 'text', placeholder: 'Search by name, address, phone' });
  const stageSel = h('select', {}, [
    h('option', { value: '' }, ['All lead stages']),
    ...LEAD_STAGES.map(s => h('option', { value: s.id }, [s.label])),
  ]);
  const assigneeSel = h('select', {}, [
    h('option', { value: '' }, ['All assignees']),
    ...state.store.users.map(u => h('option', { value: u.id }, [u.name])),
  ]);
  const tableWrap = h('div');

  const refresh = () => {
    let list = state.store.projects.filter(p => stagePhase(p.stage) === 'lead');
    if (stageSel.value) list = list.filter(p => p.stage === stageSel.value);
    if (assigneeSel.value) list = list.filter(p => p.assignedTo === assigneeSel.value);
    const q = search.value.trim().toLowerCase();
    if (q) list = list.filter(p => {
      const c = customerOf(p);
      return [c?.name, c?.email, c?.phone, p.address].some(v => (v||'').toLowerCase().includes(q));
    });
    list.sort((a,b) => b.createdAt.localeCompare(a.createdAt));

    clear(tableWrap);
    if (list.length === 0) {
      tableWrap.appendChild(h('div', { class: 'empty' }, ['No leads match these filters.']));
      return;
    }
    tableWrap.appendChild(renderLeadsTable(list));
  };

  search.addEventListener('input', refresh);
  stageSel.addEventListener('change', refresh);
  assigneeSel.addEventListener('change', refresh);

  content.appendChild(h('div', { class: 'toolbar' }, [search, stageSel, assigneeSel]));
  content.appendChild(h('div', { class: 'card' }, [tableWrap]));
  refresh();
  wrap.appendChild(content);
  return wrap;
}

function renderLeadsTable(list) {
  const tbl = h('table', { class: 'flat' });
  tbl.appendChild(h('thead', {}, [h('tr', {}, [
    h('th', {}, ['Customer / Address']),
    h('th', {}, ['Stage']),
    h('th', {}, ['Quote']),
    h('th', {}, ['Assigned']),
    h('th', {}, ['Created']),
    h('th', { class: 'col-actions' }, ['Quick actions']),
  ])]));
  const tb = h('tbody');
  list.forEach(p => {
    const c = customerOf(p);
    const assignee = state.store.users.find(u => u.id === p.assignedTo);

    const actions = h('div', { class: 'quick-actions', style: 'display:flex; gap:6px; justify-content:flex-end;' }, [
      h('button', { class: 'btn btn-sm', title: 'Send quote', onclick: (e) => { e.stopPropagation(); quickSendQuote(p); } }, ['Quote']),
      h('button', { class: 'btn btn-sm', title: 'Log a follow-up call', onclick: (e) => { e.stopPropagation(); quickQuickTask(p, 'Call to check', 1); } }, ['Call']),
      h('button', { class: 'btn btn-sm', title: 'Schedule follow-up', onclick: (e) => { e.stopPropagation(); quickQuickTask(p, 'Follow up with customer', 3); } }, ['Follow-up']),
      h('button', { class: 'btn btn-sm', title: 'Schedule showroom visit', onclick: (e) => { e.stopPropagation(); quickQuickTask(p, 'Schedule showroom visit', 7); } }, ['Visit']),
      h('button', { class: 'btn btn-sm btn-primary', title: 'Mark deal closed', onclick: (e) => { e.stopPropagation(); markDealClosed(p); } }, ['Deal closed']),
    ]);

    tb.appendChild(h('tr', { onclick: () => navigate('projects/' + p.id) }, [
      h('td', {}, [
        h('div', {}, [c?.name || '(no customer)']),
        h('div', { class: 'faint-text' }, [p.address || '—']),
      ]),
      h('td', {}, [h('span', { class: 'tag gold' }, [stageDef(p.stage).label])]),
      h('td', {}, [p.quote.amount ? fmtMoney(p.quote.amount) : h('span', { class: 'faint-text' }, ['—'])]),
      h('td', {}, [assignee ? assignee.name : '—']),
      h('td', {}, [fmtDate(p.createdAt)]),
      h('td', { class: 'col-actions' }, [actions]),
    ]));
  });
  tbl.appendChild(tb);
  return tbl;
}

// Quick action helpers

function quickSendQuote(p) {
  if (!p.quote.amount) {
    openQuoteModal(p);
    toast('Set quote amount, then click Send');
    return;
  }
  sendQuote(p);
}

async function quickQuickTask(p, title, dueInDays) {
  await addTask({
    title: title + ' — ' + (customerOf(p)?.name || 'customer'),
    projectId: p.id,
    assignedTo: state.session.userId,
    dueDate: addDays(new Date(), dueInDays).toISOString().slice(0,10),
    completed: false,
  });
  logActivity(p.id, 'Task created: ' + title);
  saveStore();
  toast('Task created · due in ' + dueInDays + 'd');
  render();
}

function markDealClosed(p) {
  if (stagePhase(p.stage) === 'active' || stagePhase(p.stage) === 'completed') {
    toast('Already an active project');
    return;
  }
  if (!confirm('Mark this deal as closed and move to Active Projects?')) return;
  setStage(p, 'dealClosed', { note: 'deal won' });
  if (!p.quote.approvedAt) p.quote.approvedAt = new Date().toISOString();
  saveStore();
  toast('Moved to Active Projects');
  navigate('projects/' + p.id);
}

// ----- Projects list (active phase) -----

function renderProjectsList() {
  const wrap = h('div');
  wrap.appendChild(topbar(['Projects'], [
    h('button', { class: 'btn btn-primary', onclick: openNewLead }, [icon('plus'), 'New Lead']),
  ]));

  const content = h('div', { class: 'content' });
  const search = h('input', { type: 'text', placeholder: 'Search by name, address, phone' });
  const stageSel = h('select', {}, [
    h('option', { value: 'all' }, ['Active + Completed']),
    h('option', { value: 'active' }, ['Active only']),
    h('option', { value: 'completed' }, ['Completed only']),
    ...ACTIVE_STAGES.map(s => h('option', { value: 'stage:' + s.id }, [s.label])),
  ]);
  stageSel.value = 'active';
  const assigneeSel = h('select', {}, [
    h('option', { value: '' }, ['All assignees']),
    ...state.store.users.map(u => h('option', { value: u.id }, [u.name])),
  ]);
  const tableWrap = h('div');

  const refresh = () => {
    let list = state.store.projects.slice();
    const v = stageSel.value;
    if (v === 'active') list = list.filter(p => stagePhase(p.stage) === 'active');
    else if (v === 'completed') list = list.filter(p => stagePhase(p.stage) === 'completed');
    else if (v === 'all') list = list.filter(p => stagePhase(p.stage) !== 'lead');
    else if (v.startsWith('stage:')) list = list.filter(p => p.stage === v.slice(6));
    if (assigneeSel.value) list = list.filter(p => p.assignedTo === assigneeSel.value);
    const q = search.value.trim().toLowerCase();
    if (q) list = list.filter(p => {
      const c = customerOf(p);
      return [c?.name, c?.email, c?.phone, p.address].some(v => (v||'').toLowerCase().includes(q));
    });
    list.sort((a,b) => b.createdAt.localeCompare(a.createdAt));

    clear(tableWrap);
    if (list.length === 0) {
      tableWrap.appendChild(h('div', { class: 'empty' }, ['No projects match these filters.']));
      return;
    }
    tableWrap.appendChild(renderProjectTable(list));
  };

  search.addEventListener('input', refresh);
  stageSel.addEventListener('change', refresh);
  assigneeSel.addEventListener('change', refresh);

  content.appendChild(h('div', { class: 'toolbar' }, [search, stageSel, assigneeSel]));
  content.appendChild(h('div', { class: 'card' }, [tableWrap]));
  refresh();
  wrap.appendChild(content);
  return wrap;
}

// ----- Customers list -----

function renderCustomersList() {
  const wrap = h('div');
  wrap.appendChild(topbar(['Customers'], [
    h('button', { class: 'btn btn-primary', onclick: openNewCustomer }, [icon('plus'), 'New Customer']),
  ]));

  const content = h('div', { class: 'content' });
  const search = h('input', { type: 'text', placeholder: 'Search by name, email, phone' });
  const tableWrap = h('div');

  const refresh = () => {
    let list = state.store.customers.slice();
    const q = search.value.trim().toLowerCase();
    if (q) list = list.filter(c => [c.name, c.email, c.phone].some(v => (v||'').toLowerCase().includes(q)));
    list.sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||''));

    clear(tableWrap);
    if (list.length === 0) {
      tableWrap.appendChild(h('div', { class: 'empty' }, ['No customers yet.']));
      return;
    }
    const tbl = h('table', { class: 'flat' });
    tbl.appendChild(h('thead', {}, [h('tr', {}, [
      h('th', {}, ['Name']),
      h('th', {}, ['Phone']),
      h('th', {}, ['Email']),
      h('th', {}, ['Projects']),
      h('th', {}, ['Latest stage']),
    ])]));
    const tb = h('tbody');
    list.forEach(c => {
      const ps = projectsOfCustomer(c.id);
      const latest = ps.slice().sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0];
      tb.appendChild(h('tr', { onclick: () => navigate('customers/' + c.id) }, [
        h('td', {}, [c.name]),
        h('td', {}, [c.phone || h('span', { class: 'faint-text' }, ['—'])]),
        h('td', {}, [c.email || h('span', { class: 'faint-text' }, ['—'])]),
        h('td', {}, [String(ps.length)]),
        h('td', {}, [latest ? h('span', { class: 'tag' }, [stageDef(latest.stage).label]) : h('span', { class: 'faint-text' }, ['—'])]),
      ]));
    });
    tbl.appendChild(tb);
    tableWrap.appendChild(tbl);
  };

  search.addEventListener('input', refresh);
  content.appendChild(h('div', { class: 'toolbar' }, [search]));
  content.appendChild(h('div', { class: 'card' }, [tableWrap]));
  refresh();
  wrap.appendChild(content);
  return wrap;
}

// ----- Customer detail (contact + projects) -----

function renderCustomerDetail(id) {
  const c = state.store.customers.find(x => x.id === id);
  const wrap = h('div');
  if (!c) {
    wrap.appendChild(topbar(['Customer not found']));
    wrap.appendChild(h('div', { class: 'content' }, [
      h('div', { class: 'empty' }, ['No customer with that ID. ',
        h('a', { href: '#/customers' }, ['Back to customers']),
      ]),
    ]));
    return wrap;
  }

  wrap.appendChild(topbar(['Customers', c.name], [
    h('button', { class: 'btn', onclick: () => openNewProjectFor(c) }, ['+ New project']),
  ]));

  const content = h('div', { class: 'content' });

  // Contact info form
  content.appendChild(h('h3', { class: 'section-title' }, ['Contact']));
  const grid = h('div', { class: 'spec-grid' });

  function bind(label, key, type='text', opts={}) {
    const el = (type === 'textarea') ? h('textarea', {}) : h('input', { type });
    el.value = c[key] || '';
    el.addEventListener('change', () => { c[key] = el.value; saveStore(); toast('Saved'); });
    grid.appendChild(h('div', { class: 'spec-item' + (opts.full ? ' full' : '') }, [
      h('div', { class: 'lbl' }, [label]),
      el,
    ]));
  }

  bind('Name', 'name');
  bind('Phone', 'phone', 'tel');
  bind('Email', 'email', 'email');
  bind('General address (billing)', 'generalAddress', 'text', { full: true });
  bind('Customer notes', 'notes', 'textarea', { full: true });

  content.appendChild(grid);

  content.appendChild(h('hr'));

  // Projects list
  content.appendChild(h('h3', { class: 'section-title' }, ['Projects']));
  const ps = projectsOfCustomer(c.id);
  if (ps.length === 0) {
    content.appendChild(h('div', { class: 'empty' }, ['No projects yet for this customer. Click + New project to add one.']));
  } else {
    content.appendChild(renderProjectTable(ps.slice().sort((a,b) => b.createdAt.localeCompare(a.createdAt))));
  }

  if (currentUser().role === 'admin') {
    content.appendChild(h('div', { style: 'margin-top:24px; padding-top:14px; border-top: 1px solid var(--line-soft);' }, [
      h('button', { class: 'btn btn-sm btn-danger', onclick: () => {
        const pCount = projectsOfCustomer(c.id).length;
        if (pCount > 0) { alert('Cannot delete: ' + pCount + ' project(s) attached. Delete projects first.'); return; }
        if (confirm('Delete this customer? This cannot be undone.')) {
          (async () => { try { await removeCustomer(c.id); navigate('customers'); } catch (e) { toast('Failed: ' + e.message); } })();
        }
      } }, ['Delete customer']),
    ]));
  }

  wrap.appendChild(content);
  return wrap;
}

// ----- New customer / new project / new lead modals -----

function openNewCustomer(onSaved) {
  const name  = h('input', { type: 'text', placeholder: 'Full name' });
  const phone = h('input', { type: 'tel',  placeholder: '(212) 555-0123' });
  const email = h('input', { type: 'email', placeholder: 'name@example.com' });
  const addr  = h('input', { type: 'text', placeholder: 'Billing/general address' });

  const body = h('div', {}, [
    h('div', { class: 'field' }, [h('label', {}, ['Name']), name]),
    h('div', { class: 'field-row' }, [
      h('div', { class: 'field' }, [h('label', {}, ['Phone']), phone]),
      h('div', { class: 'field' }, [h('label', {}, ['Email']), email]),
    ]),
    h('div', { class: 'field' }, [h('label', {}, ['General address (optional)']), addr]),
  ]);
  const footer = h('div', {}, [
    h('button', { class: 'btn', onclick: closeModal }, ['Cancel']),
    h('button', { class: 'btn btn-primary', onclick: async () => {
      if (!name.value.trim()) { toast('Customer name required'); return; }
      try {
        const c = await addCustomer({
          name: name.value.trim(),
          phone: phone.value.trim(),
          email: email.value.trim(),
          generalAddress: addr.value.trim(),
          notes: '',
        });
        closeModal();
        if (onSaved) onSaved(c);
        else navigate('customers/' + c.id);
      } catch (e) { toast('Failed: ' + e.message); }
    } }, ['Create customer']),
  ]);
  modal({ title: 'New customer', body, footer });
}

function openNewProjectFor(c) {
  // Project under an existing customer
  const addr = h('input', { type: 'text', placeholder: 'Project site address' });
  const source = h('select', {}, [
    h('option', { value: '' }, ['—']),
    ...['Website','Referral','Walk-in','Showroom','Phone','Instagram','Other'].map(s => h('option', { value: s }, [s])),
  ]);
  const assignee = h('select', {}, state.store.users.filter(u => u.active).map(u => h('option', { value: u.id }, [u.name + ' · ' + ROLES[u.role].label])));
  assignee.value = state.session.userId;

  const body = h('div', {}, [
    h('div', { class: 'muted-text', style: 'margin-bottom:14px;' }, ['Customer: ' + c.name]),
    h('div', { class: 'field' }, [h('label', {}, ['Project site address']), addr]),
    h('div', { class: 'field-row' }, [
      h('div', { class: 'field' }, [h('label', {}, ['Source']), source]),
      h('div', { class: 'field' }, [h('label', {}, ['Assigned to']), assignee]),
    ]),
  ]);
  const footer = h('div', {}, [
    h('button', { class: 'btn', onclick: closeModal }, ['Cancel']),
    h('button', { class: 'btn btn-primary', onclick: () => {
      if (!addr.value.trim()) { toast('Project address required'); return; }
      const p = createProject({
        customerId: c.id,
        address: addr.value.trim(),
        source: source.value,
        assignedTo: assignee.value,
      });
      saveStore();
      closeModal();
      navigate('projects/' + p.id);
    } }, ['Create project']),
  ]);
  modal({ title: 'New project', body, footer });
}

function openNewLead() {
  // Combined: pick existing customer OR enter new customer + project
  const mode = { value: 'new' }; // 'new' or 'existing'

  const tabs = h('div', { style: 'display:flex; gap:6px; margin-bottom:14px; border-bottom:1px solid var(--line); padding-bottom:0;' });
  const tabNew = h('div', { class: 'tab active', onclick: () => setMode('new') }, ['New customer']);
  const tabEx  = h('div', { class: 'tab', onclick: () => setMode('existing') }, ['Existing customer']);
  tabs.appendChild(tabNew);
  tabs.appendChild(tabEx);

  const newSection = h('div');
  const exSection  = h('div', { style: 'display:none;' });

  // New section fields
  const cName = h('input', { type: 'text', placeholder: 'Full name' });
  const cPhone = h('input', { type: 'tel',  placeholder: '(212) 555-0123' });
  const cEmail = h('input', { type: 'email', placeholder: 'name@example.com' });
  newSection.appendChild(h('div', { class: 'field' }, [h('label', {}, ['Customer name']), cName]));
  newSection.appendChild(h('div', { class: 'field-row' }, [
    h('div', { class: 'field' }, [h('label', {}, ['Phone']), cPhone]),
    h('div', { class: 'field' }, [h('label', {}, ['Email']), cEmail]),
  ]));

  // Existing section
  const exSel = h('select', {}, [
    h('option', { value: '' }, ['Select customer…']),
    ...state.store.customers.slice().sort((a,b) => a.name.localeCompare(b.name)).map(c => h('option', { value: c.id }, [c.name + (c.phone ? ' · ' + c.phone : '')])),
  ]);
  exSection.appendChild(h('div', { class: 'field' }, [h('label', {}, ['Customer']), exSel]));

  // Project fields (always visible)
  const pAddr = h('input', { type: 'text', placeholder: 'Project site address' });
  const pSource = h('select', {}, [
    h('option', { value: '' }, ['—']),
    ...['Website','Referral','Walk-in','Showroom','Phone','Instagram','Other'].map(s => h('option', { value: s }, [s])),
  ]);
  const pAssignee = h('select', {}, state.store.users.filter(u => u.active).map(u => h('option', { value: u.id }, [u.name + ' · ' + ROLES[u.role].label])));
  pAssignee.value = state.session.userId;

  const projSection = h('div', { style: 'border-top:1px solid var(--line-soft); padding-top:14px; margin-top:6px;' }, [
    h('div', { class: 'section-title' }, ['Project']),
    h('div', { class: 'field' }, [h('label', {}, ['Project site address']), pAddr]),
    h('div', { class: 'field-row' }, [
      h('div', { class: 'field' }, [h('label', {}, ['Source']), pSource]),
      h('div', { class: 'field' }, [h('label', {}, ['Assigned to']), pAssignee]),
    ]),
  ]);

  const body = h('div', {}, [tabs, newSection, exSection, projSection]);

  function setMode(m) {
    mode.value = m;
    tabNew.classList.toggle('active', m === 'new');
    tabEx.classList.toggle('active', m === 'existing');
    newSection.style.display = m === 'new' ? '' : 'none';
    exSection.style.display  = m === 'existing' ? '' : 'none';
  }

  if (state.store.customers.length === 0) {
    tabEx.style.display = 'none'; // no existing customers, hide that option
  }

  const footer = h('div', {}, [
    h('button', { class: 'btn', onclick: closeModal }, ['Cancel']),
    h('button', { class: 'btn btn-primary', onclick: async () => {
      if (!pAddr.value.trim()) { toast('Project address required'); return; }
      try {
        let customerId;
        if (mode.value === 'existing') {
          if (!exSel.value) { toast('Select a customer'); return; }
          customerId = exSel.value;
        } else {
          if (!cName.value.trim()) { toast('Customer name required'); return; }
          const cust = await addCustomer({
            name: cName.value.trim(),
            phone: cPhone.value.trim(),
            email: cEmail.value.trim(),
            generalAddress: pAddr.value.trim(),
            notes: '',
          });
          customerId = cust.id;
        }
        const p = await createProject({
          customerId,
          address: pAddr.value.trim(),
          source: pSource.value,
          assignedTo: pAssignee.value,
        });
        closeModal();
        navigate('projects/' + p.id);
      } catch (e) { toast('Failed: ' + e.message); }
    } }, ['Create lead']),
  ]);

  modal({ title: 'New lead', body, footer });
}

async function createProject(data) {
  const p = await addProject({
    customerId: data.customerId,
    address: data.address || '',
    source: data.source || '',
    assignedTo: data.assignedTo || state.session.userId,
    stage: 'lead',
    spec: defaultSpec(),
    subProducts: [],
    serviceTickets: [],
  });
  logActivity(p.id, 'Lead created');
  return p;
}

// ----- Project detail -----

function renderProjectDetail(id, tab) {
  const p = state.store.projects.find(x => x.id === id);
  if (!p) {
    const wrap = h('div');
    wrap.appendChild(topbar(['Project not found']));
    wrap.appendChild(h('div', { class: 'content' }, [
      h('div', { class: 'empty' }, ['No project with that ID. ',
        h('a', { href: '#/projects' }, ['Back to projects']),
      ]),
    ]));
    return wrap;
  }

  const c = customerOf(p);
  const wrap = h('div');

  const trackUrl = location.origin + location.pathname + '#/track/' + p.trackingToken;

  const head = h('div', { class: 'detail-head' });
  head.appendChild(h('div', {}, [
    h('h1', {}, [c?.name || '(no customer)']),
    h('div', { class: 'meta' }, [
      h('span', {}, [p.address || '— no project address —']),
      h('span', {}, [c?.phone || '—']),
      h('span', {}, [c?.email || '—']),
      h('span', {}, ['Source: ' + (p.source || '—')]),
    ]),
  ]));
  head.appendChild(h('div', { style: 'text-align:right;' }, [
    h('div', { class: 'stage', style: 'margin-bottom:4px;' }, ['Current stage']),
    h('div', { class: 'tag gold', style: 'font-size:13px;' }, [stageDef(p.stage).label]),
    h('div', { style: 'margin-top:8px; display:flex; gap:6px; justify-content:flex-end; flex-wrap:wrap;' }, [
      stagePhase(p.stage) === 'lead'
        ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => markDealClosed(p) }, ['Deal closed →'])
        : null,
      h('button', { class: 'btn btn-sm', onclick: () => { navigator.clipboard?.writeText(trackUrl); toast('Tracking link copied'); } }, ['Copy customer link']),
    ]),
  ]));
  wrap.appendChild(head);

  // Pipeline strip — clickable both directions with confirmation when going backward
  const stageIdx = stageIndexOf(p.stage);
  const pipeline = h('div', { class: 'pipeline', style: 'padding: 12px 28px 0; grid-template-columns: repeat(' + ALL_STAGES.length + ', 1fr);' });
  ALL_STAGES.forEach((s, i) => {
    const cls = 'step' + (i < stageIdx ? ' done' : i === stageIdx ? ' current' : '');
    pipeline.appendChild(h('div', {
      class: cls,
      title: i < stageIdx ? 'Click to revert to this stage' : i > stageIdx ? 'Click to advance to this stage' : 'Current stage',
      onclick: () => onStageClick(p, s.id, i, stageIdx),
    }, [s.label]));
  });
  wrap.appendChild(pipeline);

  // Tabs
  const tabs = ['overview','spec','subproducts','schedule','files','tasks','activity'];
  const tabLabels = { overview:'Overview', spec:'Spec & Plans', subproducts:'Sub-products', schedule:'Schedule', files:'Files', tasks:'Tasks', activity:'Activity' };
  const tabBar = h('div', { class: 'tabs', style: 'margin-top:14px;' });
  tabs.forEach(t => {
    tabBar.appendChild(h('div', {
      class: 'tab' + (tab === t ? ' active' : ''),
      onclick: () => navigate('projects/' + p.id + '/' + t),
    }, [tabLabels[t]]));
  });
  wrap.appendChild(tabBar);

  const content = h('div', { class: 'content' });
  switch (tab) {
    case 'spec':        content.appendChild(renderSpecTab(p)); break;
    case 'subproducts': content.appendChild(renderSubProductsTab(p)); break;
    case 'schedule':    content.appendChild(renderScheduleTab(p)); break;
    case 'files':       content.appendChild(renderFilesTab(p)); break;
    case 'tasks':       content.appendChild(renderProjectTasksTab(p)); break;
    case 'activity':    content.appendChild(renderActivityTab(p)); break;
    default:            content.appendChild(renderOverviewTab(p));
  }
  wrap.appendChild(content);

  return wrap;
}

function onStageClick(p, stageId, targetIdx, currentIdx) {
  if (targetIdx === currentIdx) return;
  const dir = targetIdx > currentIdx ? 'advance' : 'revert';
  const targetLabel = stageDef(stageId).label;
  if (dir === 'revert') {
    if (!confirm(`Revert stage back to "${targetLabel}"?`)) return;
  } else {
    if (!confirm(`Advance stage to "${targetLabel}"?`)) return;
  }
  setStage(p, stageId, { note: dir });
  saveStore();
  render();
}

// Project overview tab

function renderOverviewTab(p) {
  const c = customerOf(p);
  const wrap = h('div', { class: 'split-2' });

  const left = h('div');
  left.appendChild(h('h3', { class: 'section-title' }, ['Quote']));
  const quoteTbl = h('table', { class: 'kv-table' });
  quoteTbl.appendChild(h('tbody', {}, [
    h('tr', {}, [h('td', {}, ['Amount']),       h('td', {}, [p.quote.amount ? fmtMoney(p.quote.amount) : '—'])]),
    h('tr', {}, [h('td', {}, ['Sent']),         h('td', {}, [fmtDate(p.quote.sentAt) || '—'])]),
    h('tr', {}, [h('td', {}, ['Valid until']),  h('td', {}, [fmtDate(p.quote.validUntil) || '—'])]),
    h('tr', {}, [h('td', {}, ['Approved']),     h('td', {}, [fmtDate(p.quote.approvedAt) || '—'])]),
  ]));
  left.appendChild(quoteTbl);

  left.appendChild(h('div', { style: 'margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;' }, [
    h('button', { class: 'btn btn-sm', onclick: () => openQuoteModal(p) }, ['Edit quote']),
    !p.quote.sentAt ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => sendQuote(p) }, ['Send quote']) : null,
    p.quote.sentAt && !p.quote.approvedAt ? h('button', { class: 'btn btn-sm', onclick: () => { p.quote.approvedAt = new Date().toISOString(); saveStore(); render(); toast('Quote marked approved'); } }, ['Mark approved']) : null,
  ]));

  left.appendChild(h('hr'));

  left.appendChild(h('h3', { class: 'section-title' }, ['Deposit']));
  const depTbl = h('table', { class: 'kv-table' });
  depTbl.appendChild(h('tbody', {}, [
    h('tr', {}, [h('td', {}, ['Amount']),    h('td', {}, [p.deposit.amount ? fmtMoney(p.deposit.amount) : '—'])]),
    h('tr', {}, [h('td', {}, ['Received']),  h('td', {}, [fmtDate(p.deposit.receivedAt) || '—'])]),
  ]));
  left.appendChild(depTbl);
  left.appendChild(h('div', { style: 'margin-top:10px;' }, [
    h('button', { class: 'btn btn-sm', onclick: () => openDepositModal(p) }, ['Record deposit']),
  ]));

  const right = h('div');
  right.appendChild(h('h3', { class: 'section-title' }, ['Customer']));
  if (c) {
    right.appendChild(h('div', {}, [
      h('a', { href: '#/customers/' + c.id }, [c.name]),
      h('div', { class: 'muted-text' }, [c.phone || c.email || '—']),
    ]));
  }

  right.appendChild(h('div', { style: 'margin-top:18px;' }, [
    h('h3', { class: 'section-title' }, ['Assignment']),
    (() => {
      const sel = h('select', {}, state.store.users.filter(u => u.active).map(u => h('option', { value: u.id }, [u.name + ' · ' + ROLES[u.role].label])));
      sel.value = p.assignedTo || '';
      sel.addEventListener('change', () => { p.assignedTo = sel.value; logActivity(p.id, 'Assignment changed'); saveStore(); });
      return sel;
    })(),
  ]));

  right.appendChild(h('div', { style: 'margin-top:18px;' }, [
    h('h3', { class: 'section-title' }, ['Customer tracking']),
    h('div', { class: 'muted-text' }, ['Public link to share with the customer:']),
    h('div', { style: 'display:flex; gap:6px; margin-top:6px;' }, [
      h('input', { type: 'text', readonly: true, value: location.origin + location.pathname + '#/track/' + p.trackingToken }),
      h('button', { class: 'btn btn-sm', onclick: () => {
        const url = location.origin + location.pathname + '#/track/' + p.trackingToken;
        navigator.clipboard?.writeText(url);
        toast('Link copied');
      }}, ['Copy']),
      h('a', { class: 'btn btn-sm', href: '#/track/' + p.trackingToken, target: '_blank' }, ['Open']),
    ]),
  ]));

  if (currentUser().role === 'admin') {
    right.appendChild(h('div', { style: 'margin-top:24px; padding-top:14px; border-top: 1px solid var(--line-soft);' }, [
      h('button', { class: 'btn btn-sm btn-danger', onclick: () => {
        if (confirm('Delete this project? This cannot be undone.')) {
          (async () => { try { await removeProject(p.id); navigate('projects'); } catch (e) { toast('Failed: ' + e.message); } })();
        }
      } }, ['Delete project']),
    ]));
  }

  wrap.appendChild(left);
  wrap.appendChild(right);
  return wrap;
}

function openQuoteModal(p) {
  const amount  = h('input', { type: 'number', step: '0.01', value: p.quote.amount || '' });
  const validU  = h('input', { type: 'date', value: p.quote.validUntil ? p.quote.validUntil.slice(0,10) : '' });

  const body = h('div', {}, [
    h('div', { class: 'field-row' }, [
      h('div', { class: 'field' }, [h('label', {}, ['Quote amount (USD)']), amount]),
      h('div', { class: 'field' }, [h('label', {}, ['Valid until']), validU]),
    ]),
  ]);
  const footer = h('div', {}, [
    h('button', { class: 'btn', onclick: closeModal }, ['Cancel']),
    h('button', { class: 'btn btn-primary', onclick: () => {
      p.quote.amount = parseFloat(amount.value) || null;
      p.quote.validUntil = validU.value ? new Date(validU.value).toISOString() : null;
      logActivity(p.id, 'Quote updated');
      saveStore();
      closeModal();
      render();
    } }, ['Save']),
  ]);
  modal({ title: 'Edit quote', body, footer });
}

function sendQuote(p) {
  if (!p.quote.amount) {
    openQuoteModal(p);
    toast('Set quote amount, then send');
    return;
  }
  p.quote.sentAt = new Date().toISOString();
  if (p.stage === 'lead') setStage(p, 'quoted');
  logActivity(p.id, 'Quote sent to customer');
  addTask({
    title: 'Follow up on quote — ' + (customerOf(p)?.name || 'customer'),
    projectId: p.id,
    assignedTo: p.assignedTo,
    dueDate: addDays(new Date(), 3).toISOString().slice(0,10),
    completed: false,
  }).catch(e => console.error('task create failed', e));
  saveStore();
  render();

  const c = customerOf(p);
  openEmailPreview({
    to: c?.email || '(no email on file)',
    subject: 'Your quote from ' + state.store.settings.businessName,
    body: `Hi ${c?.name || ''},\n\nThank you for considering ${state.store.settings.businessName}. Please find your quote of ${fmtMoney(p.quote.amount)} attached.\n\nThis quote is valid until ${fmtDate(p.quote.validUntil) || 'further notice'}.\n\nYou can track your project at:\n${location.origin + location.pathname}#/track/${p.trackingToken}\n\nBest,\n${currentUser().name}`,
  });
}

function openDepositModal(p) {
  const amount = h('input', { type: 'number', step: '0.01', value: p.deposit.amount || '' });
  const date   = h('input', { type: 'date', value: p.deposit.receivedAt ? p.deposit.receivedAt.slice(0,10) : new Date().toISOString().slice(0,10) });

  const body = h('div', {}, [
    h('div', { class: 'field-row' }, [
      h('div', { class: 'field' }, [h('label', {}, ['Deposit amount']), amount]),
      h('div', { class: 'field' }, [h('label', {}, ['Received on']), date]),
    ]),
  ]);
  const footer = h('div', {}, [
    h('button', { class: 'btn', onclick: closeModal }, ['Cancel']),
    h('button', { class: 'btn btn-primary', onclick: () => {
      p.deposit.amount = parseFloat(amount.value) || null;
      p.deposit.receivedAt = date.value ? new Date(date.value).toISOString() : null;
      if (p.deposit.amount && p.deposit.receivedAt && stageIndexOf(p.stage) < stageIndexOf('deposit')) {
        setStage(p, 'deposit');
      }
      logActivity(p.id, 'Deposit recorded');
      saveStore();
      closeModal();
      render();
    } }, ['Save']),
  ]);
  modal({ title: 'Record deposit', body, footer });
}

// Spec tab

function renderSpecTab(p) {
  const wrap = h('div');
  const k = p.spec.kitchen;
  const s = p.spec.stone;

  function bind(obj, key, type='text') {
    const el = (type === 'textarea') ? h('textarea', {}) : h('input', { type });
    el.value = obj[key] || '';
    el.addEventListener('change', () => { obj[key] = el.value; saveStore(); });
    return el;
  }
  function bindRoot(key) {
    const el = h('input', { type: 'text' });
    el.value = p.spec[key] || '';
    el.addEventListener('change', () => { p.spec[key] = el.value; saveStore(); });
    return el;
  }

  wrap.appendChild(h('h3', { class: 'section-title' }, ['Kitchen']));
  wrap.appendChild(h('div', { class: 'spec-grid' }, [
    field('Layout',     bind(k, 'layout')),
    field('Cabinets',   bind(k, 'cabinets')),
    field('Finish',     bind(k, 'finish')),
    field('Color',      bind(k, 'color')),
    field('Dimensions', bind(k, 'dimensions')),
    field('Handles',    bindRoot('handles')),
    field('Appliances', bindRoot('appliances'), { full: true }),
    field('Other accessories', bindRoot('otherAccessories'), { full: true }),
    field('Notes',      bind(k, 'notes', 'textarea'), { full: true }),
  ]));

  wrap.appendChild(h('hr'));

  const stoneCheck = h('input', { type: 'checkbox', checked: s.required });
  stoneCheck.addEventListener('change', () => { s.required = stoneCheck.checked; saveStore(); render(); });
  wrap.appendChild(h('h3', { class: 'section-title' }, ['Stone / Countertop']));
  wrap.appendChild(h('div', { class: 'checkbox-row', style: 'margin-bottom:14px;' }, [stoneCheck, h('span', {}, ['Stone is part of this project'])]));
  if (s.required) {
    wrap.appendChild(h('div', { class: 'spec-grid' }, [
      field('Type',  bind(s, 'type')),
      field('Color', bind(s, 'color')),
      field('Edge',  bind(s, 'edge')),
      field('Sq ft', bind(s, 'sqft')),
      field('Notes', bind(s, 'notes', 'textarea'), { full: true }),
    ]));
  }

  wrap.appendChild(h('hr'));

  wrap.appendChild(h('h3', { class: 'section-title' }, ['Customer Approval']));
  if (p.signedSpecAt) {
    wrap.appendChild(h('div', { class: 'tag ok' }, ['Spec signed on ' + fmtDate(p.signedSpecAt)]));
  } else {
    wrap.appendChild(h('div', { class: 'muted-text' }, ['Customer has not signed the spec yet.']));
    wrap.appendChild(h('div', { style: 'margin-top:8px; display:flex; gap:8px;' }, [
      h('button', { class: 'btn', onclick: () => sendSpecForApproval(p) }, ['Send for approval']),
      h('button', { class: 'btn btn-sm btn-ghost', onclick: () => {
        p.signedSpecAt = new Date().toISOString();
        if (stageIndexOf(p.stage) < stageIndexOf('specSigned')) setStage(p, 'specSigned');
        logActivity(p.id, 'Spec marked signed manually');
        saveStore();
        render();
      } }, ['Mark as signed manually']),
    ]));
  }

  return wrap;
}

function field(label, control, opts = {}) {
  return h('div', { class: 'spec-item' + (opts.full ? ' full' : '') }, [
    h('div', { class: 'lbl' }, [label]),
    control,
  ]);
}

function sendSpecForApproval(p) {
  const c = customerOf(p);
  const link = location.origin + location.pathname + '#/track/' + p.trackingToken + '?action=approve';
  openEmailPreview({
    to: c?.email || '(no email on file)',
    subject: 'Please review and approve your kitchen plans',
    body: `Hi ${c?.name || ''},\n\nYour kitchen specification and plans are ready for your review.\n\nPlease open the link below to review and approve:\n${link}\n\nOnce approved we will begin production.\n\nThanks,\n${currentUser().name}`,
  });
  logActivity(p.id, 'Spec sent for customer approval');
  saveStore();
}

// Sub-products tab

function renderSubProductsTab(p) {
  const wrap = h('div');
  wrap.appendChild(h('h3', { class: 'section-title' }, ['Handles, Appliances, Accessories']));
  wrap.appendChild(h('div', { class: 'muted-text', style: 'margin-bottom:10px;' }, ['Track every accessory order — handles, hardware, appliances, sinks, etc.']));

  const tableWrap = h('div');
  const refresh = () => {
    clear(tableWrap);
    if (p.subProducts.length === 0) {
      tableWrap.appendChild(h('div', { class: 'empty' }, ['No items yet. Add one below.']));
      return;
    }
    const tbl = h('table', { class: 'flat' });
    tbl.appendChild(h('thead', {}, [h('tr', {}, [
      h('th', {}, ['Item']),
      h('th', {}, ['Vendor']),
      h('th', {}, ['Qty']),
      h('th', {}, ['Ordered']),
      h('th', {}, ['Received']),
      h('th', { class: 'col-actions' }, ['']),
    ])]));
    const tb = h('tbody');
    p.subProducts.forEach((sp, idx) => {
      const ordered  = h('input', { type: 'checkbox', checked: !!sp.ordered });
      const received = h('input', { type: 'checkbox', checked: !!sp.received });
      ordered.addEventListener('change',  () => { sp.ordered  = ordered.checked;  saveStore(); });
      received.addEventListener('change', () => { sp.received = received.checked; saveStore(); });
      tb.appendChild(h('tr', {}, [
        h('td', {}, [sp.name]),
        h('td', {}, [sp.vendor || '—']),
        h('td', {}, [String(sp.qty || 1)]),
        h('td', {}, [ordered]),
        h('td', {}, [received]),
        h('td', { class: 'col-actions' }, [
          h('button', { class: 'btn btn-sm btn-danger', onclick: () => { p.subProducts.splice(idx,1); saveStore(); refresh(); } }, ['Remove']),
        ]),
      ]));
    });
    tbl.appendChild(tb);
    tableWrap.appendChild(tbl);
  };
  refresh();
  wrap.appendChild(tableWrap);

  const name = h('input', { type: 'text', placeholder: 'Item name' });
  const vendor = h('input', { type: 'text', placeholder: 'Vendor' });
  const qty = h('input', { type: 'number', value: '1', min: '1' });
  wrap.appendChild(h('div', { style: 'margin-top:14px; display:grid; grid-template-columns: 2fr 1fr 80px auto; gap:8px;' }, [
    name, vendor, qty,
    h('button', { class: 'btn btn-primary', onclick: () => {
      if (!name.value.trim()) { toast('Item name required'); return; }
      p.subProducts.push({ name: name.value.trim(), vendor: vendor.value.trim(), qty: parseInt(qty.value)||1, ordered: false, received: false });
      saveStore();
      name.value = ''; vendor.value = ''; qty.value = '1';
      refresh();
    } }, ['+ Add item']),
  ]));

  return wrap;
}

// Schedule tab

function renderScheduleTab(p) {
  const wrap = h('div');
  const sch = p.schedule;

  const items = [
    ['productionStart', 'Production start',     'production'],
    ['deliveryDate',    'Delivery date',        'delivery'],
    ['installDate',     'Installation date',    'installed'],
  ];
  if (p.spec.stone.required) items.push(['stoneDate', 'Stone install date', 'stone']);

  items.forEach(([key, label, advanceTo]) => {
    const inp = h('input', { type: 'date' });
    inp.value = sch[key] ? sch[key].slice(0,10) : '';
    inp.addEventListener('change', () => {
      sch[key] = inp.value ? new Date(inp.value).toISOString() : null;
      logActivity(p.id, label + ' scheduled for ' + inp.value);
      if (sch[key] && advanceTo && stageIndexOf(p.stage) < stageIndexOf(advanceTo)) {
        if (key === 'productionStart') setStage(p, 'production');
        if (key === 'deliveryDate')   setStage(p, 'delivery');
      }
      saveStore();
    });
    const markDone = h('button', { class: 'btn btn-sm', onclick: () => {
      setStage(p, advanceTo);
      logActivity(p.id, label + ' marked complete');
      saveStore();
      render();
    } }, ['Mark ' + label + ' complete']);

    wrap.appendChild(h('div', { class: 'field' }, [
      h('label', {}, [label]),
      h('div', { style: 'display:flex; gap:8px; align-items:center;' }, [inp, markDone]),
    ]));
  });

  wrap.appendChild(h('hr'));
  wrap.appendChild(h('h3', { class: 'section-title' }, ['Service Tickets']));
  if (p.serviceTickets.length === 0) {
    wrap.appendChild(h('div', { class: 'muted-text' }, ['No service tickets opened.']));
  } else {
    const tbl = h('table', { class: 'flat' });
    tbl.appendChild(h('thead', {}, [h('tr', {}, [h('th', {}, ['Issue']), h('th', {}, ['Status']), h('th', {}, ['Opened']), h('th', { class: 'col-actions' }, [''])])]));
    const tb = h('tbody');
    p.serviceTickets.forEach(t => {
      tb.appendChild(h('tr', {}, [
        h('td', {}, [t.issue]),
        h('td', {}, [h('span', { class: 'tag ' + (t.resolved ? 'ok' : 'warn') }, [t.resolved ? 'Resolved' : 'Open'])]),
        h('td', {}, [fmtDate(t.openedAt)]),
        h('td', { class: 'col-actions' }, [
          !t.resolved
            ? h('button', { class: 'btn btn-sm', onclick: () => { t.resolved = true; t.resolvedAt = new Date().toISOString(); logActivity(p.id, 'Service ticket resolved'); saveStore(); render(); } }, ['Mark resolved'])
            : h('span', { class: 'faint-text' }, [fmtDate(t.resolvedAt)])
        ]),
      ]));
    });
    tbl.appendChild(tb);
    wrap.appendChild(tbl);
  }

  const issue = h('input', { type: 'text', placeholder: 'Describe issue (e.g. drawer alignment)' });
  wrap.appendChild(h('div', { style: 'margin-top:14px; display:grid; grid-template-columns: 1fr auto; gap:8px;' }, [
    issue,
    h('button', { class: 'btn btn-primary', onclick: () => {
      if (!issue.value.trim()) return;
      p.serviceTickets.push({ id: uid(), issue: issue.value.trim(), resolved: false, openedAt: new Date().toISOString() });
      logActivity(p.id, 'Service ticket opened');
      saveStore();
      render();
    } }, ['+ Open ticket']),
  ]));

  return wrap;
}

// Files tab

function renderFilesTab(p) {
  const wrap = h('div');
  wrap.appendChild(h('h3', { class: 'section-title' }, ['Links']));
  wrap.appendChild(h('div', { class: 'muted-text', style: 'margin-bottom:12px;' }, ['Add Drive / Dropbox / shared file links here. Files themselves are not uploaded — only the URL is stored.']));

  // Lazy-load files for this project (cache on state.store.filesByProject[p.id]).
  if (!state.store.filesByProject[p.id]) {
    state.store.filesByProject[p.id] = [];
    db.files.listForProject(p.id).then(rows => {
      state.store.filesByProject[p.id] = rows;
      render();
    }).catch(e => console.error('files load', e));
  }
  const files = state.store.filesByProject[p.id];

  const grid = h('div', { class: 'file-grid' });
  if (!files || files.length === 0) {
    grid.appendChild(h('div', { class: 'empty', style: 'grid-column: 1/-1;' }, ['No links yet. Add one below.']));
  } else {
    files.forEach((f) => {
      grid.appendChild(h('div', { class: 'file-card' }, [
        h('div', { class: 'fname' }, [f.name]),
        h('div', { class: 'fmeta' }, ['Link · ' + fmtDate(f.added_at)]),
        h('div', { class: 'frow' }, [
          h('a', { class: 'btn btn-sm', href: f.url, target: '_blank', rel: 'noopener' }, ['Open']),
          h('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
            if (!confirm('Remove this link?')) return;
            try {
              await db.files.remove(f.id);
              state.store.filesByProject[p.id] = files.filter(x => x.id !== f.id);
              logActivity(p.id, 'Link removed: ' + f.name);
              render();
            } catch (e) { toast('Failed: ' + e.message); }
          } }, ['Remove']),
        ]),
      ]));
    });
  }
  wrap.appendChild(grid);

  const linkName = h('input', { type: 'text', placeholder: 'Link label (e.g. "Floor plans")' });
  const linkUrl  = h('input', { type: 'url', placeholder: 'https://...' });

  wrap.appendChild(h('div', { style: 'margin-top:18px;' }, [
    h('label', {}, ['Add link']),
    h('div', { style: 'display:grid; grid-template-columns: 1fr 1fr auto; gap:8px;' }, [
      linkName, linkUrl,
      h('button', { class: 'btn btn-primary', onclick: async () => {
        if (!linkName.value.trim() || !linkUrl.value.trim()) { toast('Label and URL required'); return; }
        try {
          const created = await db.files.create({
            project_id: p.id,
            name: linkName.value.trim(),
            url: linkUrl.value.trim(),
            added_by: state.session.userId,
          });
          state.store.filesByProject[p.id] = [created, ...(state.store.filesByProject[p.id] || [])];
          logActivity(p.id, 'Link added: ' + linkName.value.trim());
          render();
        } catch (e) { toast('Failed: ' + e.message); }
      } }, ['+ Add']),
    ]),
  ]));

  return wrap;
}

// Project tasks tab

function renderProjectTasksTab(p) {
  const wrap = h('div');
  const tasks = state.store.tasks.filter(t => t.projectId === p.id);

  wrap.appendChild(h('h3', { class: 'section-title' }, ['Tasks for this project']));
  if (tasks.length === 0) {
    wrap.appendChild(h('div', { class: 'empty' }, ['No tasks yet.']));
  } else {
    const list = h('div');
    tasks.forEach(t => list.appendChild(renderTaskRow(t)));
    wrap.appendChild(list);
  }

  const title = h('input', { type: 'text', placeholder: 'Task title' });
  const due   = h('input', { type: 'date', value: addDays(new Date(), 3).toISOString().slice(0,10) });
  const assignee = h('select', {}, state.store.users.filter(u => u.active).map(u => h('option', { value: u.id }, [u.name])));
  assignee.value = p.assignedTo;

  wrap.appendChild(h('div', { style: 'margin-top:14px; display:grid; grid-template-columns: 2fr 140px 180px auto; gap:8px;' }, [
    title, due, assignee,
    h('button', { class: 'btn btn-primary', onclick: async () => {
      if (!title.value.trim()) return;
      try {
        await addTask({
          title: title.value.trim(),
          projectId: p.id,
          assignedTo: assignee.value,
          dueDate: due.value || null,
          completed: false,
        });
        logActivity(p.id, 'Task created: ' + title.value.trim());
        render();
      } catch (e) { toast('Failed: ' + e.message); }
    } }, ['+ Add task']),
  ]));

  return wrap;
}

// Activity tab

function renderActivityTab(p) {
  const wrap = h('div');

  // Lazy-load activity for this project.
  if (!state.store.activityByProject[p.id]) {
    state.store.activityByProject[p.id] = [];
    db.activity.listForProject(p.id).then(rows => {
      state.store.activityByProject[p.id] = rows;
      render();
    }).catch(e => console.error('activity load', e));
    wrap.appendChild(h('div', { class: 'empty' }, ['Loading…']));
    return wrap;
  }
  const items = state.store.activityByProject[p.id];
  if (items.length === 0) {
    wrap.appendChild(h('div', { class: 'empty' }, ['No activity yet.']));
    return wrap;
  }
  const ul = h('ul', { class: 'plain' });
  items.forEach(a => {
    const u = state.store.users.find(x => x.id === a.user_id);
    ul.appendChild(h('li', {}, [
      h('span', {}, [a.action]),
      h('span', { class: 'faint-text', style: 'float:right;' }, [(u ? u.name : 'system') + ' · ' + fmtDateTime(a.created_at)]),
    ]));
  });
  wrap.appendChild(ul);
  return wrap;
}

// ----- Tasks page -----

function renderTasksPage() {
  const u = currentUser();
  const wrap = h('div');
  wrap.appendChild(topbar('Tasks', [
    h('button', { class: 'btn btn-primary', onclick: () => openNewTask(refresh) }, [icon('plus'), 'New task']),
  ]));

  const filterSel = h('select', {}, [
    h('option', { value: 'mine' }, ['My tasks']),
    h('option', { value: 'all' }, ['All tasks']),
    h('option', { value: 'open' }, ['All open']),
    h('option', { value: 'done' }, ['Completed']),
  ]);

  const sortSel = h('select', {}, [
    h('option', { value: 'date' }, ['Sort: Due date']),
    h('option', { value: 'priority' }, ['Sort: Priority']),
    h('option', { value: 'project' }, ['Sort: Project']),
  ]);

  const content = h('div', { class: 'content' });
  const listWrap = h('div');

  const refresh = () => {
    clear(listWrap);
    let list = state.store.tasks.slice();
    if (filterSel.value === 'mine') list = list.filter(t => t.assignedTo === u.id && !t.completed);
    else if (filterSel.value === 'open') list = list.filter(t => !t.completed);
    else if (filterSel.value === 'done') list = list.filter(t => t.completed);
    list = sortTasks(list, sortSel.value);

    if (list.length === 0) {
      listWrap.appendChild(emptyState({ icon: 'tasks', title: 'No tasks match this filter', text: 'Try a different filter or create a new task.' }));
      return;
    }

    if (sortSel.value === 'project') {
      let lastKey = '__init__';
      list.forEach(t => {
        const key = t.projectId || '__noproj__';
        if (key !== lastKey) {
          const p = state.store.projects.find(x => x.id === t.projectId);
          const c = p ? customerOf(p) : null;
          const label = p
            ? (c?.name || 'Customer') + (p.address ? ' · ' + p.address : '')
            : 'No project';
          listWrap.appendChild(h('div', { class: 'group-head' }, [label]));
          lastKey = key;
        }
        listWrap.appendChild(renderTaskRow(t, false));
      });
    } else {
      list.forEach(t => listWrap.appendChild(renderTaskRow(t, true)));
    }
  };
  filterSel.addEventListener('change', refresh);
  sortSel.addEventListener('change', refresh);

  content.appendChild(h('div', { class: 'toolbar' }, [filterSel, sortSel]));
  content.appendChild(h('div', { class: 'card' }, [listWrap]));
  refresh();
  wrap.appendChild(content);
  return wrap;
}

function sortTasks(list, by) {
  const byDate = (a, b) => (a.dueDate || '9999-99-99').localeCompare(b.dueDate || '9999-99-99');
  if (by === 'priority') {
    return list.sort((a, b) => priorityDef(a.priority).sort - priorityDef(b.priority).sort || byDate(a, b));
  }
  if (by === 'project') {
    return list.sort((a, b) => {
      const pa = state.store.projects.find(x => x.id === a.projectId);
      const pb = state.store.projects.find(x => x.id === b.projectId);
      const ka = pa ? (customerOf(pa)?.name || 'zzz') : 'zzz_no_project';
      const kb = pb ? (customerOf(pb)?.name || 'zzz') : 'zzz_no_project';
      return ka.localeCompare(kb) || byDate(a, b);
    });
  }
  return list.sort(byDate);
}

function renderTaskRow(t, showProject = false) {
  const p = state.store.projects.find(x => x.id === t.projectId);
  const c = p ? customerOf(p) : null;
  const u = state.store.users.find(x => x.id === t.assignedTo);
  const overdue = !t.completed && t.dueDate && t.dueDate < new Date().toISOString().slice(0,10);
  const pri = priorityDef(t.priority);
  const row = h('div', { class: 'task-row' + (t.completed ? ' done' : '') + (pri.id !== 'normal' ? ' pri-' + pri.id : '') });

  const check = h('div', { class: 'check', onclick: () => {
    t.completed = !t.completed;
    if (t.completed) t.completedAt = new Date().toISOString();
    saveStore();
    render();
  } }, [t.completed ? '✓' : '']);
  row.appendChild(check);

  const titleEl = h('div', { class: 'ttitle' }, [
    pri.id !== 'normal' ? h('span', {
      class: 'tag ' + pri.tag + ' tag-pri',
      title: 'Click to edit priority',
      onclick: (e) => { e.stopPropagation(); openEditTask(t); },
    }, [pri.label]) : null,
    t.title,
    showProject && c ? h('span', { class: 'faint-text' }, [' · ' + c.name + (p?.address ? ' · ' + p.address : '')]) : null,
  ]);
  row.appendChild(titleEl);

  const meta = h('div', { class: 'tmeta' }, [
    u ? u.name : '—',
    t.dueDate ? h('span', { class: 'tmeta-due' + (overdue ? ' overdue' : '') }, [
      icon('calendar'),
      ' ',
      overdue ? 'Overdue · ' + fmtShortDate(t.dueDate) : fmtShortDate(t.dueDate),
    ]) : null,
  ]);
  row.appendChild(meta);

  if (!t.completed) {
    row.appendChild(h('button', { class: 'btn btn-sm btn-ghost', onclick: (e) => { e.stopPropagation(); openEditTask(t); } }, [icon('calendar'), 'Edit']));
  }

  if (p) {
    row.appendChild(h('button', { class: 'btn btn-sm btn-ghost', onclick: () => navigate('projects/' + p.id) }, ['Open', icon('arrowRight')]));
  }

  return row;
}

function openNewTask(onSaved) {
  const title = h('input', { type: 'text', placeholder: 'Task title' });
  const project = h('select', {}, [
    h('option', { value: '' }, ['(no project)']),
    ...state.store.projects.map(p => {
      const c = customerOf(p);
      return h('option', { value: p.id }, [(c?.name || 'Customer') + ' · ' + (p.address || '')]);
    }),
  ]);
  const assignee = h('select', {}, state.store.users.filter(u => u.active).map(u => h('option', { value: u.id }, [u.name])));
  assignee.value = state.session.userId;
  const due = h('input', { type: 'date', value: addDays(new Date(), 3).toISOString().slice(0,10) });
  const priority = h('select', {}, PRIORITIES.map(p => h('option', { value: p.id }, [p.label])));
  priority.value = 'normal';

  const body = h('div', {}, [
    h('div', { class: 'field' }, [h('label', {}, ['Title']), title]),
    h('div', { class: 'field-row' }, [
      h('div', { class: 'field' }, [h('label', {}, ['Priority']), priority]),
      h('div', { class: 'field' }, [h('label', {}, ['Due date']), due]),
    ]),
    h('div', { class: 'field' }, [h('label', {}, ['Project']), project]),
    h('div', { class: 'field' }, [h('label', {}, ['Assigned to']), assignee]),
  ]);
  const footer = h('div', {}, [
    h('button', { class: 'btn', onclick: closeModal }, ['Cancel']),
    h('button', { class: 'btn btn-primary', onclick: async () => {
      if (!title.value.trim()) { toast('Title required'); return; }
      try {
        await addTask({
          title: title.value.trim(),
          projectId: project.value || null,
          assignedTo: assignee.value,
          dueDate: due.value || null,
          priority: priority.value || 'normal',
          completed: false,
        });
        if (project.value) logActivity(project.value, 'Task created: ' + title.value.trim());
        closeModal();
        onSaved?.();
        render();
      } catch (e) { toast('Failed: ' + e.message); }
    } }, ['Create']),
  ]);
  modal({ title: 'New task', body, footer });
}

function openEditTask(t, onSaved) {
  const due = h('input', { type: 'date', value: t.dueDate || '' });
  const priority = h('select', {}, PRIORITIES.map(p => h('option', { value: p.id }, [p.label])));
  priority.value = t.priority || 'normal';

  const setDays = (n) => {
    const base = t.dueDate ? new Date(t.dueDate + 'T00:00:00') : new Date();
    due.value = addDays(base, n).toISOString().slice(0, 10);
  };

  const presets = h('div', { style: 'display:flex; gap:6px; flex-wrap:wrap;' }, [
    h('button', { class: 'btn btn-sm', onclick: () => setDays(1) }, ['+1 day']),
    h('button', { class: 'btn btn-sm', onclick: () => setDays(3) }, ['+3 days']),
    h('button', { class: 'btn btn-sm', onclick: () => setDays(7) }, ['+1 week']),
  ]);

  const body = h('div', {}, [
    h('div', { class: 'muted-text', style: 'margin-bottom:10px;' }, [t.title]),
    h('div', { class: 'field-row' }, [
      h('div', { class: 'field' }, [h('label', {}, ['Priority']), priority]),
      h('div', { class: 'field' }, [h('label', {}, ['Due date']), due]),
    ]),
    h('div', { class: 'field' }, [h('label', {}, ['Postpone']), presets]),
  ]);
  const footer = h('div', {}, [
    h('button', { class: 'btn', onclick: closeModal }, ['Cancel']),
    h('button', { class: 'btn btn-ghost', onclick: () => {
      const oldDue = t.dueDate;
      t.dueDate = null;
      if (oldDue && t.projectId) logActivity(t.projectId, 'Task due date cleared: ' + t.title);
      saveStore(); closeModal(); onSaved?.(); render();
    } }, ['Clear date']),
    h('button', { class: 'btn btn-primary', onclick: () => {
      const oldDue = t.dueDate;
      const oldPri = t.priority || 'normal';
      t.dueDate = due.value || null;
      t.priority = priority.value || 'normal';
      if (oldDue !== t.dueDate && t.projectId) {
        logActivity(t.projectId, 'Task rescheduled: ' + t.title + ' → ' + (t.dueDate || 'no date'));
      }
      if (oldPri !== t.priority && t.projectId) {
        logActivity(t.projectId, 'Task priority changed: ' + oldPri + ' → ' + t.priority);
      }
      saveStore(); closeModal(); onSaved?.(); render();
    } }, ['Save']),
  ]);
  modal({ title: 'Edit task', body, footer });
}

// Users page

function renderUsersPage() {
  const wrap = h('div');
  wrap.appendChild(topbar(['Users & Roles'], [
    h('button', { class: 'btn btn-primary', onclick: () => openUserModal() }, [icon('plus'), 'Add user']),
  ]));
  const content = h('div', { class: 'content' });
  const tbl = h('table', { class: 'flat' });
  tbl.appendChild(h('thead', {}, [h('tr', {}, [
    h('th', {}, ['Name']),
    h('th', {}, ['Role']),
    h('th', {}, ['Status']),
    h('th', { class: 'col-actions' }, ['']),
  ])]));
  const tb = h('tbody');
  state.store.users.forEach(u => {
    tb.appendChild(h('tr', {}, [
      h('td', {}, [u.name]),
      h('td', {}, [ROLES[u.role].label]),
      h('td', {}, [h('span', { class: 'tag ' + (u.active ? 'ok' : 'dim') }, [u.active ? 'Active' : 'Disabled'])]),
      h('td', { class: 'col-actions' }, [
        h('button', { class: 'btn btn-sm', onclick: () => openUserModal(u) }, ['Edit']),
        u.id !== state.session.userId
          ? h('button', { class: 'btn btn-sm', onclick: async () => {
              try {
                const next = !u.active;
                await db.profiles.update(u.id, { active: next });
                u.active = next;
                render();
              } catch (e) { toast('Failed: ' + e.message); }
            } }, [u.active ? 'Disable' : 'Enable'])
          : null,
      ]),
    ]));
  });
  tbl.appendChild(tb);
  content.appendChild(tbl);

  content.appendChild(h('hr'));
  content.appendChild(h('h3', { class: 'section-title' }, ['Role permissions']));
  const permTbl = h('table', { class: 'flat' });
  permTbl.appendChild(h('thead', {}, [h('tr', {}, [h('th', {}, ['Role']), h('th', {}, ['Permissions'])])]));
  const ptb = h('tbody');
  Object.entries(ROLES).forEach(([id, r]) => {
    ptb.appendChild(h('tr', {}, [
      h('td', {}, [r.label]),
      h('td', { class: 'muted-text' }, [r.perms.join(', ')]),
    ]));
  });
  permTbl.appendChild(ptb);
  content.appendChild(permTbl);

  wrap.appendChild(content);
  return wrap;
}

function openUserModal(existing) {
  if (!existing) {
    // Creating users requires Supabase Auth admin privileges (service_role).
    // For now: instruct admins to have new users sign up themselves, then promote here.
    modal({
      title: 'Add a user',
      body: h('div', {}, [
        h('p', {}, ['New team members create their own account from the sign-in page (using "Sign up").']),
        h('p', {}, ['Once they sign up, they appear here as Sales by default. Admins can change their role and active state.']),
      ]),
      footer: h('div', {}, [h('button', { class: 'btn btn-primary', onclick: closeModal }, ['Got it'])]),
    });
    return;
  }
  const name = h('input', { type: 'text', value: existing?.name || '' });
  const role = h('select', {}, Object.entries(ROLES).map(([id, r]) => h('option', { value: id }, [r.label])));
  role.value = existing.role;

  const body = h('div', {}, [
    h('div', { class: 'field' }, [h('label', {}, ['Name']), name]),
    h('div', { class: 'field' }, [h('label', {}, ['Role']), role]),
  ]);
  const footer = h('div', {}, [
    h('button', { class: 'btn', onclick: closeModal }, ['Cancel']),
    h('button', { class: 'btn btn-primary', onclick: async () => {
      if (!name.value.trim()) { toast('Name required'); return; }
      try {
        await db.profiles.update(existing.id, { name: name.value.trim(), role: role.value });
        existing.name = name.value.trim();
        existing.role = role.value;
        closeModal();
        render();
      } catch (e) { toast('Failed: ' + e.message); }
    } }, ['Save']),
  ]);
  modal({ title: 'Edit user', body, footer });
}

// Public tracking page (anonymous, uses RPC)

const BUSINESS_NAME = 'MAKO CABINETS';

function renderPublicTrack(token) {
  const wrap = h('div', { class: 'public-wrap' });
  const card = h('div', { class: 'public-card' });
  card.appendChild(h('div', {}, ['Loading…']));
  wrap.appendChild(card);

  db.tracking.getProject(token).then(p => {
    clear(card);
    if (!p) {
      card.appendChild(h('div', { class: 'brand-mark' }, ['◆ ' + BUSINESS_NAME]));
      card.appendChild(h('h1', {}, ['Link not found']));
      card.appendChild(h('div', { class: 'sub' }, ['This tracking link is invalid or has been removed. Please contact your sales representative.']));
      return;
    }

    card.appendChild(h('div', { class: 'brand-mark' }, ['◆ ' + BUSINESS_NAME]));
    card.appendChild(h('h1', {}, ['Hello, ' + (p.customer_name || 'there')]));
    card.appendChild(h('div', { class: 'sub' }, [
      'Project at ' + (p.address || 'your address') + '. We update this automatically as we move forward.'
    ]));

    const stageIdx = stageIndexOf(p.stage);
    const showStone = !!p.spec_stone_required;
    const visibleStages = ALL_STAGES.filter(s => showStone || s.id !== 'stone');

    const tl = h('div', { class: 'timeline' });
    visibleStages.forEach(s => {
      const visIdx = stageIndexOf(s.id);
      const cls = 'tl-item' + (visIdx < stageIdx ? ' done' : visIdx === stageIdx ? ' current' : '');
      const dateMap = {
        lead:        p.created_at,
        quoted:      p.quote_sent_at,
        dealClosed:  p.quote_approved_at,
        deposit:     p.deposit_received_at,
        specSigned:  p.signed_spec_at,
        production:  p.schedule_production_start,
        delivery:    p.schedule_delivery_date,
        installed:   p.schedule_install_date,
        stone:       p.schedule_stone_date,
        completed:   visIdx <= stageIdx ? new Date().toISOString() : null,
      };
      tl.appendChild(h('div', { class: cls }, [
        h('div', { class: 'tl-dot' }),
        h('div', {}, [
          h('div', { class: 'tl-title' }, [s.customer]),
          h('div', { class: 'tl-date' }, [fmtDate(dateMap[s.id]) || (visIdx === stageIdx ? 'In progress' : '')]),
        ]),
      ]));
    });
    card.appendChild(tl);

    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    if (params.get('action') === 'approve' && !p.signed_spec_at) {
      card.appendChild(h('div', { class: 'signature-box' }, [
        h('div', { style: 'margin-bottom:8px;' }, ['Please review your plans and confirm approval.']),
        h('button', { class: 'btn btn-primary', onclick: async () => {
          try { await db.tracking.approveSpec(token); render(); } catch (e) { toast('Failed: ' + e.message); }
        } }, ['I approve the plans and spec']),
      ]));
    } else if (p.signed_spec_at) {
      card.appendChild(h('div', { class: 'signature-box' }, [
        'Your plans were approved on ' + fmtDate(p.signed_spec_at) + '. Thank you!',
      ]));
    }

    card.appendChild(h('hr'));
    card.appendChild(h('div', { class: 'section-title' }, ['Need help?']));
    const issue = h('input', { type: 'text', placeholder: 'Describe an issue or request' });
    card.appendChild(h('div', { style: 'display:grid; grid-template-columns: 1fr auto; gap:8px;' }, [
      issue,
      h('button', { class: 'btn btn-primary', onclick: async () => {
        if (!issue.value.trim()) return;
        try {
          await db.tracking.submitTicket(token, issue.value.trim());
          issue.value = '';
          toast('Thanks — we\'ll get back to you shortly.');
        } catch (e) { toast('Failed: ' + e.message); }
      } }, ['Send']),
    ]));

    card.appendChild(h('div', { class: 'faint-text', style: 'margin-top:24px; text-align:center;' }, [
      'Questions? Reply to your sales email or call us. We\'ll keep this page updated as we progress.'
    ]));
  }).catch(e => {
    clear(card);
    card.appendChild(h('div', { class: 'brand-mark' }, ['◆ ' + BUSINESS_NAME]));
    card.appendChild(h('h1', {}, ['Could not load']));
    card.appendChild(h('div', { class: 'sub' }, [e.message || 'Network error']));
  });

  return wrap;
}

// Email preview (simulated)

function openEmailPreview({ to, subject, body }) {
  const ta = h('textarea', { rows: 12 });
  ta.value = body;
  const m = h('div', {}, [
    h('div', { class: 'field' }, [h('label', {}, ['To']), h('input', { type: 'text', value: to, readonly: true })]),
    h('div', { class: 'field' }, [h('label', {}, ['Subject']), h('input', { type: 'text', value: subject, readonly: true })]),
    h('div', { class: 'field' }, [h('label', {}, ['Body']), ta]),
    h('div', { class: 'muted-text' }, ['(Local prototype — when this app moves online we\'ll wire this to actual email delivery.)']),
  ]);
  const footer = h('div', {}, [
    h('button', { class: 'btn', onclick: closeModal }, ['Close']),
    h('a', { class: 'btn btn-primary', href: 'mailto:' + encodeURIComponent(to) + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(ta.value) }, ['Open in mail app']),
  ]);
  modal({ title: 'Email preview', body: m, footer });
}

// Helpers

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtShortDate(s) {
  if (!s) return '';
  const d = new Date(s.length === 10 ? s + 'T00:00:00' : s);
  if (isNaN(d)) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtDateTime(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return '';
  return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function fmtMoney(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}
function fmtBytes(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024*1024) return (n/1024).toFixed(0) + ' KB';
  return (n/1024/1024).toFixed(1) + ' MB';
}
function addDays(d, days) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

// Boot

state.route = parseHash();

let _reloadTimer = null;
function debouncedReload() {
  clearTimeout(_reloadTimer);
  _reloadTimer = setTimeout(async () => {
    if (!state.session) return;
    try { await loadAll(); render(); } catch (e) { console.warn('reload failed', e); }
  }, 250);
}

async function boot() {
  // Render once early so the user sees the shell while we load.
  render();

  const session = await db.auth.getSession();
  if (session) {
    state.session = { userId: session.user.id };
    try { await loadAll(); } catch (e) { console.error('initial load failed', e); }
  }
  render();

  // React to auth changes (sign in, sign out, token refresh).
  db.auth.onChange(async (event, sess) => {
    if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
      if (sess && (!state.session || state.session.userId !== sess.user.id)) {
        state.session = { userId: sess.user.id };
        try { await loadAll(); } catch (e) { console.error('post-signin load failed', e); }
        render();
      }
    } else if (event === 'SIGNED_OUT') {
      state.session = null;
      state.store = null;
      render();
    }
  });

  // Realtime — when other users mutate data, reload (debounced).
  if (state.session) {
    db.subscribeAll(debouncedReload);
  }
}

boot();
