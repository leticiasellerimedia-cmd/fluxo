// Cobranças, pagamentos, receitas, despesas, resultado por serviço e visão do dia.
const { HttpError, bad, clock, today, parse, v, audit, one, TZ } = require('./util');
const engine = require('./engine');
const crm = require('./svc-crm');
const integrations = require('./integrations');

const C = (ctx) => ctx.company.id;
const now = () => clock.iso();
const METHODS = { cash: 'Dinheiro', check: 'Cheque', zelle: 'Zelle', venmo: 'Venmo', card_manual: 'Cartão (maquininha externa)', ach: 'Transferência (ACH)', other: 'Outro' };
const EXPENSE_CATEGORIES = ['Produtos de limpeza', 'Mão de obra terceirizada', 'Combustível e deslocamento', 'Equipamentos', 'Marketing', 'Seguro', 'Software', 'Outros'];

// Emite cobrança de forma idempotente: a mesma origem (source_key) nunca gera duas cobranças.
function issueInvoice(ctx, { client_id, job_id = null, quote_id = null, kind, amount, due_date, description, source_key = null }) {
  if (source_key) {
    const ex = ctx.db.get('SELECT * FROM invoices WHERE company_id = ? AND source_key = ?', C(ctx), source_key);
    if (ex) return { id: ex.id, duplicate: true };
  }
  ctx.db.run('UPDATE companies SET seq_invoice = seq_invoice + 1 WHERE id = ?', C(ctx));
  const number = 'INV-' + ctx.db.get('SELECT seq_invoice FROM companies WHERE id = ?', C(ctx)).seq_invoice;
  const id = ctx.db.insert('invoices', {
    company_id: C(ctx), client_id, job_id, quote_id, number, kind, description, amount, due_date, status: 'open', source_key,
    issued_at: now(), issued_date: today(ctx), created_by: ctx.user ? ctx.user.id : null,
  });
  const kindLabel = { deposit: 'Cobrança de depósito', final: 'Cobrança', standalone: 'Cobrança avulsa' }[kind];
  audit(ctx, 'invoice', id, `${kindLabel} ${number} emitida (${engine.usd(amount)})`, { to: 'open', client_id, details: `Vencimento ${engine.usDate(due_date)}` });
  if (job_id) audit(ctx, 'job', job_id, `${kindLabel} ${number} emitida`, { details: engine.usd(amount) });
  engine.emit(ctx, 'invoice.issued', { entity_type: 'invoice', entity_id: id, client_id });
  return { id, duplicate: false };
}

// Gera a cobrança final conforme as condições do orçamento (descontando depósito já cobrado).
function invoiceJob(ctx, jobId) {
  return ctx.db.tx(() => {
    const job = one(ctx, 'jobs', jobId, 'Serviço');
    if (job.status !== 'completed') throw bad('Conclua o serviço antes de gerar a cobrança final.');
    const existing = ctx.db.get(`SELECT id, number FROM invoices WHERE company_id = ? AND job_id = ? AND kind = 'final' AND status <> 'void'`, C(ctx), job.id);
    if (existing) return { id: existing.id, duplicate: true, message: `A cobrança ${existing.number} já existe para este serviço.` };
    const quote = job.quote_id ? one(ctx, 'quotes', job.quote_id) : null;
    const terms = quote ? parse(quote.payment_terms, {}) : { type: 'on_completion', due_days: 0 };
    const deposits = ctx.db.get(`SELECT COALESCE(SUM(amount),0) AS s FROM invoices WHERE company_id = ? AND job_id = ? AND kind = 'deposit' AND status <> 'void'`, C(ctx), job.id).s;
    const amount = job.price - deposits;
    if (amount <= 0) throw bad('Não há saldo a cobrar: o depósito já cobre o valor contratado.');
    const tz = ctx.company.timezone;
    const serviceDate = engine.usDate(TZ.localDate(job.start_at, tz));
    const voidedBefore = ctx.db.get(`SELECT COUNT(*) AS n FROM invoices WHERE company_id = ? AND job_id = ? AND kind = 'final' AND status = 'void'`, C(ctx), job.id).n;
    const res = issueInvoice(ctx, {
      client_id: job.client_id, job_id: job.id, quote_id: job.quote_id, kind: 'final', amount,
      due_date: TZ.addDays(today(ctx), terms.due_days || 0),
      description: `${job.title} - ${serviceDate}${deposits ? ` (descontado depósito de ${engine.usd(deposits)})` : ''}`,
      source_key: `job:${job.id}:final${voidedBefore ? `:r${voidedBefore}` : ''}`,
    });
    const inv = one(ctx, 'invoices', res.id);
    const ownerId = ctx.db.get(`SELECT id FROM users WHERE company_id = ? AND role = 'owner' ORDER BY id`, C(ctx)).id;
    crm.setNextAction(ctx, job.client_id, `Acompanhar o pagamento da cobrança ${inv.number}`, inv.due_date, ownerId);
    return { id: res.id, duplicate: res.duplicate };
  });
}

