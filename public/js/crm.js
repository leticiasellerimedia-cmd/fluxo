// Clientes, novo contato (com aviso de duplicidade) e funil comercial.
/* global S, ACT, FORMS, html, raw, esc, val, GET, POST, PATCH, routeDef, money, parseMoney, centsToInput, fmtDate, fmtDT, fmtTime, dueBadge, badge, JOB_STATUS, QUOTE_STATUS, INV_STATUS, STAGES, TASK_STATUS, TASK_TYPE, CH, CAT, FREQ, empty, modal, closeModal, refresh, run, safe, go, icon, opts, staffOpts, todayStr, showFormError, TZ, R, demoNote, localDateOf */

// ---------- Lista de clientes ----------
let searchTimer = null;
async function viewClients({ query }) {
  const q = query.q || '';
  const list = await GET('/api/clients?q=' + encodeURIComponent(q));
  const rows = list.map((c) => html`<a class="list-item" href="#/clientes/${c.id}">
    <div class="grow"><div class="title">${c.name}</div>
      <div class="meta">${[c.phone, c.email, c.city].filter(Boolean).join(' · ')}</div>
      ${c.next_action ? html`<div class="meta" style="color:var(--text-2)">Próxima ação: ${c.next_action}${c.next_action_owner ? ` · ${c.next_action_owner}` : ''}</div>` : ''}</div>
    <div class="side stack tight" style="align-items:flex-end">
      ${c.next_action_due ? dueBadge(c.next_action_due) : ''}
      ${c.has_open_complaint ? html`<span class="badge danger">reclamação aberta</span>` : ''}
      ${c.automation_paused ? html`<span class="badge warn">automações pausadas</span>` : ''}
      ${c.next_job_at ? html`<span class="badge info">próx. serviço ${fmtDate(localDateOf(c.next_job_at))}</span>` : ''}
    </div></a>`);
  return {
    title: 'Clientes',
    html: html`<div class="page-head"><div><h1>Clientes</h1><div class="sub">${list.length} cliente(s)${q ? ` para "${q}"` : ''}</div></div>
      <div class="btn-group"><button class="btn primary" data-act="new-lead">${icon('plus')} Novo contato</button></div></div>
      <div class="card"><div class="card-body" style="border-bottom:1px solid var(--border)">
        <input type="search" id="client-search" placeholder="Buscar por nome, telefone ou e-mail" value="${q}" aria-label="Buscar clientes"></div>
        ${list.length ? html`<div class="list">${rows}</div>` : q ? empty('Nenhum cliente encontrado', 'Confira a grafia ou busque pelo telefone.', html`<button class="btn" data-act="new-lead">Cadastrar novo contato</button>`) : empty('Nenhum cliente ainda', 'Cadastre o primeiro contato para começar.', html`<button class="btn primary" data-act="new-lead">Novo contato</button>`)}
      </div>`,
    after(el) {
      const input = el.querySelector('#client-search');
      input.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { history.replaceState(null, '', '#/clientes' + (input.value ? '?q=' + encodeURIComponent(input.value) : '')); viewClients({ query: { q: input.value } }).then((out) => { const m = document.getElementById('main'); m.innerHTML = val(out.html); out.after(m); const i2 = m.querySelector('#client-search'); i2.focus(); i2.setSelectionRange(i2.value.length, i2.value.length); }); }, 300); });
    },
  };
}

