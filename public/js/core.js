// Núcleo da interface: estado, API, formatação, componentes e roteador.
/* global TZ, I18N */
const S = { me: null, meta: null, locale: 'pt-BR' };
const ACT = {};   // ações de clique: data-act="nome"
const FORMS = {}; // envio de formulários: data-form="nome"
const ROUTES = [];

function t(s) { return (I18N[S.locale] && I18N[S.locale][s]) || s; }

// ---------- HTML seguro ----------
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(String(s));
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function val(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(val).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
}
function html(strings, ...vals) { let out = ''; strings.forEach((s, i) => { out += s + (i < vals.length ? val(vals[i]) : ''); }); return new Raw(out); }

// ---------- API ----------
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch {
    const e = new Error('Sem conexão com o servidor. Verifique sua internet e tente novamente.'); e.status = 0; throw e;
  }
  let data = null;
  try { data = await res.json(); } catch { /* resposta sem corpo */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Erro ${res.status}`);
    err.status = res.status; err.data = data || {};
    if (res.status === 401 && !url.includes('/api/login')) { S.me = null; if (!location.hash.startsWith('#/entrar')) location.hash = '#/entrar'; }
    throw err;
  }
  return data;
}
const GET = (u) => api('GET', u); const POST = (u, b = {}) => api('POST', u, b); const PATCH = (u, b = {}) => api('PATCH', u, b);

// ---------- Formatação (EUA: USD, MM/DD/YYYY, 12h; fuso da empresa) ----------
const tzName = () => (S.me ? S.me.company.timezone : 'America/New_York');
const todayStr = () => TZ.localDate(Date.now(), tzName());
const WD = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const WD_LONG = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
function money(c) { if (c === null || c === undefined) return '-'; return (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' }); }
function parseMoney(s) { if (s === null || s === undefined || String(s).trim() === '') return null; const n = Number(String(s).replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : NaN; }
function centsToInput(c) { return c || c === 0 ? (c / 100).toFixed(2) : ''; }
function fmtDate(d) { if (!d) return '-'; const [y, m, dd] = d.slice(0, 10).split('-'); return `${m}/${dd}/${y}`; }
function fmtDay(d) { return `${WD[TZ.weekday(d)]}, ${fmtDate(d).slice(0, 5)}`; }
function fmtDayLong(d) { return `${WD_LONG[TZ.weekday(d)]}, ${fmtDate(d)}`; }
function fmtTime(iso) { if (!iso) return '-'; const [h, m] = TZ.localTime(iso, tzName()).split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; }
function fmtTimeStr(hm) { const [h, m] = hm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; }
function localDateOf(iso) { return TZ.localDate(iso, tzName()); }
function fmtDT(iso) { if (!iso) return '-'; return `${fmtDate(localDateOf(iso))} ${fmtTime(iso)}`; }
function fmtMonth(m) { const [y, mm] = m.split('-').map(Number); return `${MONTHS[mm - 1]} de ${y}`; }
function relDays(d) {
  const n = TZ.diffDays(todayStr(), d);
  if (n === 0) return 'hoje'; if (n === 1) return 'amanhã'; if (n === -1) return 'ontem';
  return n > 0 ? `em ${n} dias` : `há ${-n} dias`;
}
function dueBadge(d) {
  if (!d) return html`<span class="badge">sem prazo</span>`;
  const n = TZ.diffDays(todayStr(), d);
  if (n < 0) return html`<span class="badge danger">atrasado ${-n} dia${n === -1 ? '' : 's'}</span>`;
  if (n === 0) return html`<span class="badge warn">hoje</span>`;
  return html`<span class="badge">${n === 1 ? 'amanhã' : fmtDate(d)}</span>`;
}
function hours(h) { return `${Number(h).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}h`; }
function durationLabel(min) { const h = Math.floor(min / 60); const m = min % 60; return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`; }

