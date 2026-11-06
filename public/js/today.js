// Visão do dia: "O que precisa da minha atenção hoje?"
/* global S, ACT, html, raw, GET, POST, PATCH, routeDef, money, fmtDate, fmtTime, fmtDayLong, fmtMonth, fmtDT, dueBadge, badge, JOB_STATUS, TASK_TYPE, FREQ, empty, drawer, closeDrawer, refresh, run, safe, icon, todayStr, durationLabel, relDays */

const R = {
  job(j) {
    const end = new Date(Date.parse(j.start_at) + j.duration_min * 60000).toISOString();
    return html`<a class="list-item" href="#/servicos/${j.id}">
      <span class="dot" style="background:${j.crew_color || '#94a3b8'}"></span>
      <div class="grow"><div class="title">${j.start_at ? `${fmtTime(j.start_at)} - ${fmtTime(end)}` : 'Sem horário'} · ${j.client_name}</div>
      <div class="meta">${j.title} · ${j.crew_name || 'sem equipe'}${j.line1 ? ` · ${j.line1}, ${j.city || ''}` : ''}</div></div>
      <div class="side stack tight" style="align-items:flex-end">${badge(JOB_STATUS, j.status)}${j.conflicts && j.conflicts.length ? html`<span class="badge danger">conflito de horário</span>` : ''}</div></a>`;
  },
  quote(q) {
    return html`<a class="list-item" href="#/orcamentos/${q.id}"><div class="grow"><div class="title">${q.client_name} · ${q.number}</div>
      <div class="meta">${q.title} · enviado ${q.days_waiting === 0 ? 'hoje' : `há ${q.days_waiting} dia(s)`} · válido até ${fmtDate(q.valid_until)}</div></div>
      <div class="side"><div class="num" style="font-weight:600">${money(q.total)}</div>${q.expired ? html`<span class="badge danger">vencido</span>` : ''}</div></a>`;
  },
  follow(f) {
    return html`<a class="list-item" href="#/clientes/${f.client_id}"><div class="grow"><div class="title">${f.client_name}</div><div class="meta">${f.next_action} · ${f.owner || 'sem responsável'}</div></div><div class="side">${dueBadge(f.next_action_due)}</div></a>`;
  },
  invoice(i) {
    return html`<a class="list-item" href="#/cobrancas/${i.id}"><div class="grow"><div class="title">${i.client_name} · ${i.number}</div>
      <div class="meta">Vencimento ${fmtDate(i.due_date)}${i.days_overdue ? ` · ${i.days_overdue} dia(s) em atraso` : ''}${i.paid ? ` · pago ${money(i.paid)} de ${money(i.amount)}` : ''}</div></div>
      <div class="side num" style="font-weight:600">${money(i.balance)}</div></a>`;
  },
  task(tk) {
    const done = ['done', 'canceled'].includes(tk.status);
    return html`<div class="list-item">
      <label class="check" title="Marcar como concluída"><input type="checkbox" data-act="task-toggle" data-id="${tk.id}" ${done ? 'checked' : ''} aria-label="Concluir tarefa"></label>
      <div class="grow"><div class="title" style="${done ? 'text-decoration:line-through;color:var(--text-3)' : ''}">${tk.title}</div>
      <div class="meta">${tk.assignee}${tk.client_name ? html` · <a href="#/clientes/${tk.client_id}">${tk.client_name}</a>` : ''}${tk.job_id ? html` · <a href="#/servicos/${tk.job_id}">serviço</a>` : ''} · ${TASK_TYPE[tk.type]}</div></div>
      <div class="side stack tight" style="align-items:flex-end">${dueBadge(tk.due_date)}${tk.priority === 'high' ? html`<span class="badge danger">prioridade alta</span>` : ''}</div></div>`;
  },
  pending(j) {
    return html`<a class="list-item" href="#/servicos/${j.id}"><div class="grow"><div class="title">${j.client_name}</div><div class="meta">${j.title} · ${FREQ[j.requested_frequency] || 'Avulso'} · aprovado em ${fmtDate(j.created_at.slice(0, 10))}</div></div><div class="side">${j.price != null ? html`<div class="num">${money(j.price)}</div>` : ''}<span class="badge warn">agendar</span></div></a>`;
  },
  toBill(j) {
    return html`<a class="list-item" href="#/servicos/${j.id}"><div class="grow"><div class="title">${j.client_name}</div><div class="meta">${j.title} · concluído</div></div><div class="side num" style="font-weight:600">${money(j.to_bill)}</div></a>`;
  },
  payment(p) {
    return html`<a class="list-item" href="#/cobrancas/${p.invoice_id}"><div class="grow"><div class="title">${p.client_name} · ${p.number}</div><div class="meta">${fmtDate(p.paid_date)} · ${S.meta.methods[p.method] || p.method}</div></div><div class="side num" style="font-weight:600">${money(p.amount)}</div></a>`;
  },
};
window.R = R;