function createInvoice(ctx, data) {
  const client = one(ctx, 'clients', data.client_id, 'Cliente');
  return issueInvoice(ctx, {
    client_id: client.id, kind: 'standalone', amount: v.cents(data.amount, 'Valor', { min: 1 }),
    due_date: v.date(data.due_date, 'Vencimento'), description: v.str(data.description, 'Descrição', { required: true, max: 200 }),
    source_key: `manual:${client.id}:${now()}`,
  });
}

function invoiceStatus(inv, todayStr, balance) {
  if (inv.status === 'void') return 'void';
  if (balance <= 0) return 'paid';
  if (inv.due_date < todayStr) return 'overdue';
  return inv.status;
}

function listInvoices(ctx, { status = null, client_id = null } = {}) {
  const t = today(ctx);
  return ctx.db.all(`SELECT i.*, c.name AS client_name, (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.invoice_id = i.id) AS paid
    FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.company_id = ? AND (? IS NULL OR i.client_id = ?) ORDER BY i.issued_at DESC, i.id DESC`, C(ctx), client_id, client_id)
    .map((i) => { const balance = i.status === 'void' ? 0 : i.amount - i.paid; return { ...i, balance, display_status: invoiceStatus(i, t, balance), days_overdue: i.status !== 'void' && balance > 0 && i.due_date < t ? TZ.diffDays(i.due_date, t) : 0 }; })
    .filter((i) => !status || i.display_status === status || (status === 'unpaid' && ['open', 'partial', 'overdue'].includes(i.display_status)));
}

function getInvoice(ctx, id) {
  const i = one(ctx, 'invoices', id, 'Cobrança');
  const payments = ctx.db.all('SELECT * FROM payments WHERE company_id = ? AND invoice_id = ? ORDER BY paid_date, id', C(ctx), i.id);
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  const balance = i.status === 'void' ? 0 : i.amount - paid;
  return {
    ...i, payments, paid, balance, display_status: invoiceStatus(i, today(ctx), balance), payment_link: integrations.createPaymentLink(i),
    client: ctx.db.get('SELECT id, name, email, phone FROM clients WHERE id = ? AND company_id = ?', i.client_id, C(ctx)),
    reminders: ctx.db.all(`SELECT m.id, m.step_index, m.channel, m.send_at, m.status, m.status_reason FROM scheduled_messages m JOIN enrollments e ON e.id = m.enrollment_id
      WHERE m.company_id = ? AND e.entity_type = 'invoice' AND e.entity_id = ? ORDER BY m.step_index`, C(ctx), i.id),
  };
}

