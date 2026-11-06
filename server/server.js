// Servidor HTTP: autenticação por sessão, isolamento por empresa e permissões
// aplicadas em cada rota. A interface apenas reflete o que o servidor autoriza.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { HttpError, bad, clock, today, hashPassword, checkPassword, token, parse, v, audit, one, permsFor, ASSISTANT_TOGGLES } = require('./util');
const db = require('./db').open(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'fluxo.db'));
const engine = require('./engine');
const crm = require('./svc-crm');
const ops = require('./svc-ops');
const fin = require('./svc-fin');
const integrations = require('./integrations');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, '..', 'public');
const SESSION_DAYS = 14;

// ---------------- Roteador ----------------
const routes = [];
function route(method, pattern, perm, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, perm, handler });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(new HttpError(413, 'Requisição muito grande.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(bad('JSON inválido.')); }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

function sessionCtx(req) {
  const sid = cookies(req).sid || (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!sid) return null;
  const s = db.get('SELECT * FROM sessions WHERE token = ?', sid);
  if (!s || s.expires_at < clock.iso()) return null;
  const user = db.get('SELECT * FROM users WHERE id = ? AND company_id = ? AND active = 1', s.user_id, s.company_id);
  if (!user) return null;
  const company = db.get('SELECT * FROM companies WHERE id = ?', s.company_id);
  return { db, user, company, perms: permsFor(user), sid };
}

function need(ctx, perm) {
  if (!perm) return;
  const list = Array.isArray(perm) ? perm : [perm];
  if (!list.some((p) => ctx.perms[p])) throw new HttpError(403, 'Seu perfil não tem permissão para esta área.');
}

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  if (p.startsWith('/q/')) p = '/quote.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      if (!path.extname(p)) return serveStatic(req, res, '/index.html');
      res.writeHead(404); return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  try {
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) throw new HttpError(404, 'Rota não encontrada.');
    const m = url.pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
    const query = Object.fromEntries(url.searchParams);
    let ctx = null;
    if (r.perm !== 'public') {
      ctx = sessionCtx(req);
      if (!ctx) throw new HttpError(401, 'Sessão expirada. Entre novamente.');
      if (r.perm !== 'any') need(ctx, r.perm);
    }
    const out = await r.handler({ ctx, params, body, query, req, res });
    // Etapas imediatas (ex.: confirmação de agendamento) saem logo após a ação que as gerou.
    if (req.method !== 'GET') { if (ctx) engine.processDue(ctx); else processAll(); }
    if (out && out.__raw) return; // resposta já enviada
    send(res, 200, out ?? { ok: true });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
    console.error(e);
    send(res, 500, { error: 'Erro inesperado no servidor. Tente novamente; se persistir, avise o suporte.' });
  }
});

// ---------------- Autenticação ----------------
route('POST', '/api/login', 'public', ({ body, res }) => {
  const email = String(body.email || '').trim().toLowerCase();
  const user = db.get('SELECT * FROM users WHERE email = ? AND active = 1', email);
  if (!user || !checkPassword(String(body.password || ''), user.password_hash)) throw new HttpError(401, 'E-mail ou senha incorretos.');
  const sid = token();
  db.insert('sessions', { token: sid, user_id: user.id, company_id: user.company_id, created_at: clock.iso(), expires_at: new Date(clock.now() + SESSION_DAYS * 86400000).toISOString() });
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
  return { ok: true, token: sid };
});
route('POST', '/api/logout', 'any', ({ ctx, res }) => {
  db.run('DELETE FROM sessions WHERE token = ?', ctx.sid);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  return { ok: true };
});
// Lista de acessos de demonstração (somente empresas marcadas como demo).
route('GET', '/api/demo-users', 'public', () => db.all(`SELECT u.email, u.name, u.role, c.name AS company FROM users u JOIN companies c ON c.id = u.company_id WHERE c.demo = 1 AND u.active = 1 ORDER BY c.id, CASE u.role WHEN 'owner' THEN 0 WHEN 'assistant' THEN 1 ELSE 2 END, u.id`));

route('GET', '/api/me', 'any', ({ ctx }) => ({
  user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email, role: ctx.user.role, crew_id: ctx.user.crew_id },
  company: { id: ctx.company.id, name: ctx.company.name, timezone: ctx.company.timezone, locale: ctx.company.locale, currency: ctx.company.currency, demo: !!ctx.company.demo },
  perms: ctx.perms, today: today(ctx), now: clock.iso(),
}));