// ---------- Novo contato ----------
ACT['new-lead'] = () => {
  modal({ title: 'Novo contato', body: html`<form class="form" data-form="lead" novalidate>
    <div class="field"><label class="req" for="ld-name">Nome</label><input id="ld-name" name="name" type="text" required autocomplete="off"></div>
    <div class="form-row"><div class="field"><label for="ld-phone">Telefone</label><input id="ld-phone" name="phone" type="tel" placeholder="(407) 555-0123" data-dup></div>
      <div class="field"><label for="ld-email">E-mail</label><input id="ld-email" name="email" type="email" data-dup></div></div>
    <div class="help small muted" style="margin-top:-8px">Informe pelo menos telefone ou e-mail.</div>
    <div id="dup-box"></div>
    <div class="form-row"><div class="field"><label for="ld-src">Origem do contato</label><select id="ld-src" name="source">${opts(S.meta.sources.map((s) => [s, s]), '', { blank: 'Selecione' })}</select></div>
      <div class="field"><label for="ld-int">Serviço de interesse</label><input id="ld-int" name="service_interest" type="text" placeholder="Ex.: Deep clean"></div></div>
    <button type="button" class="reveal" data-act="reveal" data-target="ld-more">+ Endereço, valor estimado e observações</button>
    <div id="ld-more" class="hidden stack">
      <div class="field"><label for="ld-a1">Endereço de atendimento</label><input id="ld-a1" name="line1" type="text" placeholder="1420 Lakeview Dr"></div>
      <div class="form-row three"><div class="field"><label for="ld-city">Cidade</label><input id="ld-city" name="city" type="text"></div>
        <div class="field"><label for="ld-st">Estado</label><input id="ld-st" name="state" type="text" maxlength="2" placeholder="FL"></div>
        <div class="field"><label for="ld-zip">ZIP</label><input id="ld-zip" name="zip" type="text" inputmode="numeric"></div></div>
      <div class="form-row"><div class="field"><label for="ld-val">Valor estimado (US$)</label><input id="ld-val" name="estimated_value" type="text" inputmode="decimal"></div>
        <div class="field"><label for="ld-owner">Responsável</label><select id="ld-owner" name="owner_id">${staffOpts(S.meta.users.find((u) => u.role === 'assistant')?.id)}</select></div></div>
      <div class="field"><label for="ld-notes">Observações</label><textarea id="ld-notes" name="notes"></textarea></div>
    </div>
    <input type="hidden" name="ignore_duplicates" value="">
    <div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button type="submit" class="btn primary">Cadastrar contato</button></div>
  </form>` });
  const form = document.querySelector('form[data-form=lead]');
  const check = async () => {
    const d = formData(form);
    if (!d.phone && !d.email && (d.name || '').length < 4) return;
    try { renderDups(form, await POST('/api/clients/check-duplicates', { name: d.name, phone: d.phone, email: d.email })); } catch { /* sem aviso */ }
  };
  form.querySelectorAll('[data-dup], #ld-name').forEach((i) => i.addEventListener('blur', check));
};
function renderDups(form, dups) {
  const box = form.querySelector('#dup-box');
  if (!dups.length) { box.innerHTML = ''; return; }
  box.innerHTML = val(html`<div class="callout warn stack tight"><strong>Possível cliente já cadastrado</strong>
    ${dups.map((d) => html`<div class="row between wrap"><span>${d.name} · ${[d.phone, d.email].filter(Boolean).join(' · ')} <span class="muted">(${d.reasons.join(', ')})</span></span>
      <span class="btn-group"><a class="btn sm" href="#/clientes/${d.id}" data-act="go-close" data-href="#/clientes/${d.id}">Abrir ficha</a><button type="button" class="btn sm" data-act="lead-existing" data-id="${d.id}">Nova oportunidade para este cliente</button></span></div>`)}
    <label class="check"><input type="checkbox" name="confirm_new"> Não é a mesma pessoa: cadastrar como novo cliente</label></div>`);
}
ACT['lead-existing'] = (el) => {
  const form = el.closest('form'); const d = formData(form);
  safe(run(async () => {
    const r = await POST('/api/leads', { client_id: Number(el.dataset.id), service_interest: d.service_interest, source: d.source, estimated_value: parseMoney(d.estimated_value) || undefined, owner_id: d.owner_id || undefined });
    closeModal(); go(`#/clientes/${r.client_id}`);
  }, { form, ok: 'Oportunidade criada para o cliente existente.' }));
};
FORMS.lead = async (form, d) => {
  if (!d.name.trim()) return showFormError(form, 'Informe o nome do contato.');
  if (!d.phone.trim() && !d.email.trim()) return showFormError(form, 'Informe pelo menos um telefone ou e-mail.');
  const est = parseMoney(d.estimated_value);
  if (Number.isNaN(est)) return showFormError(form, 'Valor estimado inválido.');
  const body = { name: d.name, phone: d.phone, email: d.email, source: d.source, service_interest: d.service_interest, notes: d.notes, owner_id: d.owner_id || undefined, estimated_value: est || undefined, ignore_duplicates: !!d.confirm_new };
  if (d.line1) body.address = { line1: d.line1, city: d.city, state: d.state, zip: d.zip };
  try {
    const r = await run(() => POST('/api/leads', body), { form });
    closeModal(); toast('Contato cadastrado. Confirmação de pedido recebido enviada (simulação).'); go(`#/clientes/${r.client_id}`);
  } catch (e) { if (e.status === 409 && e.data.duplicates) renderDups(form, e.data.duplicates); }
};

