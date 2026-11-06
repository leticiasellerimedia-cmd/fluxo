// Clientes, contatos, oportunidades, orçamentos e tarefas.
const { HttpError, bad, clock, today, token, parse, v, audit, one, TZ } = require('./util');
const engine = require('./engine');

const SOURCES = ['Google', 'Indicação', 'Facebook/Instagram', 'Nextdoor', 'Thumbtack', 'Site', 'Panfleto', 'Outro'];
const STAGES = ['new', 'contacted', 'quote_sent', 'approved', 'lost'];
const FREQUENCIES = ['one_time', 'weekly', 'biweekly', 'monthly'];

const now = () => clock.iso();
const C = (ctx) => ctx.company.id;

function defaultChannels({ email, phone }, source = 'cadastro') {
  const at = now();
  return {
    email: { allowed: !!email, optout_at: null, consent_at: email ? at : null, source },
    sms: { allowed: !!phone, optout_at: null, consent_at: phone ? at : null, source },
    whatsapp: { allowed: false, optout_at: null, consent_at: null, source: null },
  };
}

function usersMap(ctx) {
  const m = {};
  for (const u of ctx.db.all('SELECT id, name, role FROM users WHERE company_id = ?', C(ctx))) m[u.id] = u;
  return m;
}

function setNextAction(ctx, clientId, text, due, ownerId, { opportunityId = null } = {}) {
  ctx.db.update('clients', clientId, C(ctx), { next_action: text, next_action_due: due, next_action_owner_id: ownerId, updated_at: now() });
  if (opportunityId) ctx.db.update('opportunities', opportunityId, C(ctx), { next_action: text, next_action_due: due, updated_at: now() });
}

// ---------------- Clientes ----------------

const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, '').trim();

function findDuplicates(ctx, { name, phone, email, exclude_id = null }) {
  const rows = ctx.db.all('SELECT id, name, phone, email FROM clients WHERE company_id = ?', C(ctx));
  const p = digits(phone); const e = String(email || '').trim().toLowerCase(); const n = norm(name);
  const out = [];
  for (const r of rows) {
    if (exclude_id && r.id === Number(exclude_id)) continue;
    const reasons = [];
    if (p && p.length === 10 && digits(r.phone) === p) reasons.push('mesmo telefone');
    if (e && r.email && r.email.toLowerCase() === e) reasons.push('mesmo e-mail');
    if (n && n.length > 3 && norm(r.name) === n) reasons.push('mesmo nome');
    if (reasons.length) out.push({ ...r, reasons });
  }
  return out;
}

function listClients(ctx, { q = '' } = {}) {
  const like = `%${String(q).trim()}%`;
  const qd = digits(q);
  const rows = ctx.db.all(`SELECT c.*,
      (SELECT COUNT(*) FROM jobs j WHERE j.client_id = c.id AND j.company_id = c.company_id AND j.status = 'completed') AS jobs_done,
      (SELECT MIN(start_at) FROM jobs j WHERE j.client_id = c.id AND j.company_id = c.company_id AND j.status = 'scheduled' AND j.start_at > ?) AS next_job_at,
      (SELECT city FROM addresses a WHERE a.client_id = c.id ORDER BY a.id LIMIT 1) AS city
    FROM clients c WHERE c.company_id = ? AND (? = '' OR c.name LIKE ? OR c.email LIKE ? OR (? <> '' AND REPLACE(REPLACE(REPLACE(REPLACE(c.phone,'(',''),')',''),'-',''),' ','') LIKE ?))
    ORDER BY c.name COLLATE NOCASE`, now(), C(ctx), String(q).trim(), like, like, qd, `%${qd}%`);
  const users = usersMap(ctx);
  return rows.map((r) => ({ ...r, channels: parse(r.channels, {}), next_action_owner: users[r.next_action_owner_id]?.name || null, has_open_complaint: engine.hasOpenComplaint(ctx, r.id) }));
}

function validateAddress(a) {
  return {
    label: v.str(a.label, 'Nome do endereço', { max: 60 }) || 'Principal',
    line1: v.str(a.line1, 'Endereço', { required: true, max: 200 }),
    line2: v.str(a.line2, 'Complemento', { max: 100 }),
    city: v.str(a.city, 'Cidade', { max: 80 }),
    state: (v.str(a.state, 'Estado', { max: 2 }) || '').toUpperCase() || null,
    zip: (() => { const z = v.str(a.zip, 'ZIP', { max: 10 }); if (z && !/^\d{5}(-\d{4})?$/.test(z)) throw bad('ZIP inválido. Use 5 dígitos, ex.: 32801.'); return z; })(),
    access_notes: v.str(a.access_notes, 'Instruções de acesso', { max: 500 }),
  };
}

function createClient(ctx, data) {
  const name = v.str(data.name, 'Nome', { required: true, max: 120 });
  const phone = v.phone(data.phone);
  const email = v.email(data.email);
  if (!phone && !email) throw bad('Informe pelo menos um telefone ou e-mail.');
  const source = v.str(data.source, 'Origem', { max: 60 });
  if (!data.ignore_duplicates) {
    const dups = findDuplicates(ctx, { name, phone, email });
    if (dups.length) throw new HttpError(409, 'Possível cliente duplicado.', { duplicates: dups });
  }
  const at = now();
  const id = ctx.db.insert('clients', {
    company_id: C(ctx), name, phone, email, source, preferences: v.str(data.preferences, 'Preferências', { max: 1000 }),
    notes: v.str(data.notes, 'Observações', { max: 2000 }), channels: defaultChannels({ email, phone }, 'formulário de contato'),
    created_by: ctx.user?.id, created_at: at, updated_at: at,
  });
  if (data.address && data.address.line1) addAddress(ctx, id, data.address, { silent: true });
  audit(ctx, 'client', id, 'Cliente cadastrado', { client_id: id, details: source ? `Origem: ${source}` : null });
  return id;
}