const JOB_STATUS = { pending_schedule: ['Pendente de agendamento', 'warn'], scheduled: ['Agendado', 'info'], in_progress: ['Em andamento', 'violet'], completed: ['Concluído', 'ok'], canceled: ['Cancelado', ''] };
const QUOTE_STATUS = { draft: ['Rascunho', ''], sent: ['Aguardando resposta', 'info'], approved: ['Aprovado', 'ok'], declined: ['Recusado', 'danger'] };
const INV_STATUS = { open: ['Em aberto', 'info'], partial: ['Pago parcialmente', 'warn'], paid: ['Pago', 'ok'], overdue: ['Vencido', 'danger'], void: ['Anulado', ''] };
const STAGES = { new: 'Novo contato', contacted: 'Em atendimento', quote_sent: 'Orçamento enviado', approved: 'Aprovado', lost: 'Perdido' };
const MSG_STATUS = { pending: ['Agendada', 'info'], sent: ['Enviada (simulação)', 'ok'], blocked: ['Bloqueada', 'danger'], canceled: ['Não enviada', ''] };
const TASK_STATUS = { open: ['Aberta', 'info'], in_progress: ['Em andamento', 'violet'], done: ['Concluída', 'ok'], canceled: ['Cancelada', ''] };
const TASK_TYPE = { general: 'Geral', followup: 'Follow-up', complaint: 'Reclamação', reply: 'Responder cliente', scheduling: 'Agendamento', billing: 'Cobrança' };
const FREQ = { one_time: 'Avulso', weekly: 'Semanal', biweekly: 'Quinzenal', monthly: 'Mensal' };
const CH = { email: 'E-mail', sms: 'SMS', whatsapp: 'WhatsApp', internal: 'Interno', phone: 'Telefone', preferred: 'Melhor canal' };
const ROLE = { owner: 'Dono / administrador', assistant: 'Assistente / VA', field: 'Equipe de campo' };
const CAT = { operational: ['Operacional', 'info'], commercial: ['Comercial', 'violet'], billing: ['Cobrança', 'warn'], relationship: ['Relacionamento', 'primary'] };
function badge(map, key) { const [l, c] = map[key] || [key, '']; return html`<span class="badge ${c}">${t(l)}</span>`; }

// ---------- Ícones ----------
const ICON_PATHS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  funnel: 'M3 4h18l-7 8.5V19l-4 2v-8.5z',
  calendar: 'M8 2v4M16 2v4M3 9h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  dollar: 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  zap: 'M13 2 3 14h9l-1 8 10-12h-9z',
  check: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14', x: 'M18 6 6 18M6 6l12 12', more: 'M4 6h16M4 12h16M4 18h16',
  phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z',
  map: 'M12 21s-7-6.3-7-12a7 7 0 1 1 14 0c0 5.7-7 12-7 12zM12 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  chevL: 'M15 18l-6-6 6-6', chevR: 'M9 18l6-6-6-6', search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
};
function icon(name) { return raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICON_PATHS[name]}"/></svg>`); }

// ---------- Componentes ----------
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type; el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3600);
}
function empty(title, text = '', action = '') { return html`<div class="empty"><div class="empty-title">${title}</div>${text ? html`<div class="small">${text}</div>` : ''}${action ? html`<div class="mt">${action}</div>` : ''}</div>`; }
function skeleton() {
  return html`<div class="stack"><div class="skeleton" style="height:28px;width:240px"></div><div class="tiles">${[1, 2, 3, 4].map(() => html`<div class="skeleton" style="height:92px"></div>`)}</div><div class="skeleton" style="height:260px"></div></div>`;
}
function errorBox(e) {
  return html`<div class="error-box card card-pad stack"><h2>Não foi possível carregar esta tela</h2><p class="muted">${e.message}</p><div><button class="btn primary" data-act="reload">Tentar novamente</button></div></div>`;
}
function demoNote(text) { return html`<div class="callout demo"><strong>Demonstração.</strong> ${text}</div>`; }