// ---------- Ficha do cliente ----------
function channelRow(c, key) {
  const ch = c.channels[key] || {};
  const status = ch.optout_at ? html`<span class="badge danger">descadastrado em ${fmtDate(localDateOf(ch.optout_at))}</span>` : ch.allowed ? html`<span class="badge ok">autorizado</span>` : html`<span class="badge">não autorizado</span>`;
  return html`<div style="padding:10px 0;border-bottom:1px solid var(--border)" class="stack tight">
    <div class="row between"><span class="title" style="font-weight:600">${CH[key]}</span>${status}</div><div class="meta small muted">${ch.optout_at ? `Origem: ${ch.optout_source || '-'}` : ch.consent_at ? `Autorizado em ${fmtDate(localDateOf(ch.consent_at))} · ${ch.source || ''}` : key === 'whatsapp' ? 'Exige autorização explícita do cliente' : 'Sem autorização'}</div>
    <div>
      ${ch.allowed ? html`<button class="btn sm" data-act="channel" data-ch="${key}" data-mode="optout" data-id="${c.id}">Registrar descadastro</button>`
    : html`<button class="btn sm" data-act="channel" data-ch="${key}" data-mode="allow" data-id="${c.id}">${ch.optout_at ? 'Reautorizar' : 'Autorizar'}</button>`}</div></div>`;
}

function historyItem(h) {
  const tone = /aprovad|pago|Quitada|concluído|recebid|Pagamento/i.test(h.action) ? 'ok' : /cancel|recusad|Reclama|descadastro|perdid/i.test(h.action) ? 'danger' : /Agendado|Reagendado|enviado/i.test(h.action) ? 'info' : '';
  return html`<div class="tl-item ${tone}"><span class="tl-dot"></span><div><div>${h.action}${h.details ? html` <span class="muted">· ${h.details}</span>` : ''}</div><div class="small muted">${fmtDT(h.created_at)} · ${h.user || 'Sistema'}</div></div></div>`;
}
window.historyItem = historyItem;

function messageItem(m) {
  const who = m.direction === 'in' ? 'Recebida do cliente' : m.direction === 'note' ? 'Registro manual' : m.journey_name ? `Jornada: ${m.journey_name}` : m.kind === 'quote' ? 'Envio de orçamento' : 'Enviada';
  return html`<div class="msg ${m.direction}"><div class="row between wrap"><span class="small"><strong>${CH[m.channel] || m.channel}</strong> · ${who}</span>
    <span class="row">${m.simulated ? html`<span class="badge demo">simulação</span>` : ''}<span class="small muted">${fmtDT(m.created_at)}</span></span></div>
    ${m.subject ? html`<div style="font-weight:600;margin-top:4px">${m.subject}</div>` : ''}<pre>${m.body}</pre></div>`;
}

