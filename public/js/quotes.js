// Orçamentos: lista, criação/edição, visualização e envio (simulado).
/* global S, ACT, FORMS, html, val, GET, POST, PATCH, routeDef, money, parseMoney, centsToInput, fmtDate, fmtDT, badge, QUOTE_STATUS, MSG_STATUS, JOB_STATUS, CH, FREQ, empty, modal, closeModal, refresh, run, safe, go, icon, opts, todayStr, showFormError, TZ, demoNote, localDateOf, toast, formData */

const CATALOG = [
  ['Standard clean', 15000], ['Deep clean', 30000], ['Move-out cleaning', 38000], ['Move-in cleaning', 35000],
  ['Interior da geladeira', 4000], ['Interior do forno', 4000], ['Janelas internas', 6000], ['Lavanderia (dobrar roupas)', 3000],
];

async function viewQuotes({ query }) {
  const st = query.status || '';
  const list = await GET('/api/quotes' + (st ? `?status=${st}` : ''));
  return {
    title: 'Orçamentos',
    html: html`<div class="crumbs"><a href="#/comercial">Comercial</a> / Orçamentos</div>
      <div class="page-head"><div><h1>Orçamentos</h1></div><div class="btn-group"><a class="btn primary" href="#/orcamentos/novo">${icon('plus')} Novo orçamento</a></div></div>
      <div class="tabs">${[['', 'Todos'], ['draft', 'Rascunhos'], ['sent', 'Aguardando resposta'], ['approved', 'Aprovados'], ['declined', 'Recusados']].map(([k, l]) => html`<a class="tab ${st === k ? 'active' : ''}" href="#/orcamentos${k ? `?status=${k}` : ''}">${l}</a>`)}</div>
      <div class="card">${list.length ? html`<div class="list">${list.map((q) => html`<a class="list-item" href="#/orcamentos/${q.id}"><div class="grow"><div class="title">${q.number} · ${q.client_name}</div><div class="meta">${q.title} · ${q.sent_at ? `enviado ${fmtDate(localDateOf(q.sent_at))}` : `criado ${fmtDate(localDateOf(q.created_at))}`} · válido até ${fmtDate(q.valid_until)}</div></div><div class="side stack tight" style="align-items:flex-end"><span class="num" style="font-weight:600">${money(q.total)}</span>${badge(QUOTE_STATUS, q.status)}</div></a>`)}</div>` : empty('Nenhum orçamento nesta lista')}</div>`,
  };
}

// ---------- Editor ----------
function itemRow(it = {}, i = 0) {
  return html`<div class="item-row" data-item>
    <div class="stack tight"><input type="text" name="desc" placeholder="Serviço" value="${it.description || ''}" aria-label="Serviço ${i + 1}">
      <input type="text" name="details" placeholder="Descrição (opcional)" value="${it.details || ''}" aria-label="Descrição" class="small" style="min-height:34px;font-size:13px"></div>
    <input type="number" name="qty" min="0.25" step="0.25" value="${it.quantity ?? 1}" aria-label="Quantidade">
    <input type="text" name="price" inputmode="decimal" placeholder="0.00" value="${it.unit_price != null ? centsToInput(it.unit_price) : ''}" aria-label="Preço unitário em dólares">
    <button type="button" class="icon-btn" data-act="rm-item" aria-label="Remover serviço">${icon('x')}</button></div>`;
}

