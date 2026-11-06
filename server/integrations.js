// Pontos de integração externos. Nesta versão TODOS operam em modo de demonstração:
// nenhuma mensagem real é enviada e nenhuma cobrança real é processada.
// Para conectar um provedor real, implemente `send`/`createPaymentLink` com a mesma
// assinatura e altere `mode` para 'live'. O restante do sistema não precisa mudar.

const providers = {
  email: { label: 'E-mail', mode: 'demo', suggested: 'SendGrid, Postmark ou Amazon SES', status: 'Não conectado' },
  sms: { label: 'SMS', mode: 'demo', suggested: 'Twilio (exige registro A2P 10DLC nos EUA)', status: 'Não conectado' },
  whatsapp: { label: 'WhatsApp', mode: 'demo', suggested: 'WhatsApp Business Platform (templates aprovados pela Meta)', status: 'Não conectado' },
  payments: { label: 'Pagamentos', mode: 'demo', suggested: 'Stripe ou Square (link de pagamento + webhook)', status: 'Não conectado' },
};

// Envia (simula) uma mensagem. Retorna o resultado como um provedor real retornaria.
function sendMessage(channel, { to, subject, body }) {
  const p = providers[channel];
  if (!p) throw new Error('Canal desconhecido: ' + channel);
  if (p.mode !== 'live') {
    return { ok: true, simulated: true, provider: 'demo', status: 'simulated', to, subject, body };
  }
  throw new Error('Integração real ainda não implementada para ' + channel);
}

// Pagamentos: na v1 o pagamento é registrado manualmente. Esta função é o ponto
// onde um link de pagamento (Stripe/Square) seria gerado.
function createPaymentLink(/* invoice */) {
  return { available: false, reason: 'Integração de pagamentos pendente. Registre o pagamento manualmente.' };
}

function status() {
  return Object.entries(providers).map(([key, p]) => ({ key, ...p }));
}

module.exports = { sendMessage, createPaymentLink, status, providers };
