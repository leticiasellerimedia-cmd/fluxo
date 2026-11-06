// Financeiro básico: contratado, cobrado, recebido, a receber, vencido e resultado direto por serviço.
/* global S, ACT, FORMS, html, GET, POST, routeDef, money, parseMoney, centsToInput, fmtDate, fmtDT, fmtMonth, badge, INV_STATUS, MSG_STATUS, CH, empty, modal, closeModal, refresh, run, safe, go, icon, opts, todayStr, showFormError, TZ, drawer, localDateOf, R, toast, hours, setQuery */

let FIN = null;
const FIN_LISTS = {
  contracted: () => ['Contratado no mês', FIN.contracted.items, (j) => html`<a class="list-item" href="#/servicos/${j.id}"><div class="grow"><div class="title">${j.client_name}</div><div class="meta">${j.title} · ${fmtDate(localDateOf(j.start_at))}</div></div><div class="side num">${money(j.price)}</div></a>`],
  billed: () => ['Cobrado no mês', FIN.billed.items, (i) => html`<a class="list-item" href="#/cobrancas/${i.id}"><div class="grow"><div class="title">${i.client_name} · ${i.number}</div><div class="meta">${i.kind === 'deposit' ? 'Depósito' : i.kind === 'final' ? 'Cobrança de serviço' : 'Avulsa'} · emitida ${fmtDate(i.issued_date)}</div></div><div class="side num">${money(i.amount)}</div></a>`],
  received: () => ['Recebido no mês', [...FIN.received.payments.map((p) => ({ ...p, _t: 'p' })), ...FIN.received.incomes.map((n) => ({ ...n, _t: 'i' }))], (x) => (x._t === 'p' ? R.payment(x) : html`<div class="list-item"><div class="grow"><div class="title">${x.description}</div><div class="meta">${fmtDate(x.date)} · receita manual${x.client_name ? ` · ${x.client_name}` : ''}</div></div><div class="side num">${money(x.amount)}</div></div>`)],
  receivable: () => ['A receber (no prazo)', FIN.receivable.items, R.invoice],
  overdue: () => ['Vencido', FIN.overdue.items, R.invoice],
  tobill: () => ['Executado e não cobrado', FIN.to_bill.items, R.toBill],
  expenses: () => ['Despesas do mês', FIN.expenses.items, (e) => html`<div class="list-item"><div class="grow"><div class="title">${e.description}</div><div class="meta">${fmtDate(e.date)} · ${e.category}${e.job_id ? html` · <a href="#/servicos/${e.job_id}">custo do serviço</a>` : ' · despesa geral'}</div></div><div class="side num">${money(e.amount)}</div></div>`],
  pending: () => ['Aprovado aguardando agendamento', FIN.contracted.pending_schedule, (j) => html`<a class="list-item" href="#/servicos/${j.id}"><div class="grow"><div class="title">${j.client_name}</div><div class="meta">${j.title}</div></div><div class="side num">${money(j.price)}</div></a>`],
};
ACT['fin-list'] = (el) => { const [title, items, fn] = FIN_LISTS[el.dataset.key](); drawer({ title, sub: `${items.length} registro(s)`, body: items.length ? html`<div class="list">${items.map(fn)}</div>` : empty('Nenhum registro neste período.') }); };