route('GET', '/api/meta', 'any', ({ ctx }) => ({
  users: db.all('SELECT id, name, role, crew_id FROM users WHERE company_id = ? AND active = 1 ORDER BY name', ctx.company.id),
  crews: db.all('SELECT id, name, color FROM crews WHERE company_id = ? ORDER BY id', ctx.company.id),
  sources: crm.SOURCES, methods: fin.METHODS, expense_categories: fin.EXPENSE_CATEGORIES, automation: engine.catalog(),
}));

// ---------------- Visão do dia ----------------
route('GET', '/api/today', 'any', ({ ctx }) => fin.todayView(ctx));

// ---------------- Clientes ----------------
route('GET', '/api/clients', 'clients', ({ ctx, query }) => crm.listClients(ctx, query));
route('POST', '/api/clients/check-duplicates', ['clients', 'sales'], ({ ctx, body }) => crm.findDuplicates(ctx, body));
route('POST', '/api/clients', 'clients', ({ ctx, body }) => ({ id: db.tx(() => crm.createClient(ctx, body)) }));
route('GET', '/api/clients/:id', 'clients', ({ ctx, params }) => crm.getClient(ctx, params.id));
route('PATCH', '/api/clients/:id', 'clients', ({ ctx, params, body }) => ({ id: db.tx(() => crm.updateClient(ctx, params.id, body)) }));
route('POST', '/api/clients/:id/addresses', 'clients', ({ ctx, params, body }) => ({ id: db.tx(() => crm.addAddress(ctx, params.id, body)) }));
route('POST', '/api/clients/:id/channels', 'clients', ({ ctx, params, body }) => db.tx(() => crm.setChannel(ctx, params.id, body.channel, body)));
route('POST', '/api/clients/:id/takeover', 'clients', ({ ctx, params, body }) => db.tx(() => crm.takeover(ctx, params.id, !!body.paused)));
route('POST', '/api/clients/:id/simulate-inbound', 'clients', ({ ctx, params, body }) => db.tx(() => crm.simulateInbound(ctx, params.id, body)));
route('POST', '/api/clients/:id/complaints', 'clients', ({ ctx, params, body }) => ({ task_id: db.tx(() => crm.openComplaint(ctx, params.id, body)) }));
route('POST', '/api/clients/:id/notes', 'clients', ({ ctx, params, body }) => {
  const c = one(ctx, 'clients', params.id, 'Cliente');
  const text = v.str(body.text, 'Anotação', { required: true, max: 2000 });
  db.insert('communications', { company_id: ctx.company.id, client_id: c.id, direction: 'note', channel: body.channel || 'internal', body: text, status: 'logged', simulated: 0, kind: 'note', created_by: ctx.user.id, created_at: clock.iso() });
  audit(ctx, 'client', c.id, 'Contato registrado manualmente', { client_id: c.id, details: text.slice(0, 120) });
  return { ok: true };
});

// ---------------- Comercial ----------------
route('POST', '/api/leads', ['sales', 'clients'], ({ ctx, body }) => crm.createLead(ctx, body));
route('GET', '/api/opportunities', 'sales', ({ ctx }) => crm.listOpportunities(ctx));
route('PATCH', '/api/opportunities/:id', 'sales', ({ ctx, params, body }) => ({ id: db.tx(() => crm.updateOpportunity(ctx, params.id, body)) }));
route('GET', '/api/quotes', 'sales', ({ ctx, query }) => crm.listQuotes(ctx, query));
route('POST', '/api/quotes', 'sales', ({ ctx, body }) => ({ id: crm.createQuote(ctx, body) }));
route('GET', '/api/quotes/:id', 'sales', ({ ctx, params }) => crm.getQuote(ctx, params.id));
route('PATCH', '/api/quotes/:id', 'sales', ({ ctx, params, body }) => ({ id: crm.updateQuote(ctx, params.id, body) }));
route('POST', '/api/quotes/:id/send', 'sales', ({ ctx, params, body }) => crm.sendQuote(ctx, params.id, body));
route('POST', '/api/quotes/:id/approve', 'sales', ({ ctx, params }) => crm.approveQuote(ctx, params.id, { via: 'staff' }));
route('POST', '/api/quotes/:id/decline', 'sales', ({ ctx, params, body }) => crm.declineQuote(ctx, params.id, { reason: body.reason }));