function recordPayment(ctx, invoiceId, data) {
  return ctx.db.tx(() => {
    const i = one(ctx, 'invoices', invoiceId, 'Cobrança');
    if (i.status === 'void') throw bad('Cobrança anulada não recebe pagamentos.');
    if (i.status === 'paid') throw bad('Esta cobrança já está paga integralmente.');
    const balance = engine.balanceOf(ctx, i);
    const amount = v.cents(data.amount, 'Valor do pagamento', { min: 1 });
    if (amount > balance) throw bad(`O valor informado (${engine.usd(amount)}) é maior que o saldo em aberto (${engine.usd(balance)}).`);
    const method = v.oneOf(data.method || 'other', Object.keys(METHODS), 'Forma de pagamento');
    const paid_date = v.date(data.paid_date || today(ctx), 'Data do pagamento');
    if (paid_date > today(ctx)) throw bad('A data do pagamento não pode estar no futuro.');
    const pid = ctx.db.insert('payments', { company_id: C(ctx), invoice_id: i.id, client_id: i.client_id, amount, method, paid_date, note: v.str(data.note, 'Observação', { max: 200 }), provider: 'manual', created_by: ctx.user.id, created_at: now() });
    const newBalance = balance - amount;
    const status = newBalance <= 0 ? 'paid' : 'partial';
    ctx.db.update('invoices', i.id, C(ctx), { status, paid_at: status === 'paid' ? now() : null });
    audit(ctx, 'invoice', i.id, `Pagamento registrado em ${i.number}: ${engine.usd(amount)} (${METHODS[method]})`, { from: i.status, to: status, client_id: i.client_id, details: status === 'paid' ? 'Quitada' : `Saldo restante ${engine.usd(newBalance)}` });
    if (i.job_id) audit(ctx, 'job', i.job_id, `Pagamento de ${engine.usd(amount)} registrado (${i.number})`, {});
    engine.emit(ctx, 'payment.recorded', { entity_type: 'payment', entity_id: pid, client_id: i.client_id, key: `payment:${pid}` });
    if (status === 'paid') {
      engine.emit(ctx, 'invoice.paid', { entity_type: 'invoice', entity_id: i.id, client_id: i.client_id });
      postServiceNextAction(ctx, i);
    }
    return { payment_id: pid, status, balance: newBalance };
  });
}

// Depois do pagamento, a próxima ação passa a ser relacionamento e recontratação.
function postServiceNextAction(ctx, invoice) {
  const openInv = listInvoices(ctx, { client_id: invoice.client_id, status: 'unpaid' });
  const owner = ctx.db.get(`SELECT id FROM users WHERE company_id = ? AND role = 'owner' ORDER BY id`, C(ctx)).id;
  if (openInv.length) { crm.setNextAction(ctx, invoice.client_id, `Acompanhar o pagamento da cobrança ${openInv[0].number}`, openInv[0].due_date, owner); return; }
  // Depósito pago antes da execução: a próxima ação continua sendo o agendamento/execução.
  const job = invoice.job_id ? ctx.db.get('SELECT status FROM jobs WHERE id = ? AND company_id = ?', invoice.job_id, C(ctx)) : null;
  if (job && job.status !== 'completed') return;
  if (engine.hasOpenComplaint(ctx, invoice.client_id)) return;
  const next = ctx.db.get(`SELECT start_at FROM jobs WHERE company_id = ? AND client_id = ? AND status = 'scheduled' AND start_at > ? ORDER BY start_at`, C(ctx), invoice.client_id, now());
  const assistant = engine.defaultAssignee(ctx, 'assistant');
  if (next) {
    const d = TZ.localDate(next.start_at, ctx.company.timezone);
    crm.setNextAction(ctx, invoice.client_id, `Pós-serviço: conferir a satisfação e preparar a próxima visita (${engine.usDate(d)})`, d, assistant);
  } else {
    crm.setNextAction(ctx, invoice.client_id, 'Pós-serviço: oferecer a próxima limpeza ou um plano recorrente', TZ.addDays(today(ctx), 14), assistant);
  }
}