function addAddress(ctx, clientId, data, { silent = false } = {}) {
  one(ctx, 'clients', clientId, 'Cliente');
  const a = validateAddress(data);
  const id = ctx.db.insert('addresses', { company_id: C(ctx), client_id: Number(clientId), ...a, created_at: now() });
  if (!silent) audit(ctx, 'client', Number(clientId), 'Endereço adicionado', { client_id: Number(clientId), details: a.line1 });
  return id;
}

function updateClient(ctx, id, data) {
  const c = one(ctx, 'clients', id, 'Cliente');
  const patch = { updated_at: now() };
  if ('name' in data) patch.name = v.str(data.name, 'Nome', { required: true, max: 120 });
  if ('phone' in data) patch.phone = v.phone(data.phone);
  if ('email' in data) patch.email = v.email(data.email);
  if ('source' in data) patch.source = v.str(data.source, 'Origem', { max: 60 });
  if ('preferences' in data) patch.preferences = v.str(data.preferences, 'Preferências', { max: 1000 });
  if ('notes' in data) patch.notes = v.str(data.notes, 'Observações', { max: 2000 });
  const phone = 'phone' in patch ? patch.phone : c.phone; const email = 'email' in patch ? patch.email : c.email;
  if (!phone && !email) throw bad('O cliente precisa de pelo menos um telefone ou e-mail.');
  if ('next_action' in data) {
    patch.next_action = v.str(data.next_action, 'Próxima ação', { max: 200 });
    patch.next_action_due = v.date(data.next_action_due, 'Prazo da próxima ação', { required: !!patch.next_action });
    patch.next_action_owner_id = data.next_action_owner_id ? one(ctx, 'users', data.next_action_owner_id, 'Responsável').id : null;
    if (patch.next_action && !patch.next_action_owner_id) throw bad('Defina o responsável pela próxima ação.');
  }
  ctx.db.update('clients', c.id, C(ctx), patch);
  // Novos canais informados passam a ser autorizados apenas se o cliente nunca se descadastrou.
  const ch = parse(c.channels, {});
  if (patch.email && !c.email && !ch.email?.optout_at) ch.email = { ...ch.email, allowed: true, consent_at: now(), source: 'edição de cadastro' };
  if (patch.phone && !c.phone && !ch.sms?.optout_at) ch.sms = { ...ch.sms, allowed: true, consent_at: now(), source: 'edição de cadastro' };
  ctx.db.update('clients', c.id, C(ctx), { channels: ch });
  audit(ctx, 'client', c.id, 'next_action' in data ? 'Próxima ação atualizada' : 'Cadastro atualizado', { client_id: c.id, details: patch.next_action || null });
  return c.id;
}

function setChannel(ctx, clientId, channel, { allowed, optout = false, source = null }) {
  const c = one(ctx, 'clients', clientId, 'Cliente');
  v.oneOf(channel, ['email', 'sms', 'whatsapp'], 'Canal');
  const ch = parse(c.channels, {});
  const cur = ch[channel] || {};
  if (optout) {
    ch[channel] = { ...cur, allowed: false, optout_at: now(), optout_source: source || 'registro manual' };
  } else if (allowed) {
    if (channel === 'whatsapp' && !c.phone) throw bad('Cadastre um telefone antes de autorizar WhatsApp.');
    if (channel === 'email' && !c.email) throw bad('Cadastre um e-mail antes de autorizar este canal.');
    if (channel === 'sms' && !c.phone) throw bad('Cadastre um telefone antes de autorizar SMS.');
    ch[channel] = { allowed: true, optout_at: null, consent_at: now(), source: source || 'autorização registrada pela equipe', previous_optout_at: cur.optout_at || null };
  } else {
    ch[channel] = { ...cur, allowed: false };
  }
  ctx.db.update('clients', c.id, C(ctx), { channels: ch, updated_at: now() });
  const label = { email: 'E-mail', sms: 'SMS', whatsapp: 'WhatsApp' }[channel];
  audit(ctx, 'client', c.id, optout ? `Descadastro registrado (${label})` : allowed ? `Canal autorizado (${label})` : `Canal desativado (${label})`, { client_id: c.id, details: source });
  if (optout || !allowed) engine.emit(ctx, 'channel.optout', { entity_type: 'client', entity_id: c.id, client_id: c.id, key: `optout:${c.id}:${channel}:${now()}`, payload: { channel } });
}

function takeover(ctx, clientId, paused) {
  const c = one(ctx, 'clients', clientId, 'Cliente');
  if (paused) {
    ctx.db.update('clients', c.id, C(ctx), { automation_paused: 1, automation_paused_by: ctx.user.id, automation_paused_at: now(), updated_at: now() });
    const n = engine.pauseEnrollments(ctx, 'e.client_id = ?', [c.id], 'human').length;
    audit(ctx, 'client', c.id, 'Atendimento assumido; automações pausadas', { client_id: c.id, details: `${n} sequência(s) pausada(s)` });
  } else {
    ctx.db.update('clients', c.id, C(ctx), { automation_paused: 0, automation_paused_by: null, automation_paused_at: null, updated_at: now() });
    const n = engine.resumeEnrollments(ctx, `e.client_id = ? AND e.pause_reason IN ('human','client_replied')`, [c.id]);
    audit(ctx, 'client', c.id, 'Automações retomadas', { client_id: c.id, details: `${n} sequência(s) retomada(s)` });
  }
}