async function viewFinance({ query }) {
  FIN = await GET('/api/finance/summary' + (query.m ? `?m=${query.m}&month=${query.m}` : ''));
  const f = FIN;
  const invTab = query.inv || 'unpaid';
  const invoices = await GET('/api/invoices' + (invTab === 'all' ? '' : `?status=${invTab}`));
  const tile = (key, label, value, hint, tone) => html`<button class="tile ${tone}" data-act="fin-list" data-key="${key}"><span class="label">${label}</span><span class="value">${money(value)}</span><span class="hint">${hint}</span></button>`;
  const prev = TZ.addMonthsClamped(f.month + '-01', -1, 1).slice(0, 7); const next = TZ.addMonthsClamped(f.month + '-01', 1, 1).slice(0, 7);
  return {
    title: 'Financeiro',
    html: html`<div class="page-head"><div><h1>Financeiro</h1><div class="sub">Valores registrados no sistema · ${fmtMonth(f.month)}</div></div>
      <div class="btn-group"><button class="btn" data-act="new-expense">Registrar despesa</button><button class="btn" data-act="new-income">Receita manual</button><button class="btn primary" data-act="new-invoice">Cobrança avulsa</button></div></div>
      <div class="cal-toolbar"><div class="seg"><button data-act="fin-month" data-m="${prev}" aria-label="Mês anterior">${icon('chevL')}</button><button data-act="fin-month" data-m="${todayStr().slice(0, 7)}">Mês atual</button><button data-act="fin-month" data-m="${next}" aria-label="Próximo mês">${icon('chevR')}</button></div></div>
      <div class="callout info mb"><strong>O que este painel não mostra:</strong> saldo bancário e lucro líquido. Não há conexão com banco nem todos os custos gerais estão registrados, então qualquer número desse tipo seria inventado. Os pagamentos são registrados manualmente nesta versão.</div>
      <div class="section-title">Do contrato ao dinheiro · ${fmtMonth(f.month)}</div>
      <div class="tiles">
        ${tile('contracted', 'Contratado', f.contracted.total, `${f.contracted.items.length} serviço(s) com data no mês`, 'info')}
        ${tile('billed', 'Cobrado', f.billed.total, `${f.billed.items.length} cobrança(s) emitida(s)`, 'info')}
        ${tile('received', 'Recebido', f.received.total, f.received.incomes_total ? `inclui ${money(f.received.incomes_total)} manual` : 'pagamentos registrados', 'ok')}
        ${tile('expenses', 'Despesas registradas', f.expenses.total, `${money(f.expenses.direct)} diretas · ${money(f.expenses.general)} gerais`, 'warn')}
      </div>
      <div class="section-title mt-lg">Situação atual (todas as datas)</div>
      <div class="tiles">
        ${tile('receivable', 'A receber no prazo', f.receivable.total, `${f.receivable.items.length} cobrança(s)`, 'info')}
        ${tile('overdue', 'Vencido', f.overdue.total, `${f.overdue.items.length} cobrança(s) em atraso`, f.overdue.total ? 'alert' : 'zero')}
        ${tile('tobill', 'Executado sem cobrança', f.to_bill.total, `${f.to_bill.items.length} serviço(s) concluído(s)`, f.to_bill.total ? 'alert' : 'zero')}
        ${tile('pending', 'Aprovado sem agenda', f.contracted.pending_schedule_total, `${f.contracted.pending_schedule.length} serviço(s)`, 'warn')}
      </div>
      <div class="grid grid-side mt-lg">
        <div class="card" style="min-width:0"><div class="card-head"><h2>Resultado direto por serviço</h2><span class="small muted">Concluídos em ${fmtMonth(f.month)}</span></div>
          ${f.jobs.length ? html`<div class="table-wrap"><table class="table responsive"><thead><tr><th>Serviço</th><th class="right">Receita</th><th class="right">Custos diretos</th><th class="right">Resultado</th></tr></thead><tbody>
            ${f.jobs.map((j) => html`<tr><td data-l="Serviço"><a href="#/servicos/${j.id}">${j.client_name}</a><div class="small muted">${j.title} · ${fmtDate(localDateOf(j.start_at))} · ${hours(j.hours)}</div></td>
              <td data-l="Receita" class="right num">${money(j.revenue)}</td><td data-l="Custos" class="right num">${money(j.costs)}</td>
              <td data-l="Resultado" class="right num">${j.complete ? html`<strong>${money(j.result)}</strong>` : html`<span class="badge warn" title="${j.gaps.join('; ')}">faltam custos</span>`}</td></tr>`)}</tbody></table></div>
            <div class="card-body small muted" style="border-top:1px solid var(--border)">${f.direct_result.complete_count ? html`Serviços com custos completos: ${f.direct_result.complete_count}, receita ${money(f.direct_result.complete_revenue)}, resultado direto ${money(f.direct_result.complete_result)}.` : 'Nenhum serviço com custos completos neste mês.'}
            ${f.direct_result.incomplete_count ? ` ${f.direct_result.incomplete_count} serviço(s) sem resultado calculado por falta de dados.` : ''} Resultado direto = receita do serviço menos custos diretos registrados; não é lucro.</div>` : empty('Nenhum serviço concluído neste mês')}</div>
        <div class="card card-pad"><div class="section-title">Pendências de dados</div>
          ${f.data_gaps.length ? html`<div class="stack tight">${f.data_gaps.map((g) => html`<div class="small" style="border-bottom:1px solid var(--border);padding:6px 0">${g.job_id ? html`<a href="#/servicos/${g.job_id}">${g.text}</a>` : html`<a href="#/config">${g.text}</a>`}</div>`)}</div>` : html`<div class="callout ok small">Nenhuma pendência de dados.</div>`}</div>
      </div>
      <div class="card mt-lg"><div class="card-head"><h2>Cobranças</h2></div>
        <div class="tabs" style="padding:0 8px;margin:0">${[['unpaid', 'Em aberto'], ['overdue', 'Vencidas'], ['paid', 'Pagas'], ['all', 'Todas']].map(([k, l]) => html`<button class="tab ${invTab === k ? 'active' : ''}" data-act="inv-tab" data-k="${k}">${l}</button>`)}</div>
        ${invoices.length ? html`<div class="list">${invoices.map((i) => html`<a class="list-item" href="#/cobrancas/${i.id}"><div class="grow"><div class="title">${i.number} · ${i.client_name}</div><div class="meta">${i.description || ''} · vence ${fmtDate(i.due_date)}${i.paid ? ` · pago ${money(i.paid)}` : ''}</div></div><div class="side stack tight" style="align-items:flex-end"><span class="num" style="font-weight:600">${money(i.display_status === 'paid' || i.display_status === 'void' ? i.amount : i.balance)}</span>${badge(INV_STATUS, i.display_status)}</div></a>`)}</div>` : empty('Nenhuma cobrança nesta lista')}</div>`,
  };
}
ACT['fin-month'] = (el) => setQuery({ m: el.dataset.m });
ACT['inv-tab'] = (el) => setQuery({ inv: el.dataset.k });