function voidInvoice(ctx, id, { reason }) {
  return ctx.db.tx(() => {
    const i = one(ctx, 'invoices', id, 'Cobrança');
    if (i.status === 'void') return { already: true };
    const paid = i.amount - engine.balanceOf(ctx, i);
    if (paid > 0) throw bad('Cobrança com pagamento registrado não pode ser anulada.');
    const r = v.str(reason, 'Motivo', { required: true, max: 200 });
    ctx.db.update('invoices', i.id, C(ctx), { status: 'void', voided_at: now() });
    audit(ctx, 'invoice', i.id, `Cobrança ${i.number} anulada`, { from: i.status, to: 'void', client_id: i.client_id, details: r });
    engine.emit(ctx, 'invoice.voided', { entity_type: 'invoice', entity_id: i.id, client_id: i.client_id });
    return { ok: true };
  });
}

function createExpense(ctx, data, { fromJob = false } = {}) {
  const amount = v.cents(data.amount, 'Valor', { min: 1 });
  const description = v.str(data.description, 'Descrição', { required: true, max: 200 });
  const category = v.oneOf(data.category || 'Outros', EXPENSE_CATEGORIES, 'Categoria');
  const date = v.date(data.date || today(ctx), 'Data');
  const job_id = data.job_id ? one(ctx, 'jobs', data.job_id, 'Serviço').id : null;
  const id = ctx.db.insert('expenses', { company_id: C(ctx), job_id, category, description, amount, date, created_by: ctx.user.id, created_at: now() });
  if (!fromJob) audit(ctx, 'expense', id, `Despesa registrada: ${description} (${engine.usd(amount)})`, {});
  return id;
}

function createIncome(ctx, data) {
  const amount = v.cents(data.amount, 'Valor', { min: 1 });
  const description = v.str(data.description, 'Descrição', { required: true, max: 200 });
  const client_id = data.client_id ? one(ctx, 'clients', data.client_id, 'Cliente').id : null;
  const date = v.date(data.date || today(ctx), 'Data');
  if (date > today(ctx)) throw bad('A data da receita não pode estar no futuro.');
  const id = ctx.db.insert('incomes', { company_id: C(ctx), client_id, description, amount, date, method: data.method || null, created_by: ctx.user.id, created_at: now() });
  audit(ctx, 'income', id, `Receita manual registrada: ${description} (${engine.usd(amount)})`, { client_id });
  return id;
}

function monthRange(ctx, month) {
  const m = /^\d{4}-\d{2}$/.test(month || '') ? month : today(ctx).slice(0, 7);
  const first = m + '-01';
  const next = TZ.addMonthsClamped(first, 1, 1);
  return { month: m, first, next, utc: [TZ.toUtc(first, '00:00', ctx.company.timezone), TZ.toUtc(next, '00:00', ctx.company.timezone)] };
}

