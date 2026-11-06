// Login, estrutura de navegação e inicialização.
/* global S, ACT, FORMS, html, val, esc, icon, t, GET, POST, go, render, run, safe, modal, closeModal, ROLE, toast, ROUTES */

function navItems() {
  const p = S.me.perms;
  if (S.me.user.role === 'field') {
    return [['#/hoje', 'Hoje', 'home'], ['#/agenda', 'Agenda', 'calendar'], ['#/tarefas', 'Tarefas', 'check']];
  }
  return [
    ['#/hoje', 'Hoje', 'home', true],
    p.clients && ['#/clientes', 'Clientes', 'users', true],
    p.sales && ['#/comercial', 'Comercial', 'funnel', true],
    p.schedule && ['#/agenda', 'Agenda', 'calendar', true],
    p.finance && ['#/financeiro', 'Financeiro', 'dollar'],
    p.journeys && ['#/jornadas', 'Jornadas', 'zap'],
    p.tasks && ['#/tarefas', 'Tarefas', 'check'],
    p.settings && ['#/config', 'Configurações', 'settings'],
  ].filter(Boolean);
}

function isActive(href) {
  const cur = '#' + (location.hash.slice(1).split('?')[0] || '/hoje');
  const base = href.split('?')[0];
  const alias = { '#/orcamentos': '#/comercial', '#/servicos': '#/agenda', '#/cobrancas': '#/financeiro' };
  const curRoot = '#/' + cur.slice(2).split('/')[0];
  return cur === base || curRoot === base || alias[curRoot] === base;
}

let shellKey = null;
window.renderShell = function renderShell() {
  const items = navItems();
  const key = S.me.user.id + ':' + S.me.company.id;
  const root = document.getElementById('root');
  if (shellKey !== key || !document.getElementById('main')) {
    shellKey = key;
    const field = S.me.user.role === 'field';
    const mobileMain = field ? items : items.filter((i) => i[3]).slice(0, 4);
    root.innerHTML = val(html`
      ${S.me.company.demo ? html`<div class="demo-bar"><strong>Modo demonstração:</strong> mensagens e cobranças são simuladas. Nada é enviado ou cobrado de verdade.</div>` : ''}
      <div class="app">
        <nav class="sidebar" aria-label="Navegação principal">
          <div class="brand"><div class="brand-mark">F</div><div><div class="brand-name">Fluxo</div><div class="brand-company">${S.me.company.name}</div></div></div>
          ${!field ? html`<button class="btn primary block" data-act="new-menu" style="margin-bottom:10px">${icon('plus')} Novo</button>` : ''}
          <div id="nav-items">${items.map(([href, label, ic]) => html`<a class="nav-item" href="${href}" data-nav="${href}">${icon(ic)}<span>${t(label)}</span></a>`)}</div>
          <div class="spacer"></div>
          <div class="user-box">
            <div style="font-weight:600">${S.me.user.name}</div>
            <div class="muted">${ROLE[S.me.user.role]}</div>
            <div class="muted small">Fuso: ${S.me.company.timezone}</div>
            <button class="btn ghost sm" data-act="logout" style="padding-left:0;margin-top:6px">${t('Sair')}</button>
          </div>
        </nav>
        <main class="main" id="main"></main>
      </div>
      <nav class="bottom-nav" aria-label="Navegação">
        ${mobileMain.map(([href, label, ic]) => html`<a href="${href}" data-nav="${href}">${icon(ic)}<span>${t(label)}</span></a>`)}
        ${field ? html`<button data-act="logout">${icon('x')}<span>${t('Sair')}</span></button>` : html`<button data-act="more-menu">${icon('more')}<span>${t('Mais')}</span></button>`}
      </nav>`);
  }
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', isActive(a.dataset.nav)));
};

ACT.logout = () => safe(run(async () => { await POST('/api/logout'); S.me = null; shellKey = null; go('#/entrar'); }));

ACT['more-menu'] = () => {
  const items = navItems();
  modal({ title: 'Menu', body: html`<div class="stack">
    ${S.me.user.role !== 'field' ? html`<button class="btn primary block" data-act="new-menu">${icon('plus')} Novo</button>` : ''}
    <div class="card"><div class="list">${items.map(([href, label, ic]) => html`<a class="list-item" href="${href}" data-act="go-close" data-href="${href}">${icon(ic)} <span class="title">${t(label)}</span></a>`)}</div></div>
    <div class="small muted">${S.me.user.name} · ${ROLE[S.me.user.role]} · ${S.me.company.name}</div>
    <button class="btn block" data-act="logout">${t('Sair')}</button></div>` });
};
ACT['go-close'] = (el) => { closeModal(); go(el.dataset.href); };

