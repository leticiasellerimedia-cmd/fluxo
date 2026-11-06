// Método de acompanhamento do time. Para trocar de método, altere apenas este arquivo:
// as telas, relatórios e regras usam estas dimensões automaticamente.
module.exports = {
  name: 'MAGIC',
  source: 'Modelo de engajamento da Ken Blanchard Companies: Meaning, Autonomy, Growth, Impact, Connection.',
  scale: { 1: 'Muito baixo', 2: 'Baixo', 3: 'Adequado', 4: 'Bom', 5: 'Excelente' },
  dimensions: [
    {
      key: 'M', label: 'Significado', original: 'Meaning',
      question: 'A pessoa entende por que o trabalho dela importa para o cliente e para a empresa?',
      ideas: ['Compartilhar com a pessoa os elogios recebidos dos clientes', 'Explicar o impacto de cada visita na rotina da família atendida', 'Apresentar a meta do mês da empresa e o papel dela nesse resultado'],
    },
    {
      key: 'A', label: 'Autonomia', original: 'Autonomy',
      question: 'Tem liberdade e confiança para decidir como executar o próprio trabalho?',
      ideas: ['Deixar a pessoa definir a ordem de execução da casa', 'Autorizar a resolver pequenos imprevistos direto com o cliente', 'Combinar o resultado esperado em vez de acompanhar cada passo'],
    },
    {
      key: 'G', label: 'Crescimento', original: 'Growth',
      question: 'Está aprendendo, ganhando novas habilidades e vê futuro na empresa?',
      ideas: ['Treinar um novo tipo de serviço (deep clean, move-out)', 'Preparar para liderar uma equipe ou treinar quem está chegando', 'Apoiar um curso de inglês para atendimento ao cliente'],
    },
    {
      key: 'I', label: 'Impacto', original: 'Impact',
      question: 'Enxerga o resultado concreto do que faz e é reconhecida por ele?',
      ideas: ['Mostrar todo mês as avaliações e os indicadores da equipe', 'Reconhecer publicamente resultados acima do padrão', 'Usar fotos de antes e depois para evidenciar o resultado'],
    },
    {
      key: 'C', label: 'Conexão', original: 'Connection',
      question: 'Sente que faz parte do time e tem uma boa relação com a liderança?',
      ideas: ['Manter uma conversa individual mensal com o dono', 'Promover um momento de integração da equipe', 'Perguntar o que dificulta o dia a dia e agir sobre a resposta'],
    },
  ],
};