function financeSummary(ctx, { month } = {}) {
  const ops = require('./svc-ops');
  const r = monthRange(ctx, month);
  const cid = C(ctx);
  const t = today(ctx);
  const jobsInMonth = ctx.db.all(`SELECT j.id, j.title, j.status, j.start_at, j.price, j.costs_complete, j.client_id, c.name AS client_name FROM jobs j JOIN clients c ON c.id = j.client_id
    WHERE j.company_id = ? AND j.status IN ('scheduled','in_progress','completed') AND j.start_at >= ? AND j.start_at < ? ORDER BY j.start_at`, cid, ...r.utc);
  const pendingSchedule = ctx.db.all(`SELECT j.id, j.title, j.price, c.name AS client_name FROM jobs j JOIN clients c ON c.id = j.client_id WHERE j.company_id = ? AND j.status = 'pending_schedule'`, cid);
  const invoicesMonth = ctx.db.all(`SELECT i.*, c.name AS client_name FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.company_id = ? AND i.status <> 'void' AND i.issued_date >= ? AND i.issued_date < ? ORDER BY i.issued_date`, cid, r.first, r.next);
  const payments = ctx.db.all(`SELECT p.*, i.number, c.name AS client_name FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN clients c ON c.id = p.client_id WHERE p.company_id = ? AND p.paid_date >= ? AND p.paid_date < ? ORDER BY p.paid_date`, cid, r.first, r.next);
  const incomes = ctx.db.all(`SELECT n.*, c.name AS client_name FROM incomes n LEFT JOIN clients c ON c.id = n.client_id WHERE n.company_id = ? AND n.date >= ? AND n.date < ? ORDER BY n.date`, cid, r.first, r.next);
  const expenses = ctx.db.all(`SELECT e.*, j.title AS job_title FROM expenses e LEFT JOIN jobs j ON j.id = e.job_id WHERE e.company_id = ? AND e.date >= ? AND e.date < ? ORDER BY e.date`, cid, r.first, r.next);
  const unpaid = listInvoices(ctx, { status: 'unpaid' });
  const receivable = unpaid.filter((i) => i.display_status !== 'overdue');
  const overdue = unpaid.filter((i) => i.display_status === 'overdue');
  const toBill = ctx.db.all(`SELECT j.id, j.title, j.start_at, j.price, c.name AS client_name,
      (SELECT COALESCE(SUM(amount),0) FROM invoices d WHERE d.job_id = j.id AND d.kind = 'deposit' AND d.status <> 'void') AS deposits
    FROM jobs j JOIN clients c ON c.id = j.client_id WHERE j.company_id = ? AND j.status = 'completed'
      AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.job_id = j.id AND i.kind = 'final' AND i.status <> 'void')`, cid)
    .map((j) => ({ ...j, to_bill: j.price - j.deposits })).filter((j) => j.to_bill > 0);
  const completed = ctx.db.all(`SELECT j.*, c.name AS client_name FROM jobs j JOIN clients c ON c.id = j.client_id WHERE j.company_id = ? AND j.status = 'completed' AND j.start_at >= ? AND j.start_at < ? ORDER BY j.start_at DESC`, cid, ...r.utc);
  const perJob = completed.map((j) => {
    const costs = ops.jobCosts(ctx, j.id);
    const res = ops.directResult(ctx, j, costs);
    return { id: j.id, title: j.title, client_name: j.client_name, start_at: j.start_at, revenue: j.price, labor: costs.labor, other: costs.other, costs: costs.total, result: res.result, complete: res.complete, gaps: res.gaps, hours: costs.hours };
  });
  const sum = (arr, k) => arr.reduce((s, x) => s + (x[k] || 0), 0);
  const laborMonth = ctx.db.get(`SELECT COALESCE(SUM(t.cost),0) AS s FROM time_entries t JOIN jobs j ON j.id = t.job_id WHERE t.company_id = ? AND j.start_at >= ? AND j.start_at < ?`, cid, ...r.utc).s;
  const completeJobs = perJob.filter((j) => j.complete);
  return {
    month: r.month, today: t,
    contracted: { total: sum(jobsInMonth, 'price'), items: jobsInMonth, pending_schedule_total: sum(pendingSchedule, 'price'), pending_schedule: pendingSchedule },
    billed: { total: sum(invoicesMonth, 'amount'), items: invoicesMonth },
    received: { total: sum(payments, 'amount') + sum(incomes, 'amount'), payments_total: sum(payments, 'amount'), incomes_total: sum(incomes, 'amount'), payments, incomes },
    receivable: { total: sum(receivable, 'balance'), items: receivable },
    overdue: { total: sum(overdue, 'balance'), items: overdue },
    to_bill: { total: sum(toBill, 'to_bill'), items: toBill },
    expenses: { total: sum(expenses, 'amount'), direct: sum(expenses.filter((e) => e.job_id), 'amount'), general: sum(expenses.filter((e) => !e.job_id), 'amount'), items: expenses, labor_registered: laborMonth },
    jobs: perJob,
    direct_result: {
      complete_count: completeJobs.length, incomplete_count: perJob.length - completeJobs.length,
      complete_revenue: sum(completeJobs, 'revenue'), complete_result: sum(completeJobs, 'result'),
    },
    data_gaps: [
      ...perJob.filter((j) => !j.complete).map((j) => ({ type: 'job_costs', job_id: j.id, text: `${j.client_name} - ${j.title}: ${j.gaps.join('; ')}` })),
      ...ctx.db.all(`SELECT id, name FROM users WHERE company_id = ? AND role = 'field' AND hourly_cost = 0 AND active = 1`, cid).map((u) => ({ type: 'hourly_cost', user_id: u.id, text: `${u.name}: custo/hora não configurado` })),
    ],
    methods: METHODS, expense_categories: EXPENSE_CATEGORIES,
  };
}