// Página pública do orçamento (link enviado ao cliente). Contexto restrito à empresa do orçamento.
function publicCtx(tok) {
  const q = db.get('SELECT * FROM quotes WHERE public_token = ?', String(tok));
  if (!q) throw new HttpError(404, 'Orçamento não encontrado ou link inválido.');
  const company = db.get('SELECT * FROM companies WHERE id = ?', q.company_id);
  return { ctx: { db, company, user: null, perms: {} }, q };
}
route('GET', '/api/public/quotes/:token', 'public', ({ params }) => {
  const { ctx, q } = publicCtx(params.token);
  const full = crm.getQuote(ctx, q.id);
  return {
    company: { name: ctx.company.name, phone: ctx.company.phone, email: ctx.company.email, demo: !!ctx.company.demo },
    quote: { number: full.number, title: full.title, status: full.status, total: full.total, valid_until: full.valid_until, notes: full.notes, frequency: full.frequency,
      terms_label: full.terms_label, payment_terms: full.payment_terms, deposit_amount: full.deposit_amount, items: full.items.map((i) => ({ description: i.description, details: i.details, quantity: i.quantity, unit_price: i.unit_price })),
      expired: full.valid_until < today(ctx) },
    client: { name: full.client.name }, address: full.address ? { line1: full.address.line1, city: full.address.city, state: full.address.state, zip: full.address.zip } : null,
  };
});
route('POST', '/api/public/quotes/:token/approve', 'public', ({ params }) => { const { ctx, q } = publicCtx(params.token); crm.approveQuote(ctx, q.id, { via: 'client' }); return { ok: true }; });
route('POST', '/api/public/quotes/:token/decline', 'public', ({ params, body }) => { const { ctx, q } = publicCtx(params.token); crm.declineQuote(ctx, q.id, { reason: body.reason, via: 'client' }); return { ok: true }; });

// ---------------- Agenda e execução ----------------
route('GET', '/api/jobs', ['schedule', 'field'], ({ ctx, query }) => ops.listJobs(ctx, query));
route('POST', '/api/jobs', 'schedule', ({ ctx, body }) => ({ id: db.tx(() => ops.createJob(ctx, body)) }));
route('GET', '/api/jobs/:id', ['schedule', 'field'], ({ ctx, params }) => ops.getJob(ctx, params.id));
route('PATCH', '/api/jobs/:id', 'schedule', ({ ctx, params, body }) => ({ id: db.tx(() => ops.updateJob(ctx, params.id, body)) }));
route('POST', '/api/jobs/:id/schedule', 'schedule', ({ ctx, params, body }) => ops.scheduleJob(ctx, params.id, body));
route('POST', '/api/jobs/:id/conflicts', 'schedule', ({ ctx, params, body }) => {
  const job = one(ctx, 'jobs', params.id, 'Serviço');
  if (!v.date(body.date, 'Data') || !v.time(body.time, 'Horário')) return [];
  const { TZ } = require('./util');
  return ops.findConflicts(ctx, { crew_id: Number(body.crew_id), start_at: TZ.toUtc(body.date, body.time, ctx.company.timezone), duration_min: Number(body.duration_min) || job.duration_min, exclude_ids: [job.id] });
});
route('POST', '/api/jobs/:id/action', ['schedule', 'field'], ({ ctx, params, body }) => ops.jobAction(ctx, params.id, body.action, body));
route('POST', '/api/jobs/:id/checklist', ['schedule', 'field'], ({ ctx, params, body }) => db.tx(() => ops.toggleChecklist(ctx, params.id, Number(body.index), !!body.done)));
route('POST', '/api/jobs/:id/time', ['schedule', 'field'], ({ ctx, params, body }) => db.tx(() => ops.addTime(ctx, params.id, body)));
route('POST', '/api/jobs/:id/costs', ['schedule', 'field', 'finance'], ({ ctx, params, body }) => ({ id: db.tx(() => ops.addJobCost(ctx, params.id, body)) }));
route('POST', '/api/jobs/:id/costs-complete', 'finance', ({ ctx, params, body }) => db.tx(() => ops.setCostsComplete(ctx, params.id, !!body.complete)));
route('POST', '/api/jobs/:id/invoice', 'finance', ({ ctx, params }) => fin.invoiceJob(ctx, params.id));