let clientTab = 'timeline';
async function viewClient({ params, query }) {
  const c = await GET(`/api/clients/${params.id}`);
  if (query.tab) clientTab = query.tab;
  const p = S.me.perms;
  const activeEnr = c.enrollments;
  const tabs = [
    ['timeline', 'Histórico', c.history.length], ['quotes', 'Orçamentos', c.quotes.length], ['jobs', 'Serviços', c.jobs.length],
    p.finance && ['money', 'Cobranças', c.invoices.length], ['messages', 'Mensagens', c.messages.length], ['tasks', 'Tarefas', c.tasks.filter((x) => ['open', 'in_progress'].includes(x.status)).length], ['auto', 'Automações', activeEnr.length],
  ].filter(Boolean);
  if (!tabs.find((x) => x[0] === clientTab)) clientTab = 'timeline';
  const tabBody = {
    timeline: () => (c.history.length ? html`<div class="timeline">${c.history.map(historyItem)}</div>` : empty('Sem histórico')),
    quotes: () => (c.quotes.length ? html`<div class="list">${c.quotes.map((q) => html`<a class="list-item" href="#/orcamentos/${q.id}"><div class="grow"><div class="title">${q.number} · ${q.title}</div><div class="meta">${FREQ[q.frequency]} · criado ${fmtDate(q.created_at.slice(0, 10))}${q.sent_at ? ` · enviado ${fmtDate(localDateOf(q.sent_at))}` : ''}</div></div><div class="side stack tight" style="align-items:flex-end"><span class="num">${money(q.total)}</span>${badge(QUOTE_STATUS, q.status)}</div></a>`)}</div>` : empty('Nenhum orçamento', '', p.sales ? html`<a class="btn" href="#/orcamentos/novo?cliente=${c.id}">Criar orçamento</a>` : '')),
    jobs: () => (c.jobs.length ? html`<div class="list">${c.jobs.map((j) => html`<a class="list-item" href="#/servicos/${j.id}"><div class="grow"><div class="title">${j.title}${j.series_id ? html` <span class="badge primary">recorrente</span>` : ''}</div><div class="meta">${j.start_at ? `${fmtDate(localDateOf(j.start_at))} ${fmtTime(j.start_at)}` : 'sem data'} · ${j.crew || 'sem equipe'}</div></div><div class="side stack tight" style="align-items:flex-end">${j.price != null ? html`<span class="num">${money(j.price)}</span>` : ''}${badge(JOB_STATUS, j.status)}</div></a>`)}</div>` : empty('Nenhum serviço')),
    money: () => html`${c.invoices.length ? html`<div class="list">${c.invoices.map((i) => html`<a class="list-item" href="#/cobrancas/${i.id}"><div class="grow"><div class="title">${i.number} · ${i.description || ''}</div><div class="meta">Emitida ${fmtDate(i.issued_date)} · vence ${fmtDate(i.due_date)} · saldo ${money(i.balance)}</div></div><div class="side stack tight" style="align-items:flex-end"><span class="num">${money(i.amount)}</span>${badge(INV_STATUS, i.status === 'void' ? 'void' : i.balance <= 0 ? 'paid' : i.due_date < todayStr() ? 'overdue' : i.status)}</div></a>`)}</div>` : empty('Nenhuma cobrança')}
      ${c.payments.length ? html`<div class="section-title mt-lg" style="padding:0 16px">Pagamentos</div><div class="list">${c.payments.map((x) => html`<div class="list-item"><div class="grow"><div class="title">${money(x.amount)} · ${x.number}</div><div class="meta">${fmtDate(x.paid_date)} · ${S.meta.methods[x.method]} · registrado manualmente</div></div></div>`)}</div>` : ''}`,
    messages: () => html`<div class="card-body stack">${c.messages.length ? c.messages.map(messageItem) : empty('Nenhuma mensagem')}</div>`,
    tasks: () => (c.tasks.length ? html`<div class="list">${c.tasks.map((x) => R.task({ ...x, client_name: null }))}</div>` : empty('Nenhuma tarefa')),
    auto: () => html`<div class="card-body stack">
      ${c.automation_paused ? html`<div class="callout warn"><strong>Atendimento assumido por ${c.automation_paused_by_name || 'uma pessoa'}</strong> em ${fmtDT(c.automation_paused_at)}. Nenhuma automação será enviada até a retomada.</div>` : ''}
      ${activeEnr.length ? activeEnr.map((e) => html`<div class="row between wrap" style="border-bottom:1px solid var(--border);padding-bottom:10px">
        <div><a href="#/jornadas/${e.journey_id}" style="font-weight:600">${e.journey_name}</a> ${badge(CAT, e.category)}
          <div class="small muted">${e.status === 'paused' ? `Pausada: ${S.meta.automation.pause_labels[e.pause_reason] || e.pause_reason}` : e.next_send_at ? `Próxima etapa ${fmtDT(e.next_send_at)}` : 'Sem etapas pendentes'}</div></div>
        <div class="btn-group">${e.status === 'active' ? html`<button class="btn sm" data-act="enr" data-op="pause" data-id="${e.id}">Pausar</button>` : html`<button class="btn sm" data-act="enr" data-op="resume" data-id="${e.id}">Retomar</button>`}<button class="btn sm danger" data-act="enr" data-op="stop" data-id="${e.id}">Encerrar</button></div></div>`) : empty('Nenhuma sequência ativa para este cliente')}</div>`,
  };
  return {
    title: c.name,
    html: html`
      <div class="crumbs"><a href="#/clientes">Clientes</a> / ${c.name}</div>
      <div class="page-head"><div><h1>${c.name}</h1><div class="sub">${c.source ? `Origem: ${c.source} · ` : ''}cliente desde ${fmtDate(localDateOf(c.created_at))}</div>
        <div class="row wrap mt">${c.has_open_complaint ? html`<span class="badge danger">Reclamação em aberto: ofertas pausadas</span>` : ''}${c.automation_paused ? html`<span class="badge warn">Automações pausadas</span>` : ''}</div></div>
        <div class="btn-group">
          ${p.sales ? html`<a class="btn primary" href="#/orcamentos/novo?cliente=${c.id}">Novo orçamento</a>` : ''}
          <button class="btn" data-act="client-note" data-id="${c.id}">Registrar contato</button>
          <button class="btn" data-act="takeover" data-id="${c.id}" data-paused="${c.automation_paused ? '0' : '1'}">${c.automation_paused ? 'Retomar automações' : 'Assumir atendimento'}</button>
        </div></div>
      <div class="grid grid-side">
        <div class="stack" style="min-width:0">
          <div class="card card-pad stack" style="border-left:4px solid var(--primary)">
            <div class="row between"><div class="section-title" style="margin:0">Próxima ação</div><button class="btn ghost sm" data-act="edit-next" data-id="${c.id}" data-text="${c.next_action || ''}" data-due="${c.next_action_due || ''}" data-owner="${c.next_action_owner_id || ''}">Alterar</button></div>
            ${c.next_action ? html`<div class="row between wrap"><div style="font-weight:620;font-size:16px">${c.next_action}</div>${dueBadge(c.next_action_due)}</div><div class="small muted">Responsável: ${c.next_action_owner || 'não definido'}</div>` : html`<div class="muted">Nenhuma próxima ação definida.</div>`}
          </div>
          <div class="card"><div class="tabs" style="padding:0 8px;margin:0">${tabs.map(([k, l, n]) => html`<button class="tab ${clientTab === k ? 'active' : ''}" data-act="client-tab" data-tab="${k}">${l}<span class="count">${n}</span></button>`)}</div>
            <div id="client-tab-body">${tabBody[clientTab]()}</div></div>
        </div>
        <div class="stack">
          <div class="card card-pad stack"><div class="row between"><div class="section-title" style="margin:0">Contato</div><button class="btn ghost sm" data-act="edit-client" data-id="${c.id}">Editar</button></div>
            <dl class="kv"><dt>Telefone</dt><dd>${c.phone ? html`<a href="tel:${c.phone}">${c.phone}</a>` : '-'}</dd><dt>E-mail</dt><dd>${c.email ? html`<a href="mailto:${c.email}">${c.email}</a>` : '-'}</dd>
            <dt>Preferências</dt><dd>${c.preferences || '-'}</dd><dt>Observações</dt><dd>${c.notes || '-'}</dd></dl></div>
          <div class="card card-pad"><div class="row between"><div class="section-title" style="margin:0">Endereços de atendimento</div><button class="btn ghost sm" data-act="add-address" data-id="${c.id}">Adicionar</button></div>
            ${c.addresses.length ? c.addresses.map((a) => html`<div style="padding:8px 0;border-bottom:1px solid var(--border)"><div style="font-weight:600">${a.label}</div><div>${a.line1}${a.line2 ? `, ${a.line2}` : ''}</div><div class="small muted">${[a.city, a.state, a.zip].filter(Boolean).join(', ')}</div>${a.access_notes ? html`<div class="small">Acesso: ${a.access_notes}</div>` : ''}</div>`) : html`<div class="muted small mt">Nenhum endereço cadastrado.</div>`}</div>
          <div class="card card-pad"><div class="section-title">Canais autorizados</div><div class="list">${['email', 'sms', 'whatsapp'].map((k) => channelRow(c, k))}</div></div>
          <div class="card card-pad stack"><div class="section-title" style="margin:0">Ações</div>
            <button class="btn block" data-act="new-task" data-client="${c.id}">Nova tarefa para este cliente</button>
            <button class="btn block danger" data-act="complaint" data-id="${c.id}">Registrar reclamação</button>
            <button class="btn block" data-act="simulate-inbound" data-id="${c.id}">Simular resposta do cliente <span class="badge demo">demo</span></button></div>
        </div>
      </div>`,
    after(el) {
      el.querySelectorAll('[data-act=client-tab]').forEach((b) => b.addEventListener('click', () => {
        clientTab = b.dataset.tab;
        el.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
        el.querySelector('#client-tab-body').innerHTML = val(tabBody[clientTab]());
      }));
    },
  };
}
ACT['client-tab'] = () => {};