async function viewInvoice({ params }) {
  const i = await GET(`/api/invoices/${params.id}`);
  const st = i.display_status;
  return {
    title: i.number,
    html: html`<div class="crumbs"><a href="#/financeiro">Financeiro</a> / ${i.number}</div>
      <div class="page-head"><div><h1>Cobrança ${i.number}</h1><div class="sub"><a href="#/clientes/${i.client.id}">${i.client.name}</a> · ${i.description || ''}</div><div class="row wrap mt">${badge(INV_STATUS, st)}<span class="badge">${i.kind === 'deposit' ? 'Depósito' : i.kind === 'final' ? 'Cobrança do serviço' : 'Avulsa'}</span></div></div>
        <div class="btn-group">${i.job_id ? html`<a class="btn" href="#/servicos/${i.job_id}">Ver serviço</a>` : ''}${['open', 'partial', 'overdue'].includes(st) ? html`${!i.paid ? html`<button class="btn danger" data-act="void-invoice" data-id="${i.id}">Anular</button>` : ''}<button class="btn primary" data-act="pay" data-id="${i.id}" data-balance="${i.balance}">Registrar pagamento</button>` : ''}</div></div>
      <div class="grid grid-side">
        <div class="stack" style="min-width:0">
          <div class="tiles">
            <div class="tile info" style="cursor:default"><span class="label">Valor</span><span class="value">${money(i.amount)}</span><span class="hint">emitida ${fmtDate(i.issued_date)}</span></div>
            <div class="tile ok" style="cursor:default"><span class="label">Recebido</span><span class="value">${money(i.paid)}</span><span class="hint">${i.payments.length} pagamento(s)</span></div>
            <div class="tile ${st === 'overdue' ? 'alert' : 'warn'}" style="cursor:default"><span class="label">Saldo em aberto</span><span class="value">${money(i.balance)}</span><span class="hint">vence ${fmtDate(i.due_date)}</span></div>
          </div>
          <div class="card"><div class="card-head"><h2>Pagamentos</h2></div>${i.payments.length ? html`<div class="list">${i.payments.map((p) => html`<div class="list-item"><div class="grow"><div class="title">${money(p.amount)}</div><div class="meta">${fmtDate(p.paid_date)} · ${S.meta.methods[p.method]} · registrado manualmente${p.note ? ` · ${p.note}` : ''}</div></div></div>`)}</div>` : empty('Nenhum pagamento registrado')}</div>
        </div>
        <div class="stack">
          <div class="card card-pad stack"><div class="section-title" style="margin:0">Pagamento online</div><div class="callout warn small"><strong>Integração pendente.</strong> ${i.payment_link.reason}</div></div>
          <div class="card card-pad"><div class="section-title">Lembretes de pagamento</div>${i.reminders.length ? html`<div class="stack tight">${i.reminders.map((m) => html`<div class="row between wrap" style="border-bottom:1px solid var(--border);padding:6px 0"><span class="small"><strong>Etapa ${m.step_index + 1}</strong> · ${CH[m.channel]} · ${fmtDT(m.send_at)}${m.status_reason ? html`<br><span class="muted">${m.status_reason}</span>` : ''}</span>${badge(MSG_STATUS, m.status)}</div>`)}</div>` : html`<div class="small muted">Sem lembretes.</div>`}</div>
        </div>
      </div>`,
  };
}
ACT.pay = (el) => {
  modal({ title: 'Registrar pagamento', body: html`<form class="form" data-form="pay" data-id="${el.dataset.id}" novalidate>
    <div class="callout info small">Saldo em aberto: <strong>${money(Number(el.dataset.balance))}</strong>. Registro manual: nenhuma cobrança é processada pelo sistema.</div>
    <div class="form-row"><div class="field"><label class="req">Valor recebido (US$)</label><input name="amount" type="text" inputmode="decimal" value="${centsToInput(Number(el.dataset.balance))}"></div>
      <div class="field"><label class="req">Data</label><input name="paid_date" type="date" value="${todayStr()}" max="${todayStr()}"></div></div>
    <div class="field"><label>Forma de pagamento</label><select name="method">${opts(Object.entries(S.meta.methods), 'zelle')}</select></div>
    <div class="field"><label>Observação</label><input name="note" type="text"></div>
    <div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" type="submit">Registrar pagamento</button></div></form>` });
};
FORMS.pay = async (form, d) => {
  const amount = parseMoney(d.amount); if (!amount || amount <= 0) return showFormError(form, 'Informe um valor válido.');
  const r = await run(() => POST(`/api/invoices/${form.dataset.id}/payments`, { ...d, amount }), { form });
  closeModal(); toast(r.status === 'paid' ? 'Pagamento integral registrado. Lembretes de cobrança encerrados.' : `Pagamento parcial registrado. Saldo: ${money(r.balance)}.`); refresh();
};
ACT['void-invoice'] = (el) => {
  modal({ title: 'Anular cobrança', body: html`<form class="form" data-form="void" data-id="${el.dataset.id}" novalidate><div class="field"><label class="req">Motivo</label><input name="reason" type="text" placeholder="Ex.: valor emitido errado"></div><p class="small muted">Os lembretes de pagamento serão encerrados. Se necessário, gere uma nova cobrança no serviço.</p><div class="form-actions"><button type="button" class="btn" data-act="close-modal">Voltar</button><button class="btn danger" type="submit">Anular</button></div></form>` });
};
FORMS.void = async (form, d) => { if (!d.reason.trim()) return showFormError(form, 'Informe o motivo.'); await run(() => POST(`/api/invoices/${form.dataset.id}/void`, d), { form, ok: 'Cobrança anulada.' }); closeModal(); refresh(); };