async function viewQuoteEditor({ params, query }) {
  const editing = params.id ? await GET(`/api/quotes/${params.id}`) : null;
  if (editing && editing.status !== 'draft') { go(`#/orcamentos/${editing.id}`); return { title: '', html: '' }; }
  const clientId = editing ? editing.client_id : query.cliente;
  const clients = clientId ? null : await GET('/api/clients');
  const client = clientId ? await GET(`/api/clients/${clientId}`) : null;
  const terms = editing ? editing.payment_terms : { type: 'on_completion', due_days: 0, deposit_percent: 30 };
  const items = editing ? editing.items : [{ description: '', quantity: 1, unit_price: null }];
  return {
    title: editing ? `Editar ${editing.number}` : 'Novo orçamento',
    html: html`<div class="crumbs"><a href="#/comercial">Comercial</a> / ${editing ? editing.number : 'Novo orçamento'}</div>
      <div class="page-head"><div><h1>${editing ? `Editar orçamento ${editing.number}` : 'Novo orçamento'}</h1><div class="sub">Os dados do cliente e do endereço são aproveitados automaticamente.</div></div></div>
      <form class="form" data-form="quote" data-id="${editing ? editing.id : ''}" novalidate>
      <div class="grid grid-side">
        <div class="stack" style="min-width:0">
          <div class="card card-pad form">
            ${client ? html`<input type="hidden" name="client_id" value="${client.id}"><input type="hidden" name="opportunity_id" value="${query.op || (editing && editing.opportunity_id) || ''}">
              <div class="row between"><div><div class="section-title" style="margin:0">Cliente</div><div style="font-weight:650;font-size:16px">${client.name}</div><div class="small muted">${[client.phone, client.email].filter(Boolean).join(' · ')}</div></div>${!editing ? html`<a class="btn sm" href="#/orcamentos/novo">Trocar</a>` : ''}</div>
              <div class="field"><label>Endereço do serviço</label>${client.addresses.length ? html`<select name="address_id">${opts(client.addresses.map((a) => [a.id, `${a.label}: ${a.line1}, ${a.city || ''}`]), editing ? editing.address_id : client.addresses[0].id)}</select>` : html`<div class="callout warn small">Cliente sem endereço cadastrado. <a href="#/clientes/${client.id}">Adicionar endereço na ficha</a> ou salve e complete depois.</div>`}</div>`
    : html`<div class="field"><label class="req" for="q-client">Cliente</label><select id="q-client" data-act-change="pick-client">${opts(clients.map((c) => [c.id, `${c.name}${c.phone ? ` · ${c.phone}` : ''}`]), '', { blank: 'Selecione o cliente' })}</select>
              <div class="help">Cliente novo? <a href="#" data-act="new-lead">Cadastre o contato primeiro</a>.</div></div>`}
          </div>
          <div class="card card-pad form">
            <div class="row between"><h2>Serviços</h2><span class="small muted">Valores em US$ por visita</span></div>
            <div class="catalog">${CATALOG.map(([n, p]) => html`<button type="button" data-act="add-cat" data-name="${n}" data-price="${p}">+ ${n} <span class="muted">${money(p)}</span></button>`)}</div>
            <div class="item-row small muted hide-mobile" style="font-weight:600"><span>Serviço</span><span>Qtd.</span><span>Preço</span><span></span></div>
            <div id="items" class="stack">${items.map(itemRow)}</div>
            <div><button type="button" class="btn sm" data-act="add-item">${icon('plus')} Adicionar linha</button></div>
            <div class="field"><label for="q-notes">Descrição e instruções</label><textarea id="q-notes" name="notes" placeholder="Escopo combinado. Vira instrução do serviço após aprovação.">${editing ? editing.notes || '' : ''}</textarea></div>
          </div>
        </div>
        <div class="stack">
          <div class="card card-pad form">
            <div class="field"><label>Frequência proposta</label><div class="radio-cards">${Object.entries(FREQ).map(([k, l]) => html`<label class="radio-card"><input type="radio" name="frequency" value="${k}" ${(editing ? editing.frequency : 'one_time') === k ? 'checked' : ''}>${l}</label>`)}</div></div>
            <div class="field"><label>Condição de pagamento</label><div class="radio-cards">
              <label class="radio-card"><input type="radio" name="terms_type" value="on_completion" ${terms.type !== 'deposit' ? 'checked' : ''}>Integral após a conclusão</label>
              <label class="radio-card"><input type="radio" name="terms_type" value="deposit" ${terms.type === 'deposit' ? 'checked' : ''}>Depósito na aprovação + restante</label></div></div>
            <div class="form-row"><div class="field ${terms.type === 'deposit' ? '' : 'hidden'}" id="dep-field"><label for="q-dep">Depósito (%)</label><input id="q-dep" name="deposit_percent" type="number" min="1" max="100" value="${terms.deposit_percent || 30}"></div>
              <div class="field"><label for="q-due">Prazo para pagar (dias)</label><input id="q-due" name="due_days" type="number" min="0" max="60" value="${terms.due_days || 0}"><div class="help">0 = vence no dia da cobrança</div></div></div>
            <div class="field"><label class="req" for="q-valid">Válido até</label><input id="q-valid" name="valid_until" type="date" value="${editing ? editing.valid_until : TZ.addDays(todayStr(), 14)}" min="${todayStr()}"></div>
          </div>
          <div class="card card-pad stack">
            <div class="row between"><span class="muted">Total por visita</span><span id="q-total" class="num" style="font-size:24px;font-weight:700">$0.00</span></div>
            <div id="q-dep-line" class="small muted"></div>
            <button type="submit" class="btn primary lg block" data-send="1">Salvar e enviar ao cliente</button>
            <button type="submit" class="btn block" data-send="0">Salvar rascunho</button>
            <p class="small muted">O envio é simulado: nada sai do sistema. O cliente recebe (em demonstração) um link para aprovar.</p>
          </div>
        </div>
      </div></form>`,
    after(el) {
      const form = el.querySelector('form');
      const recalc = () => {
        let total = 0;
        form.querySelectorAll('[data-item]').forEach((r) => { const p = parseMoney(r.querySelector('[name=price]').value) || 0; const q = Number(r.querySelector('[name=qty]').value) || 0; total += Math.round(p * q); });
        el.querySelector('#q-total').textContent = money(total);
        const dep = formData(form).terms_type === 'deposit';
        el.querySelector('#dep-field').classList.toggle('hidden', !dep);
        const pct = Number(form.deposit_percent.value) || 0;
        el.querySelector('#q-dep-line').textContent = dep && total ? `Depósito de ${money(Math.round(total * pct / 100))} cobrado na aprovação; restante de ${money(total - Math.round(total * pct / 100))} após a conclusão.` : total ? 'Cobrança integral gerada após a conclusão do serviço.' : '';
      };
      form.addEventListener('input', recalc); form.addEventListener('change', recalc); recalc();
      form.querySelectorAll('[type=submit]').forEach((b) => b.addEventListener('click', () => { form.dataset.send = b.dataset.send; }));
      const pick = el.querySelector('[data-act-change=pick-client]');
      if (pick) pick.addEventListener('change', () => { if (pick.value) go(`#/orcamentos/novo?cliente=${pick.value}`); });
    },
  };
}
ACT['add-item'] = () => { const box = document.getElementById('items'); box.insertAdjacentHTML('beforeend', val(itemRow({}, box.children.length))); box.lastElementChild.querySelector('input').focus(); };
ACT['add-cat'] = (el) => {
  const box = document.getElementById('items');
  const emptyRow = [...box.querySelectorAll('[data-item]')].find((r) => !r.querySelector('[name=desc]').value && !r.querySelector('[name=price]').value);
  const it = { description: el.dataset.name, quantity: 1, unit_price: Number(el.dataset.price) };
  if (emptyRow) emptyRow.outerHTML = val(itemRow(it)); else box.insertAdjacentHTML('beforeend', val(itemRow(it)));
  box.closest('form').dispatchEvent(new Event('input'));
};
ACT['rm-item'] = (el) => { const box = document.getElementById('items'); if (box.children.length > 1) el.closest('[data-item]').remove(); else el.closest('[data-item]').querySelectorAll('input').forEach((i) => { i.value = i.name === 'qty' ? 1 : ''; }); box.closest('form').dispatchEvent(new Event('input')); };