function getClient(ctx, id) {
  const c = one(ctx, 'clients', id, 'Cliente');
  const cid = C(ctx);
  const users = usersMap(ctx);
  const finance = ctx.perms.finance;
  const invoices = finance ? ctx.db.all('SELECT * FROM invoices WHERE company_id = ? AND client_id = ? ORDER BY issued_at DESC', cid, c.id).map((i) => ({ ...i, balance: i.status === 'void' ? 0 : engine.balanceOf(ctx, i) })) : null;
  return {
    ...c,
    channels: parse(c.channels, {}),
    next_action_owner: users[c.next_action_owner_id]?.name || null,
    automation_paused_by_name: users[c.automation_paused_by]?.name || null,
    has_open_complaint: engine.hasOpenComplaint(ctx, c.id),
    addresses: ctx.db.all('SELECT * FROM addresses WHERE company_id = ? AND client_id = ? ORDER BY id', cid, c.id),
    opportunities: ctx.db.all('SELECT * FROM opportunities WHERE company_id = ? AND client_id = ? ORDER BY id DESC', cid, c.id).map((o) => ({ ...o, owner: users[o.owner_id]?.name })),
    quotes: ctx.db.all('SELECT id, number, title, status, total, frequency, sent_at, approved_at, valid_until, created_at FROM quotes WHERE company_id = ? AND client_id = ? ORDER BY id DESC', cid, c.id),
    jobs: ctx.db.all(`SELECT j.id, j.title, j.status, j.start_at, j.duration_min, j.price, j.series_id, cr.name AS crew FROM jobs j LEFT JOIN crews cr ON cr.id = j.crew_id
      WHERE j.company_id = ? AND j.client_id = ? ORDER BY COALESCE(j.start_at, '9999') DESC LIMIT 60`, cid, c.id),
    invoices,
    payments: finance ? ctx.db.all('SELECT p.*, i.number FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.company_id = ? AND p.client_id = ? ORDER BY p.paid_date DESC, p.id DESC', cid, c.id) : null,
    messages: ctx.db.all(`SELECT m.*, j.name AS journey_name FROM communications m LEFT JOIN journeys j ON j.id = m.journey_id WHERE m.company_id = ? AND m.client_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 100`, cid, c.id),
    tasks: ctx.db.all('SELECT * FROM tasks WHERE company_id = ? AND client_id = ? ORDER BY status, due_date', cid, c.id).map((t) => ({ ...t, assignee: users[t.assignee_id]?.name })),
    enrollments: ctx.db.all(`SELECT e.*, j.name AS journey_name, j.category,
        (SELECT MIN(send_at) FROM scheduled_messages m WHERE m.enrollment_id = e.id AND m.status = 'pending') AS next_send_at
      FROM enrollments e JOIN journeys j ON j.id = e.journey_id WHERE e.company_id = ? AND e.client_id = ? AND e.status IN ('active','paused') ORDER BY e.id DESC`, cid, c.id),
    history: ctx.db.all('SELECT * FROM audit_log WHERE company_id = ? AND client_id = ? ORDER BY created_at DESC, id DESC LIMIT 150', cid, c.id).map((h) => ({ ...h, user: h.user_id ? users[h.user_id]?.name : 'Sistema' })),
  };
}

// Simula mensagens recebidas do cliente (resposta, reclamação, descadastro, nota da pesquisa).
function simulateInbound(ctx, clientId, { kind, channel = 'sms', text = '', rating = null }) {
  const c = one(ctx, 'clients', clientId, 'Cliente');
  v.oneOf(kind, ['reply', 'complaint', 'optout', 'rating'], 'Tipo de resposta');
  v.oneOf(channel, ['email', 'sms', 'whatsapp'], 'Canal');
  let body = String(text || '').trim();
  if (kind === 'optout') body = body || 'STOP';
  if (kind === 'rating') { rating = v.num(rating, 'Nota', { min: 1, max: 5 }); body = body || String(rating); }
  if (!body) throw bad('Escreva o texto da resposta simulada.');
  const commId = ctx.db.insert('communications', {
    company_id: C(ctx), client_id: c.id, direction: 'in', channel, to_address: null, subject: null, body,
    status: 'simulated', simulated: 1, provider: 'demo', kind: `inbound_${kind}`, created_by: ctx.user.id, created_at: now(),
  });
  audit(ctx, 'client', c.id, 'Mensagem recebida (simulação)', { client_id: c.id, details: `${channel.toUpperCase()}: ${body}` });
  if (kind === 'optout') { setChannel(ctx, c.id, channel, { optout: true, source: `cliente respondeu "${body}"` }); return { communication_id: commId }; }
  if (kind === 'complaint' || (kind === 'rating' && rating <= 3)) {
    const taskId = openComplaint(ctx, c.id, { text: kind === 'rating' ? `Nota ${rating} na pesquisa de satisfação. ${text || ''}`.trim() : body, source_key: `complaint:comm:${commId}` });
    return { communication_id: commId, task_id: taskId };
  }
  if (kind === 'rating') {
    audit(ctx, 'client', c.id, `Avaliação positiva recebida (nota ${rating})`, { client_id: c.id });
    return { communication_id: commId };
  }
  engine.emit(ctx, 'client.replied', { entity_type: 'client', entity_id: c.id, client_id: c.id, key: `reply:comm:${commId}`, payload: { text: body, channel } });
  return { communication_id: commId };
}