// ---------------- Financeiro ----------------
route('GET', '/api/finance/summary', 'finance', ({ ctx, query }) => fin.financeSummary(ctx, query));
route('GET', '/api/invoices', 'finance', ({ ctx, query }) => fin.listInvoices(ctx, query));
route('POST', '/api/invoices', 'finance', ({ ctx, body }) => db.tx(() => fin.createInvoice(ctx, body)));
route('GET', '/api/invoices/:id', 'finance', ({ ctx, params }) => fin.getInvoice(ctx, params.id));
route('POST', '/api/invoices/:id/payments', 'finance', ({ ctx, params, body }) => fin.recordPayment(ctx, params.id, body));
route('POST', '/api/invoices/:id/void', 'finance', ({ ctx, params, body }) => fin.voidInvoice(ctx, params.id, body));
route('POST', '/api/expenses', 'finance', ({ ctx, body }) => ({ id: db.tx(() => fin.createExpense(ctx, body)) }));
route('POST', '/api/incomes', 'finance', ({ ctx, body }) => ({ id: db.tx(() => fin.createIncome(ctx, body)) }));

// ---------------- Tarefas ----------------
route('GET', '/api/tasks', ['tasks', 'field'], ({ ctx, query }) => crm.listTasks(ctx, query));
route('POST', '/api/tasks', 'tasks', ({ ctx, body }) => ({ id: db.tx(() => crm.createTask(ctx, body)) }));
route('PATCH', '/api/tasks/:id', ['tasks', 'field'], ({ ctx, params, body }) => ({ id: db.tx(() => crm.updateTask(ctx, params.id, body)) }));