FORMS.quote = async (form, d) => {
  if (!d.client_id) return showFormError(form, 'Selecione o cliente.');
  const items = [...form.querySelectorAll('[data-item]')].map((r) => ({ description: r.querySelector('[name=desc]').value.trim(), details: r.querySelector('[name=details]').value.trim(), quantity: Number(r.querySelector('[name=qty]').value), unit_price: parseMoney(r.querySelector('[name=price]').value) }))
    .filter((it) => it.description || it.unit_price);
  if (!items.length) return showFormError(form, 'Adicione pelo menos um serviço com valor.');
  const bad = items.findIndex((it) => !it.description || it.unit_price === null || Number.isNaN(it.unit_price));
  if (bad >= 0) return showFormError(form, `Linha ${bad + 1}: informe o serviço e um preço válido.`);
  const body = { client_id: Number(d.client_id), opportunity_id: d.opportunity_id ? Number(d.opportunity_id) : undefined, address_id: d.address_id ? Number(d.address_id) : undefined, items, notes: d.notes, frequency: d.frequency, valid_until: d.valid_until,
    payment_terms: { type: d.terms_type, deposit_percent: Number(d.deposit_percent), due_days: Number(d.due_days) } };
  const send = form.dataset.send === '1';
  const btn = form.querySelector(`[data-send="${send ? 1 : 0}"]`);
  const id = form.dataset.id;
  const r = await run(async () => {
    const saved = id ? await PATCH(`/api/quotes/${id}`, body) : await POST('/api/quotes', body);
    if (send) await POST(`/api/quotes/${saved.id}/send`);
    return saved;
  }, { form, btn });
  toast(send ? 'Orçamento enviado (simulação). Follow-ups programados na jornada.' : 'Rascunho salvo.');
  go(`#/orcamentos/${r.id}`);
};