ACT['edit-client'] = async (el) => {
  const c = await GET(`/api/clients/${el.dataset.id}`);
  modal({ title: 'Editar cliente', body: html`<form class="form" data-form="edit-client" data-id="${c.id}" novalidate>
    <div class="field"><label class="req">Nome</label><input name="name" type="text" value="${c.name}"></div>
    <div class="form-row"><div class="field"><label>Telefone</label><input name="phone" type="tel" value="${c.phone || ''}"></div><div class="field"><label>E-mail</label><input name="email" type="email" value="${c.email || ''}"></div></div>
    <div class="field"><label>Origem</label><select name="source">${opts(S.meta.sources.map((s) => [s, s]), c.source, { blank: 'Não informada' })}</select></div>
    <div class="field"><label>Preferências</label><textarea name="preferences" placeholder="Ex.: produtos sem perfume, visitas pela manhã">${c.preferences || ''}</textarea></div>
    <div class="field"><label>Observações</label><textarea name="notes">${c.notes || ''}</textarea></div>
    <div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" type="submit">Salvar</button></div></form>` });
};
FORMS['edit-client'] = async (form, d) => { await run(() => PATCH(`/api/clients/${form.dataset.id}`, d), { form, ok: 'Cadastro atualizado.' }); closeModal(); refresh(); };