// Menu "Novo": as entradas mais frequentes do dia a dia.
ACT['new-menu'] = () => {
  const p = S.me.perms;
  const entries = [
    (p.sales || p.clients) && ['new-lead', 'Novo contato', 'Cadastra cliente e oportunidade de uma vez'],
    p.sales && ['go-new-quote', 'Novo orçamento', 'Para um cliente já cadastrado'],
    p.tasks && ['new-task', 'Nova tarefa', 'Com responsável e prazo'],
    p.finance && ['new-expense', 'Registrar despesa', 'Geral ou ligada a um serviço'],
    p.finance && ['new-income', 'Registrar receita manual', 'Valor recebido fora das cobranças'],
    p.schedule && ['new-job', 'Serviço sem orçamento', 'Para combinados feitos por telefone'],
  ].filter(Boolean);
  modal({ title: 'O que você quer registrar?', body: html`<div class="card"><div class="list">${entries.map(([act, label, hint]) => html`
    <button class="list-item clickable" style="border:0;border-bottom:1px solid var(--border);background:none;font:inherit;text-align:left;width:100%" data-act="${act}">
      <div class="grow"><div class="title">${label}</div><div class="meta">${hint}</div></div>${icon('chevR')}</button>`)}</div></div>` });
};
ACT['go-new-quote'] = () => { closeModal(); go('#/orcamentos/novo'); };

// ---------- Login ----------
window.renderLogin = async function renderLogin() {
  shellKey = null;
  const root = document.getElementById('root');
  let demo = [];
  try { demo = await GET('/api/demo-users'); } catch { /* sem demonstração */ }
  const groups = {};
  for (const u of demo) (groups[u.company] = groups[u.company] || []).push(u);
  root.innerHTML = val(html`<div class="login-wrap"><div class="login-card stack">
    <div class="brand" style="justify-content:center;padding-bottom:0"><div class="brand-mark">F</div><div class="brand-name" style="font-size:20px">Fluxo</div></div>
    <p class="muted" style="text-align:center">Gestão para empresas de serviços: do primeiro contato ao pagamento.</p>
    <form class="card card-pad form" data-form="login" novalidate>
      <div class="field"><label for="l-email">E-mail</label><input id="l-email" name="email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="l-pw">Senha</label><input id="l-pw" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn primary lg block" type="submit">Entrar</button>
    </form>
    ${demo.length ? html`<div class="card card-pad stack">
      <div><h3>Acessos de demonstração</h3><p class="small muted">Senha de todos: demo123. Dados inteiramente fictícios.</p></div>
      ${Object.entries(groups).map(([company, us]) => html`<div class="stack tight"><div class="section-title" style="margin:6px 0 0">${company}</div>
        <div class="demo-users">${us.map((u) => html`<button class="demo-user" data-act="demo-login" data-email="${u.email}"><span><strong>${u.name}</strong><br><span class="small muted">${u.email}</span></span><span class="badge">${ROLE[u.role]}</span></button>`)}</div></div>`)}
    </div>` : ''}
  </div></div>`);
};
async function doLogin(email, password, form) {
  await run(async () => {
    await POST('/api/login', { email, password });
    S.me = null;
    await window.loadSessionPublic();
    go('#/hoje');
  }, { form });
}
FORMS.login = (form, d) => {
  if (!d.email || !d.password) return showFormErrorLocal(form, 'Informe e-mail e senha.');
  return doLogin(d.email, d.password, form);
};
function showFormErrorLocal(form, msg) { const b = document.createElement('div'); b.className = 'form-error'; b.textContent = msg; form.querySelector('.form-error')?.remove(); form.prepend(b); }
ACT['demo-login'] = (el) => safe(doLogin(el.dataset.email, 'demo123', document.querySelector('form[data-form=login]')));
window.loadSessionPublic = async () => { await loadSession(); }; // eslint-disable-line no-undef

window.addEventListener('hashchange', render);
render();
