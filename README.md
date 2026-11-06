# Fluxo v1: gestão para pequenas empresas de serviços (EUA)

Princípio: a informação entra uma vez e acompanha o trabalho até o dinheiro entrar.
Novo contato → orçamento → aprovação → agendamento → execução → cobrança → pagamento → pós-serviço → próxima contratação.

## Como rodar

Requer Node.js 22.5 ou superior. Não tem dependências externas (usa o SQLite nativo do Node).

```bash
npm start
```

Abra http://localhost:3000. Na primeira execução o banco (`data/fluxo.db`) é criado com dados de demonstração.
Senha de todos os acessos de demonstração: `demo123`.

| Acesso | Perfil |
|---|---|
| ana@brightway.demo | Dono / administrador |
| julia@brightway.demo | Assistente / VA (sem financeiro por padrão) |
| carla@brightway.demo, rosa@brightway.demo, bianca@brightway.demo | Equipe de campo |
| diego@sparklebay.demo | Dono de outra empresa (para validar o isolamento) |

Recarregar os dados de demonstração: `npm run seed` ou Configurações › Restaurar dados de demonstração.
Teste automatizado de ponta a ponta (sobe um servidor com banco temporário): `npm test`.

## Estrutura

- `server/db.js`: esquema e acesso a dados. Toda tabela tem `company_id`; leituras e escritas por id passam por funções que filtram pela empresa da sessão.
- `server/engine.js`: eventos, regras obrigatórias e jornadas (fila de mensagens com deduplicação).
- `server/svc-crm.js`, `svc-ops.js`, `svc-fin.js`: clientes/comercial, agenda/execução, financeiro/visão do dia.
- `server/server.js`: API, sessões e permissões por rota.
- `server/integrations.js`: pontos de integração (e-mail, SMS, WhatsApp, pagamentos), hoje em modo de demonstração.
- `public/`: interface (JavaScript puro, sem build). `public/i18n/` prepara inglês e espanhol.

## Variáveis

`PORT` (padrão 3000), `DB_FILE` (padrão `data/fluxo.db`), `PUBLIC_URL` (base dos links enviados ao cliente).

## Gestão de time (aba "Time", somente o dono)

Acompanhamento mensal pelo método MAGIC (Significado, Autonomia, Crescimento, Impacto, Conexão), com a nota do dono e, opcionalmente, a visão do colaborador; perfil de cada pessoa; PDI com metas, prazos e status; indicadores calculados da operação (horas, checklist, notas e reclamações de clientes, tarefas no prazo, orçamentos aprovados); regras de premiação com aprovação do dono, e premiações pagas lançadas como despesa no Financeiro; relatórios mensais por pessoa e do time, prontos para imprimir ou salvar em PDF.

Para trocar de método, edite apenas `server/team-method.js`.