ACT['edit-next'] = (el) => {
  modal({ title: 'Próxima ação', body: html`<form class="form" data-form="next-action" data-id="${el.dataset.id}" novalidate>
    <div class="field"><label class="req">O que precisa ser feito</label><input name="next_action" type="text" value="${el.dataset.text}" placeholder="Ex.: Ligar para confirmar a data"></div>
    <div class="form-row"><div class="field"><label class="req">Prazo</label><input name="next_action_due" type="date" value="${el.dataset.due || todayStr()}"></div>
    <div class="field"><label class="req">Responsável</label><select name="next_action_owner_id">${staffOpts(el.dataset.owner || S.me.user.id)}</select></div></div>
    <div class="form-actions"><button type="button" class="btn" data-act="clear-next" data-id="${el.dataset.id}">Remover próxima ação</button><button class="btn primary" type="submit">Salvar</button></div></form>` });
};
FORMS['next-action'] = async (form, d) => { if (!d.next_action.trim()) return showFormError(form, 'Descreva a próxima ação.'); await run(() => PATCH(`/api/clients/${form.dataset.id}`, d), { form, ok: 'Próxima ação atualizada.' }); closeModal(); refresh(); };
ACT['clear-next'] = (el) => safe(run(async () => { await PATCH(`/api/clients/${el.dataset.id}`, { next_action: '', next_action_due: '', next_action_owner_id: '' }); closeModal(); refresh(); }));

ACT['add-address'] = (el) => {
  modal({ title: 'Novo endereço de atendimento', body: html`<form class="form" data-form="address" data-id="${el.dataset.id}" novalidate>
    <div class="field"><label>Nome do endereço</label><input name="label" type="text" placeholder="Ex.: Casa de praia"></div>
    <div class="field"><label class="req">Endereço</label><input name="line1" type="text"></div>
    <div class="field"><label>Complemento</label><input name="line2" type="text" placeholder="Apt, Suite"></div>
    <div class="form-row three"><div class="field"><label>Cidade</label><input name="city" type="text"></div><div class="field"><label>Estado</label><input name="state" type="text" maxlength="2"></div><div class="field"><label>ZIP</label><input name="zip" type="text" inputmode="numeric"></div></div>
    <div class="field"><label>Instruções de acesso</label><textarea name="access_notes" placeholder="Código do portão, onde fica a chave, animais"></textarea></div>
    <div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" type="submit">Adicionar</button></div></form>` });
};
FORMS.address = async (form, d) => { await run(() => POST(`/api/clients/${form.dataset.id}/addresses`, d), { form, ok: 'Endereço adicionado.' }); closeModal(); refresh(); };

ACT.channel = (el) => {
  const optout = el.dataset.mode === 'optout';
  if (optout && !confirm(`Registrar descadastro de ${CH[el.dataset.ch]}? Os envios automáticos por este canal serão bloqueados.`)) return;
  safe(run(async () => { await POST(`/api/clients/${el.dataset.id}/channels`, { channel: el.dataset.ch, allowed: !optout, optout }); refresh(); }, { ok: optout ? 'Descadastro registrado. Envios deste canal bloqueados.' : 'Canal autorizado.' }));
};
ACT.takeover = (el) => {
  const paused = el.dataset.paused === '1';
  safe(run(async () => { await POST(`/api/clients/${el.dataset.id}/takeover`, { paused }); refresh(); }, { btn: el, ok: paused ? 'Você assumiu o atendimento. Automações deste cliente pausadas.' : 'Automações retomadas.' }));
};
ACT.enr = (el) => {
  if (el.dataset.op === 'stop' && !confirm('Encerrar esta sequência? As etapas pendentes não serão enviadas.')) return;
  safe(run(async () => { await POST(`/api/enrollments/${el.dataset.id}/${el.dataset.op}`); refresh(); }, { btn: el, ok: 'Sequência atualizada.' }));
};