let TODAY = null;
const LISTS = {
  jobs: () => ['Serviços de hoje', TODAY.jobs_today, R.job, 'Nenhum serviço agendado para hoje.'],
  quotes: () => ['Orçamentos aguardando resposta', TODAY.quotes_awaiting, R.quote, 'Nenhum orçamento aguardando resposta.'],
  followups: () => ['Follow-ups de hoje e atrasados', [...TODAY.followups.overdue, ...TODAY.followups.due_today], R.follow, 'Nenhum follow-up previsto para hoje.'],
  overdue: () => ['Cobranças vencidas', TODAY.overdue_invoices, R.invoice, 'Nenhuma cobrança vencida.'],
  tasks: () => ['Tarefas pendentes', TODAY.tasks, R.task, 'Nenhuma tarefa pendente.'],
  pending: () => ['Aguardando agendamento', TODAY.pending_schedule, R.pending, 'Nenhum serviço aguardando agendamento.'],
  tobill: () => ['Concluídos sem cobrança', TODAY.to_bill, R.toBill, 'Todos os serviços concluídos já foram cobrados.'],
  received: () => ['Pagamentos recebidos no mês', TODAY.received_items, R.payment, 'Nenhum pagamento registrado neste mês.'],
  receivable: () => ['A receber (não vencido)', TODAY.receivable_items, R.invoice, 'Nenhum valor a receber.'],
  human: () => ['Clientes aguardando atendimento humano', TODAY.needs_human, (c) => html`<a class="list-item" href="#/clientes/${c.client_id}"><div class="grow"><div class="title">${c.client_name}</div><div class="meta">${c.pause_reason === 'complaint' ? 'Reclamação em aberto: ofertas comerciais pausadas' : 'Cliente respondeu: sequência comercial pausada'}</div></div></a>`, 'Nenhum cliente aguardando.'],
};
ACT['open-list'] = (el) => {
  const [title, items, fn, emptyText] = LISTS[el.dataset.key]();
  drawer({ title, sub: `${items.length} registro(s)`, body: items.length ? html`<div class="list">${items.map(fn)}</div>` : empty(emptyText) });
};
ACT['task-toggle'] = (el) => {
  const done = el.checked;
  safe(run(async () => { await PATCH(`/api/tasks/${el.dataset.id}`, { status: done ? 'done' : 'open' }); closeDrawer(); await refresh(); }, { ok: done ? 'Tarefa concluída.' : 'Tarefa reaberta.' }).catch(() => { el.checked = !done; }));
};

function tile(key, label, value, hint, tone, n) {
  return html`<button class="tile ${n ? tone : 'zero'}" data-act="open-list" data-key="${key}"><span class="label">${label}</span><span class="value">${value}</span><span class="hint">${hint}</span></button>`;
}

function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: S.me.company.timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