// ---------------- Jornadas e automações ----------------
function journeyStats(ctx, id) {
  const g = (sql) => db.get(sql, ctx.company.id, id).n;
  return {
    active: g(`SELECT COUNT(*) AS n FROM enrollments WHERE company_id = ? AND journey_id = ? AND status = 'active'`),
    paused: g(`SELECT COUNT(*) AS n FROM enrollments WHERE company_id = ? AND journey_id = ? AND status = 'paused'`),
    pending: g(`SELECT COUNT(*) AS n FROM scheduled_messages WHERE company_id = ? AND journey_id = ? AND status = 'pending'`),
    sent: g(`SELECT COUNT(*) AS n FROM scheduled_messages WHERE company_id = ? AND journey_id = ? AND status = 'sent'`),
    blocked: g(`SELECT COUNT(*) AS n FROM scheduled_messages WHERE company_id = ? AND journey_id = ? AND status = 'blocked'`),
  };
}
const journeyOut = (j) => ({ ...j, triggers: parse(j.triggers, []), conditions: parse(j.conditions, []), steps: parse(j.steps, []), rules: parse(j.rules, {}), active: !!j.active });
route('GET', '/api/journeys', 'journeys', ({ ctx }) => db.all('SELECT * FROM journeys WHERE company_id = ? ORDER BY id', ctx.company.id).map((j) => ({ ...journeyOut(j), stats: journeyStats(ctx, j.id) })));
route('GET', '/api/journeys/:id', 'journeys', ({ ctx, params }) => {
  const j = one(ctx, 'journeys', params.id, 'Jornada');
  const users = crm.usersMap(ctx);
  return {
    ...journeyOut(j), stats: journeyStats(ctx, j.id), owner: users[j.owner_id]?.name,
    queue: db.all(`SELECT m.*, c.name AS client_name, e.status AS enrollment_status, e.pause_reason, e.entity_type, e.entity_id FROM scheduled_messages m JOIN clients c ON c.id = m.client_id JOIN enrollments e ON e.id = m.enrollment_id
      WHERE m.company_id = ? AND m.journey_id = ? ORDER BY CASE m.status WHEN 'pending' THEN 0 ELSE 1 END, CASE m.status WHEN 'pending' THEN m.send_at END ASC, m.updated_at DESC LIMIT 200`, ctx.company.id, j.id),
    log: db.all(`SELECT l.*, c.name AS client_name FROM journey_log l LEFT JOIN clients c ON c.id = l.client_id WHERE l.company_id = ? AND l.journey_id = ? ORDER BY l.id DESC LIMIT 200`, ctx.company.id, j.id)
      .map((l) => ({ ...l, user: l.user_id ? users[l.user_id]?.name : 'Automação' })),
  };
});
route('PATCH', '/api/journeys/:id', 'journeys', ({ ctx, params, body }) => {
  const j = one(ctx, 'journeys', params.id, 'Jornada');
  const cat = engine.catalog();
  const patch = { updated_at: clock.iso() };
  if ('name' in body) patch.name = v.str(body.name, 'Nome', { required: true, max: 100 });
  if ('active' in body) patch.active = body.active ? 1 : 0;
  if ('owner_id' in body) patch.owner_id = one(ctx, 'users', body.owner_id, 'Responsável').id;
  if ('conditions' in body) {
    if (!Array.isArray(body.conditions) || body.conditions.some((c) => !(c in cat.conditions))) throw bad('Condição inválida.');
    patch.conditions = body.conditions;
  }
  if ('rules' in body) patch.rules = { pause_on_reply: !!body.rules.pause_on_reply };
  if ('steps' in body) {
    if (!Array.isArray(body.steps) || !body.steps.length) throw bad('A jornada precisa de pelo menos uma etapa.');
    if (body.steps.length > 8) throw bad('Use no máximo 8 etapas por jornada.');
    patch.steps = body.steps.map((s, i) => ({
      anchor: v.oneOf(s.anchor, Object.keys(cat.anchors), `Etapa ${i + 1}: referência`),
      offset_minutes: v.num(s.offset_minutes, `Etapa ${i + 1}: prazo`, { min: -60 * 24 * 60, max: 60 * 24 * 90 }),
      send_hour: s.send_hour === '' || s.send_hour == null ? null : v.num(s.send_hour, `Etapa ${i + 1}: horário`, { min: 6, max: 21 }),
      channel: v.oneOf(s.channel, Object.keys(cat.channels), `Etapa ${i + 1}: canal`),
      subject: v.str(s.subject, `Etapa ${i + 1}: assunto`, { max: 160 }),
      body: v.str(s.body, `Etapa ${i + 1}: mensagem`, { required: true, max: 1500 }),
    }));
  }
  db.update('journeys', j.id, ctx.company.id, patch);
  engine.log(ctx, j.id, null, null, 'edited', `Jornada editada por ${ctx.user.name}${'active' in body ? (body.active ? ' (ativada)' : ' (desativada)') : ''}. Alterações valem para novas inscrições.`);
  return { ok: true };
});
route('POST', '/api/automation/run', 'journeys', ({ ctx }) => engine.processDue(ctx));
route('POST', '/api/scheduled-messages/:id/send-now', 'journeys', ({ ctx, params }) => db.tx(() => {
  const m = one(ctx, 'scheduled_messages', params.id, 'Mensagem agendada');
  if (m.status !== 'pending') throw bad('Esta etapa não está mais pendente.');
  engine.log(ctx, m.journey_id, m.enrollment_id, m.client_id, 'forced', `Envio antecipado solicitado por ${ctx.user.name} (demonstração).`);
  return engine.deliver(ctx, m);
}));
route('POST', '/api/enrollments/:id/:action', 'journeys', ({ ctx, params }) => db.tx(() => {
  const e = one(ctx, 'enrollments', params.id, 'Inscrição');
  if (params.action === 'pause') { if (e.status !== 'active') throw bad('A sequência não está ativa.'); engine.pauseEnrollments(ctx, 'e.id = ?', [e.id], 'human'); }
  else if (params.action === 'resume') {
    if (e.status !== 'paused') throw bad('A sequência não está pausada.');
    if (e.pause_reason === 'complaint' && engine.hasOpenComplaint(ctx, e.client_id)) throw bad('Resolva a reclamação em aberto antes de retomar ofertas comerciais.');
    engine.resumeEnrollments(ctx, 'e.id = ?', [e.id]);
  } else if (params.action === 'stop') engine.stopEnrollments(ctx, 'e.id = ?', [e.id], `encerrada manualmente por ${ctx.user.name}`);
  else throw bad('Ação inválida.');
  return { ok: true };
}));

// ---------------- Gestão de time (somente o dono) ----------------
const team = require('./svc-team');
route('GET', '/api/team', 'team', ({ ctx, query }) => team.overview(ctx, query));
route('GET', '/api/team/report', 'team', ({ ctx, query }) => team.teamReport(ctx, query));
route('GET', '/api/team/members/:id', 'team', ({ ctx, params, query }) => team.memberDetail(ctx, params.id, query));
route('PATCH', '/api/team/members/:id/profile', 'team', ({ ctx, params, body }) => db.tx(() => team.saveProfile(ctx, params.id, body)));
route('POST', '/api/team/reviews', 'team', ({ ctx, body }) => db.tx(() => team.saveReview(ctx, body)));
route('POST', '/api/team/pdi', 'team', ({ ctx, body }) => ({ id: db.tx(() => team.createGoal(ctx, body)) }));
route('PATCH', '/api/team/pdi/:id', 'team', ({ ctx, params, body }) => ({ id: db.tx(() => team.updateGoal(ctx, params.id, body)) }));
route('POST', '/api/team/bonuses', 'team', ({ ctx, body }) => team.createBonus(ctx, body));
route('POST', '/api/team/bonuses/:id/pay', 'team', ({ ctx, params, body }) => team.payBonus(ctx, params.id, body));
route('POST', '/api/team/bonuses/:id/cancel', 'team', ({ ctx, params }) => db.tx(() => team.cancelBonus(ctx, params.id)));
route('GET', '/api/team/rules', 'team', ({ ctx }) => team.listRules(ctx));
route('POST', '/api/team/rules', 'team', ({ ctx, body }) => ({ id: db.tx(() => team.saveRule(ctx, null, body)) }));
route('PATCH', '/api/team/rules/:id', 'team', ({ ctx, params, body }) => ({ id: db.tx(() => team.saveRule(ctx, params.id, body)) }));