ACT['client-note'] = (el) => {
  modal({ title: 'Registrar contato com o cliente', body: html`<form class="form" data-form="note" data-id="${el.dataset.id}" novalidate>
    <div class="field"><label>Canal</label><select name="channel">${opts([['phone', 'Telefone'], ['sms', 'SMS'], ['email', 'E-mail'], ['whatsapp', 'WhatsApp'], ['internal', 'Presencial / interno']], 'phone')}</select></div>
    <div class="field"><label class="req">Resumo</label><textarea name="text" placeholder="O que foi conversado e combinado"></textarea></div>
    <p class="small muted">Registro interno do que já aconteceu. Não envia mensagem ao cliente.</p>
    <div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" type="submit">Registrar</button></div></form>` });
};
FORMS.note = async (form, d) => { await run(() => POST(`/api/clients/${form.dataset.id}/notes`, d), { form, ok: 'Contato registrado no histórico.' }); closeModal(); clientTab = 'messages'; refresh(); };

ACT.complaint = (el) => {
  modal({ title: 'Registrar reclamação', body: html`<form class="form" data-form="complaint" data-id="${el.dataset.id}" novalidate>
    <div class="callout warn">Ao registrar, o sistema abre uma tarefa de alta prioridade para o dono e pausa as ofertas comerciais deste cliente até a resolução.</div>
    <div class="field"><label class="req">O que aconteceu</label><textarea name="text"></textarea></div>
    <div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" type="submit">Registrar reclamação</button></div></form>` });
};
FORMS.complaint = async (form, d) => { await run(() => POST(`/api/clients/${form.dataset.id}/complaints`, d), { form, ok: 'Reclamação registrada. Tarefa criada e ofertas pausadas.' }); closeModal(); refresh(); };

ACT['simulate-inbound'] = (el) => {
  modal({ title: 'Simular resposta do cliente', body: html`<form class="form" data-form="inbound" data-id="${el.dataset.id}" novalidate>
    ${demoNote('Simula uma mensagem recebida para testar as regras das jornadas. Nenhum canal real está conectado.')}
    <div class="field"><label>Tipo de resposta</label><div class="radio-cards">
      ${[['reply', 'Resposta comum', 'Pausa sequências comerciais e cria tarefa'], ['complaint', 'Reclamação', 'Abre tarefa e pausa ofertas'], ['optout', 'Descadastro (STOP)', 'Bloqueia o canal'], ['rating', 'Nota da pesquisa', 'Nota até 3 vira reclamação']].map(([v, l, h], i) => html`<label class="radio-card"><input type="radio" name="kind" value="${v}" ${i === 0 ? 'checked' : ''}><span><strong>${l}</strong><br><span class="small muted">${h}</span></span></label>`)}
    </div></div>
    <div class="form-row"><div class="field"><label>Canal</label><select name="channel">${opts([['sms', 'SMS'], ['email', 'E-mail'], ['whatsapp', 'WhatsApp']], 'sms')}</select></div>
      <div class="field"><label>Nota (1 a 5)</label><select name="rating">${opts([1, 2, 3, 4, 5].map((n) => [n, String(n)]), 5)}</select></div></div>
    <div class="field"><label>Texto</label><textarea name="text" placeholder="Ex.: Can we move it to Saturday?"></textarea></div>
    <div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" type="submit">Simular recebimento</button></div></form>` });
};
FORMS.inbound = async (form, d) => {
  if (d.kind === 'reply' && !d.text.trim()) return showFormError(form, 'Escreva o texto da resposta.');
  if (d.kind === 'complaint' && !d.text.trim()) return showFormError(form, 'Descreva a reclamação.');
  await run(() => POST(`/api/clients/${form.dataset.id}/simulate-inbound`, d), { form, ok: 'Resposta simulada registrada e regras aplicadas.' });
  closeModal(); clientTab = d.kind === 'optout' ? 'messages' : 'timeline'; refresh();
};

