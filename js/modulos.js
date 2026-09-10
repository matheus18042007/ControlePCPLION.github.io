/* ---------------------------------------------------------
   HUB DE FUNÇÕES

   Cada módulo do Controle PCP LION é independente: tem seu
   próprio título, suas próprias views (marcadas no HTML com
   data-modulo) e mais para frente suas próprias tabelas.
   Para adicionar uma função nova:
     1. criar as <section class="view" data-modulo="xxx"> no
        index.html e os <button class="tab" data-modulo="xxx">;
     2. registrar o módulo aqui embaixo em MODULOS;
     3. (se precisar) criar as tabelas no db.js do módulo.
--------------------------------------------------------- */
window.MODULOS = [
  {
    id: 'almox',
    nome: 'Almoxarifado PBA',
    desc: 'Entrada e saída de estoque por QR Code. Itens, movimentações e estoque baixo.',
    icone: '📦',
    titulo: 'Almoxarifado',
    viewInicial: 'estoque',
    pronto: true
  },
  {
    id: 'quadro',
    nome: 'Contagem de Quadros VG',
    desc: 'Contagem cíclica de quadros na produção. Banco próprio: quadros / movimentacoes_quadros.',
    icone: '🔢',
    titulo: 'Contagem de Quadros VG',
    viewInicial: 'quadro-cont',
    pronto: true,
    tipo: 'contagem',
    tabela: 'quadros',
    tabelaMov: 'movimentacoes_quadros',
    unidade: 'pç'
  },
  {
    id: 'carenagem',
    nome: 'Carenagens VG',
    desc: 'Contagem cíclica de carenagens. Banco próprio: carenagens / movimentacoes_carenagens.',
    icone: '🛡️',
    titulo: 'Carenagens VG',
    viewInicial: 'carenagem-cont',
    pronto: true,
    tipo: 'contagem',
    tabela: 'carenagens',
    tabelaMov: 'movimentacoes_carenagens',
    unidade: 'pç'
  },
  {
    id: 'eficiencia',
    nome: 'Eficiência VG',
    desc: 'Controle diário de faltas e horas extras da produção, por setor. Histórico de 10 dias.',
    icone: '⏱️',
    titulo: 'Eficiência VG',
    viewInicial: 'eficiencia-dia',
    pronto: true,
    tipo: 'eficiencia'
  },
  {
    id: 'faltas',
    nome: 'Faltas VG',
    desc: 'Registro de faltas de peças, com base de componentes e aviso para todo mundo.',
    icone: '⚠️',
    titulo: 'Faltas VG',
    viewInicial: 'faltas-lista',
    pronto: true,
    tipo: 'faltas'
  },
  {
    id: 'banco',
    nome: 'Banco de Dados',
    desc: 'Backup completo, estrutura das tabelas, endereço da nuvem e notificações.',
    icone: '⚙️',
    titulo: 'Banco de Dados',
    viewInicial: 'banco-backup',
    pronto: true,
    tipo: 'banco'
  }
];