async function viewToday() {
  TODAY = await GET('/api/today');
  const d = TODAY;
  const first = S.me.user.name.split(' ')[0];
  if (S.me.user.role === 'field') return viewFieldToday(d, first);
  const sumQ = (d.quotes_awaiting || []).reduce((s, q) => s + q.total, 0);
  const sumOver = (d.overdue_invoices || []).reduce((s, i) => s + i.balance, 0);
  const overdueTasks = d.tasks.filter((x) => x.overdue).length;
  const fu = d.followups || { overdue: [], due_today: [] };
  const p = S.me.perms;
  const tiles = [
    tile('jobs', 'Serviços hoje', d.jobs_today.length, d.jobs_today.filter((j) => j.status === 'in_progress').length ? `${d.jobs_today.filter((j) => j.status === 'in_progress').length} em andamento` : 'agendados para hoje', 'info', d.jobs_today.length),
    p.sales && tile('quotes', 'Orçamentos aguardando', d.quotes_awaiting.length, d.quotes_awaiting.length ? `${money(sumQ)} em negociação` : 'nenhum em aberto', 'warn', d.quotes_awaiting.length),
    p.sales && tile('followups', 'Follow-ups', fu.overdue.length + fu.due_today.length, `${fu.overdue.length} atrasado(s) · ${fu.due_today.length} para hoje`, fu.overdue.length ? 'alert' : 'warn', fu.overdue.length + fu.due_today.length),
    p.finance && tile('overdue', 'Cobranças vencidas', d.overdue_invoices.length, d.overdue_invoices.length ? `${money(sumOver)} em atraso` : 'nada vencido', 'alert', d.overdue_invoices.length),
    tile('tasks', 'Tarefas pendentes', d.tasks.length, overdueTasks ? `${overdueTasks} atrasada(s)` : 'nenhuma atrasada', overdueTasks ? 'alert' : 'info', d.tasks.length),
    p.schedule && tile('pending', 'Aguardando agendamento', d.pending_schedule.length, 'aprovados sem data', 'warn', d.pending_schedule.length),
    p.finance && tile('tobill', 'Concluídos sem cobrança', d.to_bill.length, d.to_bill.length ? `${money(d.to_bill.reduce((s, j) => s + j.to_bill, 0))} a cobrar` : 'tudo cobrado', 'alert', d.to_bill.length),
    d.needs_human && tile('human', 'Aguardando atendimento', d.needs_human.length, 'respostas e reclamações', 'alert', d.needs_human.length),
  ].filter(Boolean);
  const pr = [...fu.overdue, ...fu.due_today].slice(0, 6);
  return {
    title: 'Hoje',
    html: html`
      <div class="page-head"><div><h1>${greeting()}, ${first}</h1><div class="sub">${fmtDayLong(d.today)} · O que precisa da sua atenção hoje</div></div></div>
      <div class="tiles">${tiles}</div>
      ${d.money ? html`<div class="section-title mt-lg">Dinheiro · ${fmtMonth(d.money.month)}</div>
      <div class="money-row">
        <button class="tile ok" data-act="open-list" data-key="received"><span class="label">Recebido no mês</span><span class="value">${money(d.money.received_month)}</span><span class="hint">${money(d.money.received_payments)} em cobranças${d.money.received_incomes ? ` + ${money(d.money.received_incomes)} manual` : ''}</span></button>
        <button class="tile info" data-act="open-list" data-key="receivable"><span class="label">A receber (no prazo)</span><span class="value">${money(d.money.receivable)}</span><span class="hint">cobranças emitidas ainda não vencidas</span></button>
        <button class="tile ${d.money.overdue ? 'alert' : 'zero'}" data-act="open-list" data-key="overdue"><span class="label">Vencido</span><span class="value">${money(d.money.overdue)}</span><span class="hint">saldo de cobranças em atraso</span></button>
      </div>
      <p class="small muted mt">Valores registrados no sistema. Não representam saldo bancário nem lucro.</p>` : ''}
      <div class="grid grid-2 mt-lg">
        <div class="card"><div class="card-head"><h2>Agenda de hoje</h2><a class="btn ghost sm" href="#/agenda">Ver agenda</a></div>
          ${d.jobs_today.length ? html`<div class="list">${d.jobs_today.map(R.job)}</div>` : empty('Nenhum serviço hoje', 'Serviços agendados para hoje aparecem aqui.')}</div>
        <div class="stack">
          ${p.sales ? html`<div class="card"><div class="card-head"><h2>Follow-ups</h2><span class="small muted">${fu.overdue.length} atrasado(s)</span></div>
            ${pr.length ? html`<div class="list">${pr.map(R.follow)}</div>` : empty('Nenhum follow-up para hoje', 'As próximas ações de cada cliente aparecem aqui no dia previsto.')}</div>` : ''}
          <div class="card"><div class="card-head"><h2>Tarefas</h2><a class="btn ghost sm" href="#/tarefas">Ver todas</a></div>
            ${d.tasks.length ? html`<div class="list">${d.tasks.slice(0, 6).map(R.task)}</div>` : empty('Nenhuma tarefa pendente')}</div>
        </div>
      </div>`,
  };
}

function viewFieldToday(d, first) {
  return {
    title: 'Hoje',
    html: html`
      <div class="page-head"><div><h1>${greeting()}, ${first}</h1><div class="sub">${fmtDayLong(d.today)} · Seus serviços de hoje</div></div></div>
      <div class="stack">
        ${d.jobs_today.length ? d.jobs_today.map((j) => html`<div class="card card-pad stack" style="border-left:4px solid ${j.crew_color || 'var(--primary)'}">
          <div class="row between top"><div><div style="font-weight:650;font-size:17px">${fmtTime(j.start_at)} · ${j.client_name}</div>
            <div class="muted">${j.title} · ${durationLabel(j.duration_min)}</div></div>${badge(JOB_STATUS, j.status)}</div>
          <div class="row top">${icon('map')}<div>${j.line1}${j.line2 ? `, ${j.line2}` : ''}<br><span class="muted">${j.city || ''} ${j.state || ''} ${j.zip || ''}</span>${j.access_notes ? html`<div class="small" style="margin-top:4px"><strong>Acesso:</strong> ${j.access_notes}</div>` : ''}</div></div>
          <div class="btn-group">
            ${j.status === 'scheduled' && !j.on_the_way_at ? html`<button class="btn lg" data-act="job-action" data-action="on_the_way" data-id="${j.id}">A caminho</button>` : ''}
            ${j.status === 'scheduled' ? html`<button class="btn primary lg" data-act="job-action" data-action="start" data-id="${j.id}">Iniciar serviço</button>` : ''}
            <a class="btn lg" href="#/servicos/${j.id}">${j.status === 'in_progress' ? 'Checklist e conclusão' : 'Ver detalhes'}</a>
          </div></div>`) : html`<div class="card">${empty('Nenhum serviço atribuído para hoje', 'Seus serviços aparecem aqui quando forem agendados para sua equipe.')}</div>`}
        <div class="card"><div class="card-head"><h2>Minhas tarefas</h2></div>${d.tasks.length ? html`<div class="list">${d.tasks.map(R.task)}</div>` : empty('Nenhuma tarefa pendente')}</div>
      </div>`,
  };
}

routeDef('/', viewToday);
routeDef('/hoje', viewToday);
void relDays; void fmtDT; void raw; void POST; void todayStr;