function openComplaint(ctx, clientId, { text, job_id = null, source_key = null }) {
  const c = one(ctx, 'clients', clientId, 'Cliente');
  const desc = v.str(text, 'Descrição da reclamação', { required: true, max: 1000 });
  const owner = ctx.db.get(`SELECT id FROM users WHERE company_id = ? AND role = 'owner' ORDER BY id`, C(ctx));
  const taskId = engine.createTask(ctx, {
    title: `Resolver reclamação de ${c.name}`, description: desc, type: 'complaint', priority: 'high', assignee_id: owner.id,
    due_date: TZ.addDays(today(ctx), 1), client_id: c.id, job_id, source_key: source_key || `complaint:${c.id}:${now()}`,
  });
  if (!taskId) return null;
  audit(ctx, 'client', c.id, 'Reclamação registrada', { client_id: c.id, details: desc });
  engine.emit(ctx, 'complaint.opened', { entity_type: 'task', entity_id: taskId, client_id: c.id, key: `complaint.opened:${taskId}` });
  setNextAction(ctx, c.id, 'Resolver reclamação antes de qualquer oferta', TZ.addDays(today(ctx), 1), owner.id);
  return taskId;
}

// ---------------- Contatos e oportunidades ----------------

function createLead(ctx, data) {
  return ctx.db.tx(() => {
    let clientId = data.client_id ? one(ctx, 'clients', data.client_id, 'Cliente').id : createClient(ctx, data);
    const client = one(ctx, 'clients', clientId);
    const ownerId = data.owner_id ? one(ctx, 'users', data.owner_id, 'Responsável').id : engine.defaultAssignee(ctx, 'assistant');
    const est = data.estimated_value ? v.cents(data.estimated_value, 'Valor estimado') : 0;
    const title = v.str(data.service_interest, 'Serviço de interesse', { max: 120 }) || 'Limpeza residencial';
    const at = now();
    const oppId = ctx.db.insert('opportunities', {
      company_id: C(ctx), client_id: clientId, title, stage: 'new', owner_id: ownerId, estimated_value: est,
      source: v.str(data.source, 'Origem', { max: 60 }) || client.source, created_at: at, updated_at: at,
    });
    audit(ctx, 'opportunity', oppId, 'Oportunidade criada', { client_id: clientId, to: 'new', details: title });
    setNextAction(ctx, clientId, 'Fazer o primeiro contato e entender a necessidade', today(ctx), ownerId, { opportunityId: oppId });
    engine.emit(ctx, 'lead.created', { entity_type: 'opportunity', entity_id: oppId, client_id: clientId });
    return { client_id: clientId, opportunity_id: oppId };
  });
}

function listOpportunities(ctx) {
  const users = usersMap(ctx);
  return ctx.db.all(`SELECT o.*, c.name AS client_name, c.phone, c.automation_paused,
      (SELECT q.id FROM quotes q WHERE q.opportunity_id = o.id ORDER BY q.id DESC LIMIT 1) AS quote_id,
      (SELECT q.number FROM quotes q WHERE q.opportunity_id = o.id ORDER BY q.id DESC LIMIT 1) AS quote_number
    FROM opportunities o JOIN clients c ON c.id = o.client_id WHERE o.company_id = ? ORDER BY o.updated_at DESC`, C(ctx))
    .map((o) => ({ ...o, owner: users[o.owner_id]?.name || null }));
}

const STAGE_LABEL = { new: 'Novo contato', contacted: 'Em atendimento', quote_sent: 'Orçamento enviado', approved: 'Aprovado', lost: 'Perdido' };

function updateOpportunity(ctx, id, data) {
  const o = one(ctx, 'opportunities', id, 'Oportunidade');
  const patch = { updated_at: now() };
  if ('title' in data) patch.title = v.str(data.title, 'Título', { required: true, max: 120 });
  if ('owner_id' in data) patch.owner_id = one(ctx, 'users', data.owner_id, 'Responsável').id;
  if ('estimated_value' in data) patch.estimated_value = v.cents(data.estimated_value, 'Valor estimado');
  if ('next_action' in data) {
    patch.next_action = v.str(data.next_action, 'Próxima ação', { max: 200 });
    patch.next_action_due = v.date(data.next_action_due, 'Prazo', { required: !!patch.next_action });
  }
  if ('stage' in data && data.stage !== o.stage) {
    const to = v.oneOf(data.stage, STAGES, 'Etapa');
    if (to === 'approved') throw bad('Para mover para "Aprovado", registre a aprovação do orçamento.');
    if (to === 'quote_sent') throw bad('Para mover para "Orçamento enviado", crie e envie um orçamento.');
    if (o.stage === 'approved') throw bad('Oportunidade aprovada não pode voltar de etapa. Crie uma nova oportunidade.');
    if (to === 'lost') {
      patch.lost_reason = v.str(data.lost_reason, 'Motivo da perda', { required: true, max: 200 });
      patch.closed_at = now(); patch.next_action = null; patch.next_action_due = null;
    } else { patch.lost_reason = null; patch.closed_at = null; }
    patch.stage = to;
  }
  ctx.db.update('opportunities', o.id, C(ctx), patch);
  if (patch.stage) {
    audit(ctx, 'opportunity', o.id, `Etapa: ${STAGE_LABEL[o.stage]} → ${STAGE_LABEL[patch.stage]}`, { from: o.stage, to: patch.stage, client_id: o.client_id, details: patch.lost_reason || null });
    if (patch.stage === 'lost') {
      engine.emit(ctx, 'opportunity.lost', { entity_type: 'opportunity', entity_id: o.id, client_id: o.client_id, key: `opportunity.lost:${o.id}:${now()}` });
      const cl = one(ctx, 'clients', o.client_id);
      if (cl.next_action) setNextAction(ctx, o.client_id, null, null, null);
    }
    if (patch.stage === 'contacted') {
      setNextAction(ctx, o.client_id, 'Montar e enviar o orçamento', patch.next_action_due || TZ.addDays(today(ctx), 1), patch.owner_id || o.owner_id, { opportunityId: o.id });
    }
  }
  if ('next_action' in data && !patch.stage) {
    setNextAction(ctx, o.client_id, patch.next_action, patch.next_action_due, patch.owner_id || o.owner_id, { opportunityId: o.id });
    audit(ctx, 'opportunity', o.id, 'Próxima ação atualizada', { client_id: o.client_id, details: patch.next_action });
  }
  return o.id;
}