ACT['new-expense'] = () => {
  modal({ title: 'Registrar despesa', body: html`<form class="form" data-form="expense" novalidate>
    <div class="field"><label class="req">Descrição</label><input name="description" type="text"></div>
    <div class="form-row"><div class="field"><label class="req">Valor (US$)</label><input name="amount" type="text" inputmode="decimal"></div><div class="field"><label class="req">Data</label><input name="date" type="date" value="${todayStr()}"></div></div>
    <div class="field"><label>Categoria</label><select name="category">${opts(S.meta.expense_categories.map((c) => [c, c]), 'Outros')}</select></div>
    <p class="small muted">Para um custo de um serviço específico, registre pela tela do serviço: ele entra no resultado direto.</p>
    <div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" type="submit">Registrar</button></div></form>` });
};
FORMS.expense = async (form, d) => { const amount = parseMoney(d.amount); if (!amount || amount <= 0) return showFormError(form, 'Informe um valor válido.'); await run(() => POST('/api/expenses', { ...d, amount }), { form, ok: 'Despesa registrada.' }); closeModal(); refresh(); };
ACT['new-income'] = async () => {
  const clients = await GET('/api/clients');
  modal({ title: 'Registrar receita manual', body: html`<form class="form" data-form="income" novalidate>
    <div class="callout info small">Use para valores recebidos fora das cobranças (ex.: serviço pago na hora sem orçamento). Pagamentos de cobranças devem ser registrados na própria cobrança.</div>
    <div class="field"><label class="req">Descrição</label><input name="description" type="text"></div>
    <div class="form-row"><div class="field"><label class="req">Valor (US$)</label><input name="amount" type="text" inputmode="decimal"></div><div class="field"><label class="req">Data</label><input name="date" type="date" value="${todayStr()}" max="${todayStr()}"></div></div>
    <div class="field"><label>Cliente (opcional)</label><select name="client_id">${opts(clients.map((c) => [c.id, c.name]), '', { blank: 'Sem cliente' })}</select></div>
    <div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" type="submit">Registrar</button></div></form>` });
};
FORMS.income = async (form, d) => { const amount = parseMoney(d.amount); if (!amount || amount <= 0) return showFormError(form, 'Informe um valor válido.'); await run(() => POST('/api/incomes', { ...d, amount }), { form, ok: 'Receita registrada.' }); closeModal(); refresh(); };
ACT['new-invoice'] = async () => {
  const clients = await GET('/api/clients');
  modal({ title: 'Cobrança avulsa', body: html`<form class="form" data-form="invoice" novalidate>
    <p class="small muted">Para cobranças sem serviço. A cobrança de um serviço deve ser gerada na tela do serviço, conforme o orçamento.</p>
    <div class="field"><label class="req">Cliente</label><select name="client_id">${opts(clients.map((c) => [c.id, c.name]), '', { blank: 'Selecione' })}</select></div>
    <div class="field"><label class="req">Descrição</label><input name="description" type="text"></div>
    <div class="form-row"><div class="field"><label class="req">Valor (US$)</label><input name="amount" type="text" inputmode="decimal"></div><div class="field"><label class="req">Vencimento</label><input name="due_date" type="date" value="${TZ.addDays(todayStr(), 7)}"></div></div>
    <div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" type="submit">Emitir cobrança</button></div></form>` });
};
FORMS.invoice = async (form, d) => { const amount = parseMoney(d.amount); if (!d.client_id) return showFormError(form, 'Selecione o cliente.'); if (!amount || amount <= 0) return showFormError(form, 'Informe um valor válido.'); const r = await run(() => POST('/api/invoices', { ...d, amount }), { form, ok: 'Cobrança emitida (simulação de envio).' }); closeModal(); go(`#/cobrancas/${r.id}`); };

routeDef('/financeiro', viewFinance, { perm: ['finance'] });
routeDef('/cobrancas/:id', viewInvoice, { perm: ['finance'] });