// ---------------- Configurações ----------------
route('GET', '/api/settings', 'settings', ({ ctx }) => ({
  company: ctx.company,
  users: db.all('SELECT id, name, email, phone, role, crew_id, hourly_cost, permissions, active FROM users WHERE company_id = ? ORDER BY role, name', ctx.company.id).map((u) => ({ ...u, permissions: permsFor(u) })),
  crews: db.all('SELECT * FROM crews WHERE company_id = ?', ctx.company.id),
  integrations: integrations.status(), assistant_toggles: ASSISTANT_TOGGLES,
}));
route('PATCH', '/api/settings/company', 'settings', ({ ctx, body }) => {
  const patch = {};
  if ('name' in body) patch.name = v.str(body.name, 'Nome da empresa', { required: true, max: 120 });
  if ('timezone' in body) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: body.timezone }); } catch { throw bad('Fuso horário inválido.'); }
    patch.timezone = body.timezone;
  }
  if ('locale' in body) patch.locale = v.oneOf(body.locale, ['pt-BR', 'en-US', 'es-US'], 'Idioma');
  if ('phone' in body) patch.phone = v.phone(body.phone);
  if ('email' in body) patch.email = v.email(body.email);
  db.update('companies', ctx.company.id, ctx.company.id, patch);
  audit(ctx, 'company', ctx.company.id, 'Configurações da empresa alteradas', { details: Object.keys(patch).join(', ') });
  return { ok: true };
});
route('PATCH', '/api/settings/users/:id', 'settings', ({ ctx, body, params }) => {
  const u = one(ctx, 'users', params.id, 'Usuário');
  const patch = {};
  if ('permissions' in body) {
    if (u.role !== 'assistant') throw bad('Permissões personalizadas se aplicam apenas a assistentes/VAs.');
    const p = {}; for (const k of ASSISTANT_TOGGLES) if (k in body.permissions) p[k] = !!body.permissions[k];
    patch.permissions = p;
  }
  if ('hourly_cost' in body) patch.hourly_cost = v.cents(body.hourly_cost, 'Custo por hora');
  if ('crew_id' in body) patch.crew_id = body.crew_id ? one(ctx, 'crews', body.crew_id, 'Equipe').id : null;
  db.update('users', u.id, ctx.company.id, patch);
  audit(ctx, 'user', u.id, `Usuário ${u.name} atualizado`, { details: Object.keys(patch).join(', ') });
  return { ok: true };
});
route('POST', '/api/demo/reset', 'settings', ({ ctx }) => {
  if (!ctx.company.demo) throw bad('Disponível apenas em empresas de demonstração.');
  require('./seed').seed(db);
  return { ok: true };
});
route('POST', '/api/integrations/:provider/webhook', 'public', ({ params }) => {
  throw new HttpError(501, `Integração "${params.provider}" ainda não conectada. Este endpoint receberá confirmações de entrega, respostas e pagamentos quando o provedor for configurado.`);
});

// ---------------- Inicialização ----------------
function processAll() {
  for (const company of db.all('SELECT * FROM companies')) {
    try { engine.processDue({ db, company, user: null, perms: {} }); } catch (e) { console.error('Falha ao processar fila', company.id, e); }
  }
}

if (require.main === module) {
  if (!db.get('SELECT id FROM companies LIMIT 1')) { console.log('Banco vazio: carregando dados de demonstração...'); require('./seed').seed(db); }
  processAll();
  setInterval(processAll, 30000);
  server.listen(PORT, () => console.log(`Fluxo rodando em http://localhost:${PORT} (modo demonstração: nenhum envio ou cobrança real)`));
}

module.exports = { server, db, processAll };