// ---------------- Orçamentos ----------------

const TERMS_LABEL = (t) => {
  const due = t.due_days > 0 ? `vencimento em ${t.due_days} dia(s)` : 'vencimento na data da cobrança';
  return t.type === 'deposit'
    ? `Depósito de ${t.deposit_percent}% na aprovação e restante após a conclusão (${due})`
    : `Pagamento integral após a conclusão (${due})`;
};

function validateQuote(ctx, data) {
  const client = one(ctx, 'clients', data.client_id, 'Cliente');
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) throw bad('Adicione pelo menos um serviço ao orçamento.');
  const clean = items.map((it, i) => ({
    description: v.str(it.description, `Serviço ${i + 1}`, { required: true, max: 160 }),
    details: v.str(it.details, 'Descrição', { max: 500 }),
    quantity: v.num(it.quantity ?? 1, `Quantidade do serviço ${i + 1}`, { min: 0.25, max: 999 }),
    unit_price: v.cents(it.unit_price, `Preço do serviço ${i + 1}`),
  }));
  const total = clean.reduce((s, it) => s + Math.round(it.quantity * it.unit_price), 0);
  if (total <= 0) throw bad('O valor total do orçamento deve ser maior que zero.');
  const t = data.payment_terms || {};
  const terms = { type: v.oneOf(t.type || 'on_completion', ['on_completion', 'deposit'], 'Condição de pagamento'), due_days: v.num(t.due_days ?? 0, 'Prazo de pagamento (dias)', { min: 0, max: 60 }), deposit_percent: 0 };
  if (terms.type === 'deposit') terms.deposit_percent = v.num(t.deposit_percent, 'Percentual do depósito', { min: 1, max: 100 });
  const valid_until = v.date(data.valid_until, 'Validade');
  if (valid_until < today(ctx)) throw bad('A validade do orçamento não pode estar no passado.');
  let address_id = null;
  if (data.address_id) {
    const a = one(ctx, 'addresses', data.address_id, 'Endereço');
    if (a.client_id !== client.id) throw bad('O endereço não pertence a este cliente.');
    address_id = a.id;
  }
  return {
    client, items: clean, total, terms, valid_until, address_id,
    frequency: v.oneOf(data.frequency || 'one_time', FREQUENCIES, 'Frequência'),
    title: v.str(data.title, 'Título', { max: 120 }) || clean[0].description,
    notes: v.str(data.notes, 'Observações', { max: 2000 }),
  };
}

function saveItems(ctx, quoteId, items) {
  ctx.db.run('DELETE FROM quote_items WHERE company_id = ? AND quote_id = ?', C(ctx), quoteId);
  items.forEach((it, i) => ctx.db.insert('quote_items', { company_id: C(ctx), quote_id: quoteId, ...it, position: i }));
}

function createQuote(ctx, data) {
  return ctx.db.tx(() => {
    const q = validateQuote(ctx, data);
    let oppId = data.opportunity_id ? one(ctx, 'opportunities', data.opportunity_id, 'Oportunidade').id : null;
    if (oppId) {
      const o = one(ctx, 'opportunities', oppId);
      if (o.client_id !== q.client.id) throw bad('A oportunidade não pertence a este cliente.');
      if (o.stage === 'approved' || o.stage === 'lost') oppId = null;
    }
    if (!oppId) {
      const open = ctx.db.get(`SELECT id FROM opportunities WHERE company_id = ? AND client_id = ? AND stage IN ('new','contacted','quote_sent') ORDER BY id DESC`, C(ctx), q.client.id);
      oppId = open ? open.id : ctx.db.insert('opportunities', {
        company_id: C(ctx), client_id: q.client.id, title: q.title, stage: 'contacted', owner_id: ctx.user.id, estimated_value: q.total,
        source: q.client.source, created_at: now(), updated_at: now(),
      });
    }
    ctx.db.run('UPDATE companies SET seq_quote = seq_quote + 1 WHERE id = ?', C(ctx));
    const number = 'Q-' + ctx.db.get('SELECT seq_quote FROM companies WHERE id = ?', C(ctx)).seq_quote;
    if (!q.address_id) { const a = ctx.db.get('SELECT id FROM addresses WHERE company_id = ? AND client_id = ? ORDER BY id', C(ctx), q.client.id); q.address_id = a ? a.id : null; }
    const id = ctx.db.insert('quotes', {
      company_id: C(ctx), client_id: q.client.id, opportunity_id: oppId, address_id: q.address_id, number, status: 'draft', title: q.title,
      notes: q.notes, valid_until: q.valid_until, payment_terms: q.terms, frequency: q.frequency, total: q.total,
      created_by: ctx.user.id, created_at: now(), updated_at: now(),
    });
    saveItems(ctx, id, q.items);
    ctx.db.update('opportunities', oppId, C(ctx), { estimated_value: q.total, updated_at: now() });
    audit(ctx, 'quote', id, `Orçamento ${number} criado (rascunho)`, { to: 'draft', client_id: q.client.id, details: engine.usd(q.total) });
    return id;
  });
}