// ---------- Funil comercial ----------
async function viewPipeline({ query }) {
  const opps = await GET('/api/opportunities');
  const showLost = query.perdidos === '1';
  const cols = ['new', 'contacted', 'quote_sent', 'approved', 'lost'];
  const recent = (o) => o.stage !== 'approved' || (Date.now() - Date.parse(o.updated_at)) < 30 * 86400000;
  const by = Object.fromEntries(cols.map((s) => [s, opps.filter((o) => o.stage === s && recent(o))]));
  const card = (o) => html`<div class="kcard">
    <div class="row between top"><a class="client" href="#/clientes/${o.client_id}">${o.client_name}</a><span class="num" style="font-weight:600">${o.estimated_value ? money(o.estimated_value) : html`<span class="muted small">sem valor</span>`}</span></div>
    <div class="small muted">${o.title}${o.source ? ` · ${o.source}` : ''}</div>
    ${o.stage === 'lost' ? html`<div class="small">Motivo: ${o.lost_reason || '-'}</div>` : o.next_action ? html`<div class="small"><strong>Próxima:</strong> ${o.next_action}</div><div class="row between">${dueBadge(o.next_action_due)}<span class="small muted">${o.owner || ''}</span></div>` : html`<div class="small muted">${o.owner || ''}</div>`}
    <div class="row wrap">
      ${o.quote_id ? html`<a class="btn sm" href="#/orcamentos/${o.quote_id}">${o.quote_number}</a>` : ['new', 'contacted'].includes(o.stage) ? html`<a class="btn sm primary" href="#/orcamentos/novo?cliente=${o.client_id}&op=${o.id}">Criar orçamento</a>` : ''}
    </div>
    <div class="row">
      ${['new', 'contacted', 'quote_sent', 'lost'].includes(o.stage) ? html`<select class="grow" data-act-change="move-opp" data-id="${o.id}" aria-label="Mover etapa">
        <option value="">Mover para...</option>${['new', 'contacted', 'lost'].filter((s) => s !== o.stage).map((s) => html`<option value="${s}">${STAGES[s]}</option>`)}</select>` : ''}
    </div></div>`;
  const total = (s) => by[s].reduce((a, o) => a + o.estimated_value, 0);
  return {
    title: 'Comercial',
    html: html`<div class="page-head"><div><h1>Funil comercial</h1><div class="sub">Do primeiro contato à aprovação. Aprovados dos últimos 30 dias.</div></div>
      <div class="btn-group"><a class="btn" href="#/orcamentos">Lista de orçamentos</a><button class="btn primary" data-act="new-lead">${icon('plus')} Novo contato</button></div></div>
      <div class="kanban">${cols.filter((s) => s !== 'lost' || showLost || true).map((s) => html`<section class="kcol" aria-label="${STAGES[s]}">
        <div class="kcol-head"><span class="name">${STAGES[s]} <span class="muted">(${by[s].length})</span></span><span class="sum num">${money(total(s))}</span></div>
        ${by[s].length ? by[s].map(card) : html`<div class="small muted" style="padding:8px">Nenhuma oportunidade.</div>`}</section>`)}</div>`,
    after(el) {
      el.querySelectorAll('[data-act-change=move-opp]').forEach((sel) => sel.addEventListener('change', () => {
        const stage = sel.value; if (!stage) return;
        if (stage === 'lost') {
          modal({ title: 'Marcar como perdida', body: html`<form class="form" data-form="lost" data-id="${sel.dataset.id}" novalidate><div class="field"><label class="req">Motivo da perda</label><select name="lost_reason">${opts(['Preço acima do esperado', 'Fechou com concorrente', 'Sem resposta', 'Fora da área de atendimento', 'Desistiu do serviço', 'Outro'].map((x) => [x, x]), '')}</select></div><p class="small muted">Os follow-ups dos orçamentos desta oportunidade serão encerrados.</p><div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" type="submit">Confirmar</button></div></form>` });
          sel.value = ''; return;
        }
        safe(run(async () => { await PATCH(`/api/opportunities/${sel.dataset.id}`, { stage }); refresh(); }, { ok: `Movido para ${STAGES[stage]}.` }).catch(() => { sel.value = ''; }));
      }));
    },
  };
}
FORMS.lost = async (form, d) => { await run(() => PATCH(`/api/opportunities/${form.dataset.id}`, { stage: 'lost', lost_reason: d.lost_reason }), { form, ok: 'Oportunidade marcada como perdida.' }); closeModal(); refresh(); };

routeDef('/clientes', viewClients, { perm: ['clients'] });
routeDef('/clientes/:id', viewClient, { perm: ['clients'] });
routeDef('/comercial', viewPipeline, { perm: ['sales'] });
void raw; void esc; void TZ; void TASK_STATUS; void TASK_TYPE; void fmtTime;