let modalEl = null;
function modal({ title, body, wide = false }) {
  closeModal();
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-act="close-modal" aria-label="Fechar">${icon('x')}</button></div><div class="modal-body">${val(body)}</div></div>`;
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeModal(); });
  document.body.appendChild(ov);
  modalEl = ov;
  const first = ov.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea');
  if (first && window.innerWidth > 860) first.focus();
  return ov;
}
function closeModal() { if (modalEl) { modalEl.remove(); modalEl = null; } }
let drawerEls = null;
function drawer({ title, sub = '', body }) {
  closeDrawer();
  const ov = document.createElement('div'); ov.className = 'drawer-overlay'; ov.addEventListener('click', closeDrawer);
  const d = document.createElement('aside'); d.className = 'drawer'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', title);
  d.innerHTML = `<div class="modal-head"><div><h2>${esc(title)}</h2>${sub ? `<div class="small muted">${esc(sub)}</div>` : ''}</div><button class="icon-btn" data-act="close-drawer" aria-label="Fechar">${icon('x')}</button></div><div class="drawer-body">${val(body)}</div>`;
  document.body.append(ov, d); drawerEls = [ov, d];
}
function closeDrawer() { if (drawerEls) { drawerEls.forEach((e) => e.remove()); drawerEls = null; } }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); closeDrawer(); } });

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') { if (el.dataset.multi) { (out[el.name] = out[el.name] || []); if (el.checked) out[el.name].push(el.value); } else out[el.name] = el.checked; }
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value;
  }
  return out;
}
function showFormError(form, msg) {
  let box = form.querySelector('.form-error');
  if (!box) { box = document.createElement('div'); box.className = 'form-error'; box.setAttribute('role', 'alert'); form.prepend(box); }
  box.textContent = msg;
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
async function busy(btn, fn) {
  if (!btn) return fn();
  const label = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Aguarde';
  try { return await fn(); } finally { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = label; } }
}
// Executa uma ação com feedback: erro aparece no formulário (se houver) ou como aviso.
async function run(fn, { form = null, btn = null, ok = null } = {}) {
  try {
    const r = await busy(btn || (form && form.querySelector('[type=submit]')), fn);
    if (ok) toast(ok);
    return r;
  } catch (e) {
    if (form) showFormError(form, e.message); else toast(e.message, 'error');
    throw e;
  }
}
const safe = (p) => p.catch(() => {});

function opts(list, selected, { blank = null } = {}) {
  return raw((blank !== null ? `<option value="">${esc(blank)}</option>` : '') + list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(selected ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join(''));
}
const userOpts = (sel, filter = () => true) => opts(S.meta.users.filter(filter).map((u) => [u.id, `${u.name} (${ROLE[u.role].split(' /')[0]})`]), sel);
const staffOpts = (sel) => userOpts(sel, (u) => u.role !== 'field');
const crewOpts = (sel) => opts(S.meta.crews.map((c) => [c.id, c.name]), sel, { blank: 'Selecione a equipe' });
const userName = (id) => (S.meta.users.find((u) => u.id === id) || {}).name || '-';

// ---------- Roteador ----------
function routeDef(pattern, view, { perm = null } = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/?]+)'; }) + '$');
  ROUTES.push({ re, keys, view, perm });
}
function parseHash() {
  const h = location.hash.slice(1) || '/';
  const [p, q] = h.split('?');
  return { path: p, query: Object.fromEntries(new URLSearchParams(q || '')) };
}
function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }
function setQuery(patch) {
  const { path, query } = parseHash();
  const q = new URLSearchParams({ ...query, ...patch });
  for (const [k, v] of [...q.entries()]) if (v === '' || v === 'null') q.delete(k);
  go('#' + path + (q.toString() ? '?' + q : ''));
}
let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  closeDrawer(); closeModal();
  const { path, query } = parseHash();
  if (path === '/entrar' || !S.me) {
    if (!S.me) { try { await loadSession(); } catch { /* sem sessão */ } }
    if (!S.me) return window.renderLogin();
    if (path === '/entrar') return go(S.me.user.role === 'field' ? '#/hoje' : '#/hoje');
  }
  window.renderShell();
  const main = document.getElementById('main');
  const r = ROUTES.find((x) => x.re.test(path));
  if (!r) { main.innerHTML = val(errorBox(new Error('Página não encontrada.'))); return; }
  if (r.perm && !r.perm.some((p) => S.me.perms[p])) { main.innerHTML = val(html`<div class="error-box card card-pad stack"><h2>Acesso restrito</h2><p class="muted">Seu perfil (${ROLE[S.me.user.role]}) não tem acesso a esta área. Fale com o administrador se precisar.</p></div>`); return; }
  const m = path.match(r.re);
  const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  const keepScroll = render.keepScroll; render.keepScroll = false;
  const y = window.scrollY;
  if (!keepScroll) main.innerHTML = val(skeleton());
  try {
    const out = await r.view({ params, query });
    if (seq !== renderSeq) return;
    main.innerHTML = val(out.html);
    document.title = `${out.title} · Fluxo`;
    if (out.after) out.after(main);
    window.scrollTo(0, keepScroll ? y : 0);
  } catch (e) {
    if (seq !== renderSeq) return;
    if (e.status === 401) return;
    main.innerHTML = val(errorBox(e));
  }
}
// Recarrega a tela atual preservando a posição de rolagem.
function refresh() { render.keepScroll = true; return render(); }

async function loadSession() {
  S.me = await GET('/api/me');
  S.meta = await GET('/api/meta');
  S.locale = S.me.company.locale || 'pt-BR';
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACT[el.dataset.act];
  if (!fn) return;
  // Checkboxes e radios precisam manter o comportamento nativo (marcar/desmarcar).
  if (!(el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio'))) e.preventDefault();
  fn(el, e);
});
document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const fn = FORMS[f.dataset.form];
  if (fn) safe(Promise.resolve(fn(f, formData(f))));
});
ACT['close-modal'] = closeModal;
ACT['close-drawer'] = closeDrawer;
ACT.reload = () => render();
ACT.reveal = (el) => { const target = document.getElementById(el.dataset.target); if (target) { target.classList.remove('hidden'); el.remove(); const i = target.querySelector('input,textarea,select'); if (i) i.focus(); } };
ACT.go = (el) => go(el.dataset.href);