function updateQuote(ctx, id, data) {
  const existing = one(ctx, 'quotes', id, 'Orçamento');
  if (existing.status !== 'draft') throw bad('Somente orçamentos em rascunho podem ser editados. Crie um novo orçamento para alterar valores já enviados.');
  return ctx.db.tx(() => {
    const q = validateQuote(ctx, { ...data, client_id: existing.client_id });
    ctx.db.update('quotes', existing.id, C(ctx), { address_id: q.address_id || existing.address_id, title: q.title, notes: q.notes, valid_until: q.valid_until, payment_terms: q.terms, frequency: q.frequency, total: q.total, updated_at: now() });
    saveItems(ctx, existing.id, q.items);
    if (existing.opportunity_id) ctx.db.update('opportunities', existing.opportunity_id, C(ctx), { estimated_value: q.total, updated_at: now() });
    audit(ctx, 'quote', existing.id, `Orçamento ${existing.number} editado`, { client_id: existing.client_id, details: engine.usd(q.total) });
    return existing.id;
  });
}

function getQuote(ctx, id) {
  const q = one(ctx, 'quotes', id, 'Orçamento');
  const users = usersMap(ctx);
  const terms = parse(q.payment_terms, {});
  return {
    ...q, payment_terms: terms, terms_label: TERMS_LABEL(terms),
    deposit_amount: terms.type === 'deposit' ? Math.round(q.total * terms.deposit_percent / 100) : 0,
    items: ctx.db.all('SELECT * FROM quote_items WHERE company_id = ? AND quote_id = ? ORDER BY position', C(ctx), q.id),
    client: ctx.db.get('SELECT id, name, phone, email FROM clients WHERE id = ? AND company_id = ?', q.client_id, C(ctx)),
    address: q.address_id ? ctx.db.get('SELECT * FROM addresses WHERE id = ? AND company_id = ?', q.address_id, C(ctx)) : null,
    job: ctx.db.get('SELECT id, status, start_at FROM jobs WHERE company_id = ? AND quote_id = ? ORDER BY id LIMIT 1', C(ctx), q.id) || null,
    created_by_name: users[q.created_by]?.name,
    expired: q.status === 'sent' && q.valid_until < today(ctx),
    followups: ctx.db.all(`SELECT m.id, m.step_index, m.channel, m.send_at, m.status, m.status_reason, m.hold_reason, e.status AS enrollment_status FROM scheduled_messages m JOIN enrollments e ON e.id = m.enrollment_id
      JOIN journeys j ON j.id = e.journey_id WHERE m.company_id = ? AND e.entity_type = 'quote' AND e.entity_id = ? AND j.key = 'quote_followup' ORDER BY m.step_index`, C(ctx), q.id),
    history: ctx.db.all(`SELECT * FROM audit_log WHERE company_id = ? AND entity_type = 'quote' AND entity_id = ? ORDER BY id DESC`, C(ctx), q.id).map((h) => ({ ...h, user: h.user_id ? users[h.user_id]?.name : 'Sistema' })),
  };
}

function listQuotes(ctx, { status } = {}) {
  return ctx.db.all(`SELECT q.id, q.number, q.title, q.status, q.total, q.sent_at, q.valid_until, q.created_at, q.client_id, c.name AS client_name
    FROM quotes q JOIN clients c ON c.id = q.client_id WHERE q.company_id = ? AND (? IS NULL OR q.status = ?) ORDER BY q.id DESC`, C(ctx), status || null, status || null);
}

function sendQuote(ctx, id, { channel = null } = {}) {
  return ctx.db.tx(() => {
    const q = one(ctx, 'quotes', id, 'Orçamento');
    if (!['draft', 'sent'].includes(q.status)) throw bad('Este orçamento já foi respondido e não pode ser reenviado.');
    if (q.valid_until < today(ctx)) throw bad('A validade do orçamento expirou. Edite a validade antes de enviar.');
    const client = one(ctx, 'clients', q.client_id);
    const ch = channel || (client.email && engine.consent(client, 'email').ok ? 'email' : 'sms');
    const cs = engine.consent(client, ch);
    if (!cs.ok) throw bad(`Não é possível enviar: ${cs.reason}.`);
    const to = ch === 'email' ? client.email : client.phone;
    if (!to) throw bad(`Cliente sem ${ch === 'email' ? 'e-mail' : 'telefone'} cadastrado.`);
    const publicToken = q.public_token || token(18);
    const first = q.status === 'draft';
    ctx.db.update('quotes', q.id, C(ctx), { status: 'sent', public_token: publicToken, sent_at: first ? now() : q.sent_at, updated_at: now() });
    const fresh = one(ctx, 'quotes', q.id);
    const cctx = engine.loadContext(ctx, 'quote', q.id, client.id);
    cctx.quote = fresh;
    const body = engine.render('Hi {{cliente_primeiro_nome}}, here is your quote {{orcamento_numero}} from {{empresa}} for {{orcamento_valor}}. Review and approve it online: {{link_orcamento}}', cctx);
    ctx.db.insert('communications', {
      company_id: C(ctx), client_id: client.id, direction: 'out', channel: ch, to_address: to, subject: `Your quote ${q.number} from ${ctx.company.name}`,
      body, status: 'simulated', simulated: 1, provider: 'demo', kind: 'quote', related_type: 'quote', related_id: q.id, created_by: ctx.user.id, created_at: now(),
    });
    audit(ctx, 'quote', q.id, first ? `Orçamento ${q.number} enviado (simulação)` : `Orçamento ${q.number} reenviado (simulação)`, { from: q.status, to: 'sent', client_id: client.id, details: `${ch.toUpperCase()} para ${to}` });
    if (first) {
      const o = q.opportunity_id ? one(ctx, 'opportunities', q.opportunity_id) : null;
      if (o && o.stage !== 'quote_sent') {
        ctx.db.update('opportunities', o.id, C(ctx), { stage: 'quote_sent', updated_at: now() });
        audit(ctx, 'opportunity', o.id, `Etapa: ${STAGE_LABEL[o.stage]} → ${STAGE_LABEL.quote_sent}`, { from: o.stage, to: 'quote_sent', client_id: client.id });
      }
      setNextAction(ctx, client.id, `Acompanhar resposta do orçamento ${q.number}`, TZ.addDays(today(ctx), 2), o ? o.owner_id : ctx.user.id, { opportunityId: o?.id });
      engine.emit(ctx, 'quote.sent', { entity_type: 'quote', entity_id: q.id, client_id: client.id });
    }
    return { public_token: publicToken, channel: ch };
  });
}