// ---------------- Visão do dia ----------------
function todayView(ctx) {
  const ops = require('./svc-ops');
  const tz = ctx.company.timezone; const t = today(ctx); const cid = C(ctx);
  const [s, e] = TZ.dayRange(t, tz);
  const field = ctx.user.role === 'field';
  const users = crm.usersMap(ctx);
  const jobsToday = ops.listJobs(ctx, { from: s, to: e }).filter((j) => j.status !== 'canceled');
  const out = { today: t, jobs_today: jobsToday };
  out.tasks = crm.listTasks(ctx, { status: 'open' });
  if (field) return out;
  if (ctx.perms.sales || ctx.perms.clients) {
    out.quotes_awaiting = ctx.db.all(`SELECT q.id, q.number, q.title, q.total, q.sent_at, q.valid_until, q.client_id, c.name AS client_name FROM quotes q JOIN clients c ON c.id = q.client_id
      WHERE q.company_id = ? AND q.status = 'sent' ORDER BY q.sent_at`, cid).map((q) => ({ ...q, days_waiting: TZ.diffDays(TZ.localDate(q.sent_at, tz), t), expired: q.valid_until < t }));
    const fu = ctx.db.all(`SELECT id AS client_id, name AS client_name, next_action, next_action_due, next_action_owner_id FROM clients WHERE company_id = ? AND next_action IS NOT NULL AND next_action_due IS NOT NULL AND next_action_due <= ? ORDER BY next_action_due`, cid, t)
      .map((c) => ({ ...c, owner: users[c.next_action_owner_id]?.name, overdue: c.next_action_due < t, days_late: TZ.diffDays(c.next_action_due, t) }));
    out.followups = { due_today: fu.filter((x) => !x.overdue), overdue: fu.filter((x) => x.overdue) };
    out.needs_human = ctx.db.all(`SELECT DISTINCT c.id AS client_id, c.name AS client_name, e.pause_reason FROM enrollments e JOIN clients c ON c.id = e.client_id WHERE e.company_id = ? AND e.status = 'paused' AND e.pause_reason IN ('client_replied','complaint')`, cid);
  }
  if (ctx.perms.schedule) {
    out.pending_schedule = ctx.db.all(`SELECT j.id, j.title, j.price, j.created_at, j.requested_frequency, c.name AS client_name, j.client_id FROM jobs j JOIN clients c ON c.id = j.client_id WHERE j.company_id = ? AND j.status = 'pending_schedule' ORDER BY j.created_at`, cid)
      .map((j) => (ctx.perms.finance ? j : { ...j, price: undefined }));
  }
  if (ctx.perms.finance) {
    const fin = financeSummary(ctx, {});
    out.overdue_invoices = fin.overdue.items;
    out.money = { received_month: fin.received.total, received_payments: fin.received.payments_total, received_incomes: fin.received.incomes_total, receivable: fin.receivable.total, overdue: fin.overdue.total, to_bill: fin.to_bill.total, month: fin.month };
    out.to_bill = fin.to_bill.items;
    out.received_items = fin.received.payments;
    out.receivable_items = fin.receivable.items;
  }
  return out;
}

module.exports = { METHODS, EXPENSE_CATEGORIES, issueInvoice, invoiceJob, createInvoice, listInvoices, getInvoice, recordPayment, voidInvoice, createExpense, createIncome, financeSummary, todayView };