// ---------- Visualização ----------
async function viewQuote({ params }) {
  const q = await GET(`/api/quotes/${params.id}`);
  const link = q.public_token ? `${location.origin}/q/${q.public_token}` : null;
  const actions = {
    draft: html`<a class="btn" href="#/orcamentos/${q.id}/editar">Editar</a><button class="btn" data-act="quote-approve" data-id="${q.id}" data-verbal="1">Registrar aprovação verbal</button><button class="btn primary" data-act="quote-send" data-id="${q.id}">Enviar ao cliente</button>`,
    sent: html`<button class="btn" data-act="quote-send" data-id="${q.id}">Reenviar</button><button class="btn danger" data-act="quote-decline" data-id="${q.id}">Marcar como recusado</button><button class="btn primary" data-act="quote-approve" data-id="${q.id}">Registrar aprovação</button>`,
    approved: q.job ? html`<a class="btn primary" href="#/servicos/${q.job.id}">Ver serviço</a>` : '',
    declined: html`<a class="btn" href="#/orcamentos/novo?cliente=${q.client_id}">Criar novo orçamento</a>`,
  }[q.status];
  return {
    title: q.number,
    html: html`<div class="crumbs"><a href="#/comercial">Comercial</a> / <a href="#/orcamentos">Orçamentos</a> / ${q.number}</div>
      <div class="page-head"><div><h1>Orçamento ${q.number}</h1><div class="sub"><a href="#/clientes/${q.client_id}">${q.client.name}</a> · criado por ${q.created_by_name || '-'} em ${fmtDate(localDateOf(q.created_at))}</div>
        <div class="row wrap mt">${badge(QUOTE_STATUS, q.status)}${q.expired ? html`<span class="badge danger">validade expirada</span>` : ''}${q.approved_via === 'client' ? html`<span class="badge">aprovado pelo cliente no link</span>` : ''}</div></div>
        <div class="btn-group">${actions}</div></div>
      <div class="grid grid-side">
        <div class="stack" style="min-width:0">
          ${q.status === 'approved' && q.job ? html`<div class="callout ok"><strong>Aprovado em ${fmtDT(q.approved_at)}.</strong> Os follow-ups foram encerrados e o serviço foi criado como ${JOB_STATUS[q.job.status][0].toLowerCase()}. ${q.job.status === 'pending_schedule' ? 'Combine a data com o cliente e agende.' : ''}${q.payment_terms.type === 'deposit' ? ` Cobrança de depósito de ${money(q.deposit_amount)} gerada.` : ''}</div>` : ''}
          <div class="doc">
            <div class="row between top wrap"><div><div style="font-weight:700;font-size:18px">${S.me.company.name}</div><div class="small muted">Quote ${q.number}</div></div><div class="right small"><div>Valid until ${fmtDate(q.valid_until)}</div></div></div>
            <div class="mt-lg"><div class="small muted">Prepared for</div><div style="font-weight:600">${q.client.name}</div>${q.address ? html`<div class="small">${q.address.line1}, ${q.address.city || ''} ${q.address.state || ''} ${q.address.zip || ''}</div>` : ''}</div>
            <table class="mt-lg"><thead><tr><th>Service</th><th class="right">Qty</th><th class="right">Price</th><th class="right">Total</th></tr></thead><tbody>
              ${q.items.map((it) => html`<tr><td>${it.description}${it.details ? html`<div class="small muted">${it.details}</div>` : ''}</td><td class="right num">${it.quantity}</td><td class="right num">${money(it.unit_price)}</td><td class="right num">${money(Math.round(it.quantity * it.unit_price))}</td></tr>`)}
              <tr class="total"><td colspan="3">Total ${q.frequency !== 'one_time' ? 'per visit' : ''}</td><td class="right num">${money(q.total)}</td></tr></tbody></table>
            ${q.notes ? html`<div class="mt small">${q.notes}</div>` : ''}
            <div class="mt small muted">${FREQ[q.frequency]} · ${q.terms_label}</div>
          </div>
        </div>
        <div class="stack">
          ${link ? html`<div class="card card-pad stack"><div class="section-title" style="margin:0">Link de aprovação do cliente</div>
            <a class="btn block" href="${link}" target="_blank" rel="noopener">Abrir visão do cliente</a>
            <p class="small muted">Em demonstração, abra o link para simular a aprovação ou recusa como se fosse o cliente.</p></div>` : ''}
          <div class="card card-pad"><div class="section-title">Follow-ups deste orçamento</div>
            ${q.followups.length ? html`<div class="stack tight">${q.followups.map((m) => html`<div class="row between wrap" style="border-bottom:1px solid var(--border);padding:6px 0"><span class="small"><strong>Etapa ${m.step_index + 1}</strong> · ${CH[m.channel]} · ${fmtDT(m.send_at)}${m.hold_reason ? html`<br><span class="muted">Aguardando: ${m.hold_reason}</span>` : m.status_reason ? html`<br><span class="muted">${m.status_reason}</span>` : ''}</span>${badge(MSG_STATUS, m.status)}</div>`)}</div>` : html`<p class="small muted">Os follow-ups são programados quando o orçamento é enviado.</p>`}</div>
          <div class="card card-pad"><div class="section-title">Histórico</div><div class="timeline">${q.history.map(window.historyItem)}</div></div>
        </div>
      </div>`,
  };
}
ACT['quote-send'] = (el) => safe(run(async () => { await POST(`/api/quotes/${el.dataset.id}/send`); refresh(); }, { btn: el, ok: 'Orçamento enviado (simulação).' }));
ACT['quote-approve'] = (el) => {
  const msg = el.dataset.verbal ? 'Registrar que o cliente aprovou este orçamento (por telefone ou pessoalmente)?' : 'Registrar a aprovação do cliente?';
  if (!confirm(msg + '\n\nOs follow-ups serão encerrados e um serviço pendente de agendamento será criado.')) return;
  safe(run(async () => { const r = await POST(`/api/quotes/${el.dataset.id}/approve`); refresh(); return r; }, { btn: el, ok: 'Aprovação registrada. Serviço criado aguardando agendamento.' }));
};
ACT['quote-decline'] = (el) => {
  modal({ title: 'Marcar orçamento como recusado', body: html`<form class="form" data-form="decline" data-id="${el.dataset.id}" novalidate><div class="field"><label class="req">Motivo</label><select name="reason">${opts(['Preço acima do esperado', 'Fechou com concorrente', 'Desistiu do serviço', 'Data indisponível', 'Outro'].map((x) => [x, x]), '')}</select></div><div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" type="submit">Confirmar recusa</button></div></form>` });
};
FORMS.decline = async (form, d) => { await run(() => POST(`/api/quotes/${form.dataset.id}/decline`, d), { form, ok: 'Orçamento recusado. Follow-ups encerrados.' }); closeModal(); refresh(); };

routeDef('/orcamentos', viewQuotes, { perm: ['sales'] });
routeDef('/orcamentos/novo', viewQuoteEditor, { perm: ['sales'] });
routeDef('/orcamentos/:id/editar', viewQuoteEditor, { perm: ['sales'] });
routeDef('/orcamentos/:id', viewQuote, { perm: ['sales'] });
void demoNote; void CH;