const DEFAULT_CHECKLIST = (title) => {
  const base = ['Cozinha: bancadas, pia, fogão e eletrodomésticos (externo)', 'Banheiros: vaso, box, pia e espelhos', 'Tirar pó de superfícies e móveis', 'Aspirar e passar pano em todos os pisos', 'Esvaziar lixeiras e trocar sacos'];
  const t = norm(title);
  if (t.includes('deep')) base.push('Rodapés, batentes e interruptores', 'Interior do micro-ondas');
  if (t.includes('move')) base.push('Interior de armários e gavetas', 'Interior da geladeira e do forno');
  base.push('Fotos do resultado final');
  return base.map((text) => ({ text, done: false }));
};

// Aprovação: encerra follow-ups, cria serviço pendente de agendamento e, se combinado, a cobrança de depósito.
function approveQuote(ctx, id, { via = 'staff' } = {}) {
  return ctx.db.tx(() => {
    const q = one(ctx, 'quotes', id, 'Orçamento');
    if (q.status === 'approved') {
      const job = ctx.db.get('SELECT id FROM jobs WHERE company_id = ? AND quote_id = ? ORDER BY id', C(ctx), q.id);
      return { job_id: job?.id, already: true };
    }
    if (q.status !== 'sent' && !(q.status === 'draft' && via === 'staff')) throw bad('Somente orçamentos enviados podem ser aprovados.');
    if (q.valid_until < today(ctx)) throw bad('Orçamento vencido. Atualize a validade e reenvie antes de aprovar.');
    const fin = require('./svc-fin');
    ctx.db.update('quotes', q.id, C(ctx), { status: 'approved', approved_at: now(), approved_via: via, updated_at: now() });
    audit(ctx, 'quote', q.id, `Orçamento ${q.number} aprovado ${via === 'client' ? 'pelo cliente no link (simulação)' : 'pela equipe'}`, { from: q.status, to: 'approved', client_id: q.client_id });
    if (q.opportunity_id) {
      const o = one(ctx, 'opportunities', q.opportunity_id);
      ctx.db.update('opportunities', o.id, C(ctx), { stage: 'approved', estimated_value: q.total, closed_at: now(), next_action: null, next_action_due: null, updated_at: now() });
      audit(ctx, 'opportunity', o.id, `Etapa: ${STAGE_LABEL[o.stage]} → ${STAGE_LABEL.approved}`, { from: o.stage, to: 'approved', client_id: q.client_id });
    }
    engine.emit(ctx, 'quote.approved', { entity_type: 'quote', entity_id: q.id, client_id: q.client_id });
    const at = now();
    const jobId = ctx.db.insert('jobs', {
      company_id: C(ctx), client_id: q.client_id, address_id: q.address_id, quote_id: q.id, opportunity_id: q.opportunity_id,
      title: q.title, status: 'pending_schedule', requested_frequency: q.frequency, duration_min: 180, price: q.total,
      instructions: q.notes, checklist: DEFAULT_CHECKLIST(q.title), created_by: ctx.user ? ctx.user.id : null, created_at: at, updated_at: at,
    });
    audit(ctx, 'job', jobId, 'Serviço criado a partir do orçamento (pendente de agendamento)', { to: 'pending_schedule', client_id: q.client_id, details: q.number });
    const terms = parse(q.payment_terms, {});
    let depositId = null;
    if (terms.type === 'deposit' && terms.deposit_percent > 0) {
      depositId = fin.issueInvoice(ctx, {
        client_id: q.client_id, job_id: jobId, quote_id: q.id, kind: 'deposit', amount: Math.round(q.total * terms.deposit_percent / 100),
        due_date: today(ctx), description: `Depósito de ${terms.deposit_percent}% - orçamento ${q.number}`, source_key: `quote:${q.id}:deposit`,
      }).id;
    }
    const opp = q.opportunity_id ? one(ctx, 'opportunities', q.opportunity_id) : null;
    const assignee = (opp && opp.owner_id) || engine.defaultAssignee(ctx, 'assistant');
    engine.createTask(ctx, {
      title: `Agendar serviço: ${one(ctx, 'clients', q.client_id).name}`, type: 'scheduling', assignee_id: assignee, due_date: today(ctx),
      client_id: q.client_id, job_id: jobId, quote_id: q.id, description: 'Confirmar data e horário com o cliente antes de agendar. O sistema não escolhe datas automaticamente.',
      source_key: `schedule:job:${jobId}`,
    });
    setNextAction(ctx, q.client_id, 'Confirmar data com o cliente e agendar o serviço', today(ctx), assignee);
    return { job_id: jobId, deposit_invoice_id: depositId };
  });
}

function declineQuote(ctx, id, { reason, via = 'staff' }) {
  return ctx.db.tx(() => {
    const q = one(ctx, 'quotes', id, 'Orçamento');
    if (q.status !== 'sent') throw bad('Somente orçamentos enviados podem ser marcados como recusados.');
    const r = v.str(reason, 'Motivo', { required: via === 'staff', max: 200 }) || 'Recusado pelo cliente no link';
    ctx.db.update('quotes', q.id, C(ctx), { status: 'declined', declined_at: now(), decline_reason: r, updated_at: now() });
    audit(ctx, 'quote', q.id, `Orçamento ${q.number} recusado`, { from: 'sent', to: 'declined', client_id: q.client_id, details: r });
    engine.emit(ctx, 'quote.declined', { entity_type: 'quote', entity_id: q.id, client_id: q.client_id });
    if (q.opportunity_id) updateOpportunity(ctx, q.opportunity_id, { stage: 'lost', lost_reason: `Orçamento recusado: ${r}` });
    return q.id;
  });
}

// ---------------- Tarefas ----------------

function listTasks(ctx, { status = 'open', assignee_id = null } = {}) {
  const users = usersMap(ctx);
  const st = status === 'open' ? ['open', 'in_progress'] : status === 'done' ? ['done', 'canceled'] : ['open', 'in_progress', 'done', 'canceled'];
  const onlyMine = ctx.user.role === 'field';
  return ctx.db.all(`SELECT t.*, c.name AS client_name, j.title AS job_title FROM tasks t LEFT JOIN clients c ON c.id = t.client_id LEFT JOIN jobs j ON j.id = t.job_id
    WHERE t.company_id = ? AND t.status IN (${st.map(() => '?').join(',')}) AND (? IS NULL OR t.assignee_id = ?)
    ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.due_date, t.id`,
  C(ctx), ...st, onlyMine ? ctx.user.id : (assignee_id || null), onlyMine ? ctx.user.id : (assignee_id || null))
    .map((t) => ({ ...t, assignee: users[t.assignee_id]?.name, overdue: ['open', 'in_progress'].includes(t.status) && t.due_date < today(ctx) }));
}

function createTask(ctx, data) {
  const title = v.str(data.title, 'Título', { required: true, max: 160 });
  const assignee = one(ctx, 'users', data.assignee_id, 'Responsável');
  const due = v.date(data.due_date, 'Prazo');
  const client_id = data.client_id ? one(ctx, 'clients', data.client_id, 'Cliente').id : null;
  const job_id = data.job_id ? one(ctx, 'jobs', data.job_id, 'Serviço').id : null;
  const type = v.oneOf(data.type || 'general', ['general', 'followup', 'complaint'], 'Tipo');
  if (type === 'complaint') {
    if (!client_id) throw bad('Reclamações precisam estar ligadas a um cliente.');
    return openComplaint(ctx, client_id, { text: data.description || title, job_id });
  }
  const id = engine.createTask(ctx, {
    title, description: v.str(data.description, 'Descrição', { max: 1000 }), type, priority: v.oneOf(data.priority || 'normal', ['low', 'normal', 'high'], 'Prioridade'),
    assignee_id: assignee.id, due_date: due, client_id, job_id, source_key: `manual:${now()}:${Math.random()}`,
  });
  audit(ctx, 'task', id, 'Tarefa criada', { to: 'open', client_id, details: `${title} → ${assignee.name}` });
  return id;
}

function updateTask(ctx, id, data) {
  const t = one(ctx, 'tasks', id, 'Tarefa');
  if (ctx.user.role === 'field' && t.assignee_id !== ctx.user.id) throw new HttpError(403, 'Você só pode alterar tarefas atribuídas a você.');
  const patch = {};
  if ('status' in data) {
    patch.status = v.oneOf(data.status, ['open', 'in_progress', 'done', 'canceled'], 'Status');
    if (['done', 'canceled'].includes(patch.status)) { patch.completed_at = now(); patch.completed_by = ctx.user.id; } else { patch.completed_at = null; patch.completed_by = null; }
  }
  if (ctx.user.role !== 'field') {
    if ('assignee_id' in data) patch.assignee_id = one(ctx, 'users', data.assignee_id, 'Responsável').id;
    if ('due_date' in data) patch.due_date = v.date(data.due_date, 'Prazo');
    if ('title' in data) patch.title = v.str(data.title, 'Título', { required: true, max: 160 });
  }
  ctx.db.update('tasks', t.id, C(ctx), patch);
  const SL = { open: 'Aberta', in_progress: 'Em andamento', done: 'Concluída', canceled: 'Cancelada' };
  if (patch.status && patch.status !== t.status) audit(ctx, 'task', t.id, `Tarefa "${t.title}": ${SL[t.status]} → ${SL[patch.status]}`, { from: t.status, to: patch.status, client_id: t.client_id });
  if (patch.assignee_id && patch.assignee_id !== t.assignee_id) audit(ctx, 'task', t.id, `Tarefa "${t.title}" reatribuída`, { client_id: t.client_id });
  if (t.type === 'complaint' && patch.status === 'done' && t.status !== 'done') {
    engine.emit(ctx, 'complaint.resolved', { entity_type: 'task', entity_id: t.id, client_id: t.client_id, key: `complaint.resolved:${t.id}:${now()}` });
    if (!engine.hasOpenComplaint(ctx, t.client_id)) setNextAction(ctx, t.client_id, 'Confirmar com o cliente que a reclamação foi resolvida', TZ.addDays(today(ctx), 2), t.assignee_id);
  }
  return t.id;
}

module.exports = {
  SOURCES, STAGE_LABEL, TERMS_LABEL, usersMap, setNextAction, findDuplicates, listClients, createClient, addAddress, updateClient,
  setChannel, takeover, getClient, simulateInbound, openComplaint, createLead, listOpportunities, updateOpportunity,
  createQuote, updateQuote, getQuote, listQuotes, sendQuote, approveQuote, declineQuote, listTasks, createTask, updateTask, DEFAULT_CHECKLIST,
};
