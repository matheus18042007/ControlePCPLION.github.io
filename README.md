# Controle PCP LION

PWA (app instalável) de controle de chão de fábrica. Roda 100% no navegador —
HTML + CSS + JavaScript puro, sem framework, sem build. Funciona offline e
sincroniza com o Supabase quando tem internet.

Versão atual: **2.7** (`APP_VERSION` em `js/app.js`, `CACHE_VERSION` em `sw.js`).

---

## Hub de funções

A tela inicial é um hub com os módulos. Cada módulo é **independente**: tem suas
próprias telas, sua própria tabbar e seu **próprio banco local** — um não derruba
o outro.

| Módulo | Id | O que faz | Banco local | Tabelas no Supabase |
|---|---|---|---|---|
| 📦 Almoxarifado PBA | `almox` | Entrada/saída de estoque por QR Code, itens, movimentações, estoque baixo | `pcp_almox` | `itens`, `movimentacoes`, `exclusoes` |
| 🔢 Contagem de Quadros VG | `quadro` | Contagem cíclica de quadros na produção (contagem simples) | `pcp_quadro` | `contagem_itens`, `contagem_movimentacoes` (modulo=`quadro`) |
| 🏋️ Contagem de Máquinas VG | `maquinas` | Contagem cíclica de máquinas, por combinação de cor do quadro e cor da articulação | `pcp_maquinas` | idem, modulo=`maquinas` (+ `contagem_combos`, `contagem_cores_opcoes`) |
| 🛡️ Carenagens VG | `carenagem` | Contagem cíclica de carenagens, contada por cor, com foto de referência | `pcp_carenagem` | idem, modulo=`carenagem` (+ `contagem_fotos`) |
| ⏱️ Eficiência VG | `eficiencia` | Faltas e horas extras do dia, por setor. Histórico de 10 dias | `pcp_eficiencia` | `eficiencia_colaboradores`, `eficiencia_dias` |
| ⚠️ Faltas VG | `faltas` | Registro de faltas de peças, com base de componentes e aviso por push | `pcp_faltas` | `faltas`, `faltas_componentes` |
| 📦 Kits | `kits` | Separação de kits por máquina, com falta de componente (abas Kits e Histórico). Edição só para quem tem o id em `edita` no cofre (admin.html) | `pcp_kits` | `kits_historico`, `kits_faltas` (`supabase/patch_kits.sql`); espelho da planilha `kits_linhas`, `kits_sync`, `kits_fila`, `kits_config` (`patch_kits_sync.sql`) |
| ⚙️ Banco de Dados | `banco` | Backup de todos os módulos, estrutura das tabelas, nuvem e notificações (módulo restrito) | nenhum próprio (lê os bancos dos outros módulos) | todas, só leitura (backup em CSV) |

### Como adicionar um módulo novo

1. criar as `<section class="view" data-modulo="xxx">` no `index.html` e os
   `<button class="tab" data-modulo="xxx">`;
2. registrar o módulo em `MODULOS` (`js/modulos.js`);
3. se for do tipo `contagem`, **nada mais precisa ser escrito** — o motor
   genérico `js/contagem.js` monta tela e banco a partir do `cfg`.

### Janelas no PC

Em tela larga (a partir de 900 px) os formulários e detalhes abrem como **janela
flutuante**: centralizada, sobre fundo escurecido, com título e botão **X** no
canto. No celular continua a gaveta que sobe de baixo. É o mesmo `.sheet-wrap` de
antes, só com a classe `janela-pc`.

- Fechar: botão X, tecla **Esc** ou clique no fundo escuro. No Kits o Esc fecha em
  camadas (primeiro a falta, depois a confirmação de separar, depois o detalhe).
- Limitação conhecida: no Contagem (Definir quantidade, Novo item) e na
  Eficiência (Novo colaborador) o clique no fundo ainda não fecha; X e Esc
  funcionam. O botão voltar do Android também não fecha as janelas dos módulos.
- Onde existem: Almoxarifado (Entrada, Novo item), Contagem (Definir quantidade,
  Novo item), Eficiência (Novo colaborador), Faltas (Registrar falta, Zerar
  faltas) e Kits (detalhe do kit, Registrar falta de componente, Separar kit).
  O módulo Banco de Dados não tem janelas.
- CSS: bloco "janela" em `css/styles.css` (`.janela-pc`, `.janela-x`, animação
  `janela`, regra `@media (min-width:900px)`). Largura máxima 560 px; fica acima
  do conteúdo (z-index 60) e abaixo do aviso toast (80).
- Para criar uma janela nova: no `.sheet-wrap` acrescentar `janela-pc`, pôr
  `<button class="janela-x" aria-label="Fechar" type="button">&times;</button>`
  e ligar X, Esc e clique no fundo no módulo (copiar de `js/faltas.js`).

---

## Arquivos

```
index.html          Shell do app: hub, views e tabbars de todos os módulos
admin.html          Gerador do cofre (js/usuarios.js) — uso do administrador
css/styles.css      Estilo único (claro/escuro)
sw.js               Service Worker — cache offline (ARQUIVOS + CACHE_VERSION)
manifest.json       PWA: ícones, nome, cor

js/base.js          Base compartilhada: IndexedDB, SQLite, CSV, datas
js/modulos.js       Registro dos módulos (hub) — id, ícone, view inicial
js/app.js           Núcleo: hub, telas do Almoxarifado, scanner QR,
                    import/export CSV e .db
js/contagem.js      Motor genérico dos módulos de contagem (quadro, maquinas, carenagem)
js/eficiencia.js    Módulo Eficiência VG (folha do dia + histórico)
js/faltas.js        Módulo Faltas VG (registro de faltas + base de componentes)
js/kits.js          Módulo Kits (separação de kits por máquina, falta de componente)
js/push.js          Inscrição do aparelho em notificações (VAPID) — só o Faltas usa
js/nuvem.js         Camada Supabase (REST/PostgREST) — um namespace por tipo de módulo
js/auth.js          Login e cofre AES-GCM da config da nuvem
js/usuarios.js      Cofre cifrado — GERADO por admin.html, não editar à mão
js/banco.js         Módulo Banco de Dados (restrito): backup .db/.csv/.sql de
                    todos os módulos, estrutura das tabelas, nuvem e push

supabase/functions/faltas-notificar/   Edge Function que dispara o push
vendor/             sql-wasm (SQLite), html5-qrcode
icons/              Ícones do PWA (192, 512, maskable, apple-touch)
```

### SQL (rodar no SQL Editor do Supabase)

Hoje a pasta `supabase/` tem só `patch_*.sql` (não existe `schema.sql` no
repositório: o schema base já está no projeto do Supabase). Todos são
idempotentes e podem ser rodados de novo sem apagar dados.

| Arquivo | Para que serve |
|---|---|
| `patch_almoxarifado.sql` | Correção do `registrar_movimentacao` (saída grava quantidade positiva, sinal só no tipo) |
| `patch_faltas.sql` | Ajustes da tabela `faltas` (colunas que faltavam, como `suprida_por`) |
| `patch_kits.sql` | Módulo Kits: tabelas `kits_historico` e `kits_faltas` (FK `falta_id` para `faltas.id`, com `ON DELETE CASCADE`) e RPCs. Rodar depois do módulo Faltas existir |
| `patch_carenagem_cores.sql` | Coluna `qtd_3d` (Adesivada 3D) em `contagem_itens` e `contagem_definir` passando a gravar essa cor |
| `patch_historico_cores.sql` | Coluna `cores` em `contagem_movimentacoes`, `contagem_definir` gravando as cores no histórico, e views `carenagens` / `movimentacoes_carenagens` |
| `patch_maquinas_cores.sql` | Cor do quadro e da articulação nas máquinas (ver abaixo) |
| `patch_maquinas_modulo.sql` | Separa `maquinas` de `quadro` (módulo próprio) |
| `patch_maquinas_copiar.sql` | Cópia única do que foi contado como máquina em `quadro` para `maquinas` |

**Ordem para as máquinas:** `patch_maquinas_cores.sql` primeiro, depois
`patch_maquinas_modulo.sql`, e por fim (opcional, uma vez só)
`patch_maquinas_copiar.sql`.

- `patch_maquinas_cores.sql` cria as tabelas `contagem_combos` e
  `contagem_cores_opcoes`, a coluna de cor no histórico, as políticas de leitura
  (RLS), as RPCs `contagem_definir_combo`, `contagem_zerar_combos`,
  `contagem_opcao_adicionar` e `contagem_opcao_remover`, a função/trigger
  `trg_contagem_itens_apaga_combos` (excluir o item leva as combinações junto) e
  a view `maquinas_combos` (uma linha por máquina + combinação).
- `patch_maquinas_modulo.sql` insere as opções de cor do módulo `maquinas`,
  recria a view `maquinas_combos` para ele e devolve o `quadro` a ser contagem
  sem cores. O que foi contado antes como máquina continua em `quadro`; o
  módulo `maquinas` começa vazio.
- `patch_maquinas_copiar.sql` copia os dados de `quadro` para `maquinas`, tabela
  por tabela, só se o destino estiver vazio (rodar de novo é seguro). O `quadro`
  não é alterado.

---

## Eficiência VG

Folha **do dia**: você marca a situação de cada colaborador, clica em
**Finalizar eficiência** e o dia inteiro vai para o histórico carimbado com a
data, deixando a folha limpa para o dia seguinte.

Situação guarda só o código:

| Código | Significado |
|---|---|
| `I` | Dia todo |
| `P` | Parcial |
| `` (vazio) | Falta |

Histórico mantido por **10 dias** (`DIAS_HISTORICO`).

### Ordem da planilha

Os colaboradores aparecem **na ordem da planilha CSV importada**, não em ordem
alfabética. A coluna `ordem` (integer) existe em `eficiencia_colaboradores` e em
`eficiencia_dias`; os setores também são ordenados pelo menor `ordem` dos seus
colaboradores. Reimportar a planilha reordena sem perder marcações.

A migração da `ordem` (o arquivo `supabase_eficiencia_ordem.sql` **não está** em
`supabase/` hoje, então não dá para rodar a partir deste repositório) consiste em:

- `alter table` adicionando `ordem` nas duas tabelas + índice;
- `drop function` da versão antiga de `eficiencia_cadastrar` (6 argumentos) e
  recriação com 7 (o `p_ordem`) — senão o Postgres fica com as duas e não sabe
  qual chamar;
- `eficiencia_finalizar` levando a `ordem` junto para o histórico;
- views `eficiencia_vg` e `eficiencia_vg_historico` (`drop view ... cascade`
  antes de criar: não dá para trocar a lista de colunas de uma view existente);
- `notify pgrst, 'reload schema'` no fim.

**Se der "Could not find the 'ordem' column ... in the schema cache":** o SQL não
rodou, ou o PostgREST está com cache velho. Rode o arquivo inteiro e, se ainda
falhar, Settings → API → *Reload schema cache*.

O CSV precisa das colunas **setor** e **colaborador** (separador `;` ou `,`).

### Exportação

Dois botões, ambos `.csv`:

- **Relatório do dia** — você escolhe o dia num select (só aparecem dias já
  finalizados). Lê sempre do histórico (`eficiencia_dias`), nunca da folha
  aberta, então o que sai é exatamente o que foi carimbado. Colunas
  `setor;colaborador;situacao;horas`, na ordem da planilha. Abaixo da tabela vem
  um bloco **Resumo de horas** (`horas;quantidade`, ordenado da menor para a
  maior) e a linha **Total de colaboradores**.
- **Histórico completo** — despejo cru de `eficiencia_dias`:
  `data;setor;colaborador;situacao;hora;usuario`.

---

## Contagem por cor (contagem)

Item de contagem pode ser contado **por cor** em vez de um número só. Hoje só o
módulo **Carenagens VG** liga isso (`TEM_CORES = (id === 'carenagem')` em
`js/contagem.js`); pra ligar em outro módulo é mexer nessa linha. A **Contagem
de Máquinas VG** não usa este modelo: ela conta por combinação de duas cores
(ver a seção própria abaixo).

As cores ficam na lista `CORES` logo abaixo, uma coluna por tipo:

| Coluna | Nome na tela |
|---|---|
| `qtd_onix` | Ônix |
| `qtd_preto_fosco` | Preto fosco |
| `qtd_black_piano` | Black piano |
| `qtd_cinza` | Cinza |
| `qtd_champanhe` | Champanhe |
| `qtd_3d` | Adesivada 3D |

- **A `qtd` do item passa a ser a soma das cores.** Você digita as cores, o app
  soma e grava a soma em `qtd`. Todo o resto do módulo (lista, relatório,
  estoque, movimentações) continua lendo `qtd` normalmente.
- **Banco local:** as colunas entram no `CREATE TABLE`. Banco antigo (criado
  antes das cores) é migrado sozinho no `abrirBanco()` — um `ALTER TABLE ... ADD
  COLUMN` por coluna que faltar. Não precisa apagar nada.
- **Nuvem:** o app manda as cores como um objeto no `p_cores` da RPC
  `contagem_definir` (`{ qtd_onix: 2, ... }`); módulo sem cor manda `null`. A
  coluna `qtd_3d` vem do `patch_carenagem_cores.sql`, e a coluna `cores` do
  histórico do `patch_historico_cores.sql`. As demais colunas de cor e a RPC base
  já existem no projeto (não há `schema.sql` no repositório).
- **Zerar** (contagem cíclica) zera as cores junto com a `qtd`.
- Na lista, o item mostra as cores contadas embaixo do nome (só as diferentes de
  zero). Mudar só a cor, sem mudar o total, ainda conta como alteração e é
  gravado.
- **Os `.csv` não levam as cores**: relatório (`Cod;Nome;Qtd`) e exportação de
  itens (`codigo;nome;qtd;data_cadastro`) saem só com o total. Pra ver cor por
  cor hoje é na tela ou no `.db`.

---

## Contagem de Máquinas VG

Módulo `maquinas` (ícone de halter, banco local `pcp_maquinas`, tabelas locais
`maquinas` / `movimentacoes_maquinas`), independente da Contagem de Quadros VG
(`quadro`, contagem simples com + / - na lista, contagem rápida e folha de
quantidade). Ligado por `combos: true` em `js/modulos.js`.

Cada máquina é contada por **combinação** de **cor do quadro** e **cor da
articulação**:

- Na lista, a linha mostra só a **quantidade somada** da máquina e um botão
  **+** (sem menos e sem contagem rápida).
- O **+** abre a folha com os dois dropdowns lado a lado (cor do quadro e cor da
  articulação) e a quantidade a contar. Os dropdowns começam **vazios** toda vez
  que a folha abre.
- Combinações **iguais** na mesma máquina são agrupadas (a quantidade soma);
  combinações **diferentes** viram linhas separadas.
- Abaixo dos botões a folha lista as combinações já contadas daquela máquina;
  tocar em uma preenche os dropdowns para corrigir.
- A `qtd` do item é a soma das combinações (mais o que tiver sido contado sem cor).
- **Cores disponíveis:** Onix, Preto fosco, Black piano, Cinza, Champanhe e
  Adesivada 3D. As listas são editáveis em **Configurações** (adicionar /
  remover), uma lista para o quadro e outra para a articulação.
- **Relatório (.csv):** uma linha por máquina + combinação, com as colunas
  `Cod;Nome;Quadro;Articulacao;Qtd;Total`. `Total` é o total da máquina,
  repetido em cada linha dela (não há linha de total separada). O que foi
  contado sem cor entra como `Sem cor` em Quadro e Articulacao.
- **Local:** tabelas `cmb_maquinas` (combinações) e `opc_maquinas` (opções dos
  dropdowns) no SQLite do módulo.
- **Nuvem:** `contagem_combos` e `contagem_cores_opcoes`, via as RPCs
  `contagem_definir_combo`, `contagem_zerar_combos`, `contagem_opcao_adicionar`
  e `contagem_opcao_remover`. Os SQL estão em `supabase/` (ordem na seção SQL).

---

## Foto de referência (contagem)

Item de contagem pode ter **uma foto**, pra quem está no chão de fábrica
reconhecer a peça. Hoje só o módulo **Carenagens VG** liga isso
(`TEM_FOTO = (id === 'carenagem')` em `js/contagem.js`); pra ligar em outro
módulo é mexer nessa linha.

- Aparece na **tela do item** e no **cadastro** (adicionar / remover).
- Tocar na foto abre o **visor em tela cheia**: pinça com 2 dedos ou roda do
  mouse pra dar zoom (até 6x), toque duplo alterna 1x / 2.5x, 1 dedo arrasta
  quando está com zoom. Fecha no "← Voltar", no `Esc` e no botão voltar do
  Android.
- Guardada em base64 (data URL), já reduzida pelo app (~100 KB).
- **Local:** IndexedDB, chave `foto_<codigo>` — fora do SQLite **de propósito**,
  porque o sync apaga e regrava a tabela de itens e levaria a foto junto.
- **Nuvem:** tabela própria `contagem_fotos` (`modulo` + `codigo` como chave),
  também separada de `contagem_itens` pelo mesmo motivo. RLS aberta (select /
  insert / update / delete para `anon` e `authenticated`), sem função
  `security definer` — é a exceção da regra abaixo.

---

## Banco de Dados

Módulo `banco` (`js/banco.js`), restrito: cada usuário do cofre pode ter uma
lista de módulos liberados, e o Banco de Dados só aparece para quem tem ele
nessa lista. Existe porque cada módulo tem o **seu** SQLite em um IndexedDB
próprio, então o backup de um módulo sozinho não pega o resto. Três abas:

- **Backup:**
  - *Backup da nuvem:* **Baixar TUDO** gera um `.csv` por tabela do Supabase
    (`;` como separador), em downloads seguidos. Inclui `contagem_fotos`,
    `contagem_combos` e `contagem_cores_opcoes`. Tabela que não existe no
    servidor é pulada em silêncio.
  - *O que existe hoje:* **Examinar bancos** varre os bancos locais de todos os
    módulos (acordando cada motor antes) e lê a estrutura de cada um do
    `sqlite_master` (tabelas, índices, linhas), sem schema fixo no código. O
    backup local sai em `.db`, `.csv` e `.sql`; as fotos de referência (chaves
    `foto_<codigo>` no IndexedDB) não vão dentro do `.db`.
- **Nuvem:** endereço, chave anon (com botão Revelar), situação, teste de
  conexão e id deste aparelho, mais a lista de usuários do cofre. Trocar
  endereço ou chave é pelo `admin.html`, não aqui.
- **Notificações:** estado do push neste aparelho (Ativar / Desativar) e a
  chave VAPID pública.

---

## Faltas VG

Registro oficial de peça em falta no chão de fábrica — quem registrou, o quê,
quanto, e em que pé está a reposição. Substitui o aviso no grito / no WhatsApp.

### Fluxo

1. **Registrar falta** — você digita o código; o nome vem sozinho da base de
   componentes. Código desconhecido não trava: ele avisa e deixa você salvar
   com o nome digitado à mão.
2. A falta entra na lista da tela inicial do módulo.
3. **Status** (radio, um só por vez): sem previsão · produzindo · em
   transferência · será produzido.
4. **Suprida** (checkbox) — tira da lista. Não apaga do banco: fica lá com
   `suprida_em` carimbado, para relatório futuro.

### Base de componentes

É a diferença deste módulo para os outros: ele tem uma tabela própria
`faltas_componentes` (`codigo` → `nome` vigente), importada por CSV com as
colunas `codigo` e `nome` (separador `;` ou `,`). Serve **só** para preencher
o nome na hora de registrar. Reimportar atualiza os nomes de quem já existe.

**Atualizar a lista sem mexer em arquivo:** na aba Config do módulo, copie as
duas colunas (código e nome) direto da planilha, cole na caixa e clique em
"Importar o que colei". Aceita cabeçalho ou não, e separador TAB (colagem do
Excel/Sheets), `;` ou `,`. Linhas sem código ou sem nome são ignoradas, com aviso.
Quem já existe tem o nome atualizado e ninguém é apagado. Depois da importação
local, a lista sobe para a nuvem (Supabase) e passa a valer em todos os aparelhos.
O módulo Kits usa essa mesma base para preencher o nome ao registrar falta.

### Notificações (push)

Único módulo com notificação. Toda falta registrada bate na Edge Function
`faltas-notificar` — o cliente **não** decide se envia, só avisa que tem
novidade.

A função:
- olha `faltas_notif_estado.ultimo_envio`;
- se passou o intervalo mínimo (1 minuto, constante `COOLDOWN_MIN` na função) e há faltas com `notificada_em is null`, monta **uma**
  notificação agregada ("3 novas faltas: 4471 SUPORTE BANCO, ...") e faz
  fan-out em lotes de 100;
- se não passaram, não envia nada — as faltas ficam pendentes e vão juntas no
  próximo disparo.

Ou seja: registrando 20 faltas seguidas, o pessoal recebe 1 notificação, não 20.

Sincronizar o módulo também chama a função — assim uma falta registrada dentro
da janela de cooldown, sem ninguém registrar nada depois, não fica presa para
sempre: qualquer aparelho abrindo o Faltas VG faz o flush.

**Limites honestos:**
- iOS só entrega push se o app estiver **instalado na tela de início**
  (iOS 16.4+).
- A Edge Function tem timeout de 10s — folga sobrando para dezenas de
  aparelhos, mas não para dezenas de milhares.
- Subscription que responde 404/410 é apagada da tabela na hora.

### Deploy do push (uma vez)

```
npx web-push generate-vapid-keys
```

- a chave **pública** vai em `js/push.js` (constante `VAPID_PUBLIC`) — é
  pública por definição, não precisa entrar no cofre;
- a **privada** vira secret da função:

```
supabase functions deploy faltas-notificar
supabase secrets set VAPID_PUBLIC=... VAPID_PRIVATE=... VAPID_SUBJECT=mailto:voce@empresa.com
```

Sem isso o módulo funciona inteiro — só não notifica.

---

## Kits

Separação de kits de componentes por máquina. A fonte da verdade é a planilha
Google "PROGRAMAÇÃO DIÁRIA OPERACIONAL - 2026" (uma aba por semana, ex.:
`2ª SEM NOV`). O app não lê a planilha direto: um Apps Script dentro da planilha
copia as linhas para o Supabase (espelho `kits_linhas`) e o app lê esse espelho.
O banco também guarda o histórico de separações e o vínculo com as faltas.

### Fluxo

1. O almoxarifado marca `TRUE` na coluna **KIT** da planilha (kit liberado).
2. No app o kit liberado fica clicável. Quem separa toca em **Separar** e confirma
   na janela. O app não escreve na planilha: ele pede a separação (`kits_separar`,
   que cria uma linha em `kits_fila`) e marca o kit como separado na hora.
3. No ciclo seguinte (até 1 minuto) o Apps Script lê a fila e grava `TRUE` na
   coluna **ALMOX. FRENTE**, se a aba, o produto e o KIT ainda conferem. Se falhar,
   a marca é desfeita e o histórico registra `falhou`.
4. Estados: **separado** = `ALMOX. FRENTE` marcada (com ou sem KIT) · **liberado**
   = só `KIT` marcado · **aguardando** = nenhuma das duas. Só o liberado pode ser
   separado; o aguardando e o separado não abrem a ação.
5. **Falta no kit:** digitando o código, o nome vem da base de componentes do
   Faltas. Ao registrar, a falta entra na lista de Faltas (e dispara a
   notificação) e fica vinculada ao kit. O kit mostra a quantidade faltante
   (ex.: 2 ou 1,5). Kit já separado não aceita falta nova.
6. Quando a falta é suprida no módulo Faltas, ela deixa de aparecer no kit.
7. A aba **Histórico** lista as ações registradas (separações e faltas), da mais
   recente para a mais antiga, com busca. Limite de 200 registros.

### Regras de leitura da planilha

- O seletor escolhe a aba da semana; semana e mês saem do nome (`<n>ª SEM <MÊS>`).
  Abas com outro nome são ignoradas.
- As colunas são achadas pelo **nome no cabeçalho** (linha 1): `CARGA`, `PRODUTO`,
  `ALMOX. FRENTE` e `KIT`. A ordem não importa; se faltar uma, a aba dá erro.
- Só entra linha com código no formato `CÓDIGO - NOME` (o código pode vir depois
  de `(SAT n)`). Ficam de fora as linhas `TOTAL DE MÁQUINAS...` e `LOGOTIPO`.
- Exceção: as linhas de `BANCO MULTIFUNCIONAL` entram mesmo sem código, com
  carga `LOJA`.
- Máquinas repetidas são linhas independentes, cada uma com o seu kit. A
  numeração (1/3, 2/3...) segue a ordem das linhas na planilha.
- Se alguém inserir ou apagar linhas entre a leitura e o clique, o app avisa
  "Esta linha mudou" e pede para atualizar.

### Permissões

No `admin.html` cada usuário tem **Ver** e **Editar** no módulo Kits (a caixa
Editar só aparece para módulos listados em `Auth.MODULOS_COM_EDICAO`). Sem
Editar o usuário vê os kits, mas não separa nem registra falta. Usuário antigo
sem o campo `edita` vê o Kits, mas não edita até o admin marcar Editar. Lembrar
de republicar o `js/usuarios.js` depois de mexer.

### Banco e funções

- SQL: `supabase/patch_kits.sql` (`kits_historico`, `kits_faltas` e as RPCs
  `kits_registrar_historico`, `kits_vincular_falta`, `kits_desvincular_falta`).
  Precisa do módulo Faltas já criado.
- SQL: `supabase/patch_kits_sync.sql` (espelho `kits_linhas`, `kits_sync`, fila
  `kits_fila`, segredo em `kits_config`). RPC do app: `kits_separar`. RPCs do
  Apps Script, todas protegidas por segredo: `kits_sincronizar`,
  `kits_fila_pendentes`, `kits_fila_concluir`, `kits_manter_abas`.
- O app lê `kits_linhas` (abas vêm de `kits_sync`) e chama `kits_separar`. Não
  usa mais a Edge Function `kits-planilha`.
- Apps Script `apps-script/kits-sync.gs` (dentro da planilha), gatilho de 1
  minuto: envia as abas que mudaram, faz um reenvio completo a cada 15 minutos
  (`COMPLETO_A_CADA_MIN`), reenvia abas sem mudança a cada 60 minutos
  (`HEARTBEAT_MIN`) e processa até 50 pedidos da fila por ciclo (`LOTE_FILA`).
  `kits_manter_abas` apaga o espelho de abas renomeadas ou excluídas.
- A tela mostra "Planilha sincronizada às HH:MM" e avisa se o espelho está
  parado há mais de 10 minutos.
- A pasta `supabase/functions/kits-planilha` e os segredos `GOOGLE_SA_*` são
  legado (conta de serviço do Google) e não são mais necessários.

### Instalação (uma vez)

1. No SQL Editor do Supabase rodar `patch_faltas.sql`, depois `patch_kits.sql` e
   `patch_kits_sync.sql` (todos podem ser rodados mais de uma vez).
2. Abrir a planilha, menu Extensões, Apps Script, e colar o conteúdo de
   `apps-script/kits-sync.gs`.
3. Em Propriedades do script criar `SUPABASE_URL`, `SUPABASE_KEY` (a chave
   pública anon) e `SEGREDO_SYNC` (o valor gerado em `kits_config`, chave
   `segredo_sync`; não colar em documentos nem no repositório).
4. Rodar `testarConexao` e aceitar as permissões; depois rodar `instalar` para
   criar o gatilho de 1 minuto. `sincronizarAgora` força um ciclo; `desinstalar`
   remove o gatilho.
5. No `admin.html` dar Ver e Editar do Kits aos usuários e republicar
   `js/usuarios.js`.
6. Conferir no app o aviso "Planilha sincronizada às HH:MM".

### Limites

- Atraso de até 1 minuto entre marcar na planilha e aparecer no app, e entre
  tocar em Separar e a coluna ser marcada.
- Mudar o nome das colunas ou o formato do nome da aba derruba a leitura. Linha
  sem `CÓDIGO - NOME` some do app sem aviso.
- O espelho é legível por quem tem a chave anon (política `using (true)`).
- Se o gatilho do Apps Script parar, o app só avisa depois de 10 minutos.
- O Apps Script tem limite de 6 minutos por execução e cotas do Google.

---

## Nuvem (Supabase)

Sincronia por REST (PostgREST), com paginação. Toda escrita passa por função
`security definer` no banco — o app nunca faz `insert` direto:

- Almoxarifado: `registrar_movimentacao`, `cadastrar_item`, `excluir_item`
- Contagem: `contagem_definir`, `contagem_cadastrar`, `contagem_zerar`, `contagem_excluir`
- Contagem de Máquinas (combinações de cor): `contagem_definir_combo`, `contagem_zerar_combos`, `contagem_opcao_adicionar`, `contagem_opcao_remover`
- Eficiência: `eficiencia_marcar`, `eficiencia_cadastrar`, `eficiencia_finalizar`, `eficiencia_excluir`
- Faltas: `faltas_registrar`, `faltas_status`, `faltas_suprir`, `faltas_reabrir`, `faltas_excluir`, `push_registrar`, `push_remover`
- Kits: `kits_registrar_historico`, `kits_vincular_falta`, `kits_desvincular_falta`

RLS está ligado em todas as tabelas. Cada aparelho tem um id próprio, gravado
junto com o usuário em toda movimentação.

---

## Login e o cofre

- Existe uma **chave-mestra aleatória (M)**, gerada uma única vez.
- A URL e a chave anon do Supabase ficam **cifradas com M** (AES-GCM).
- M não é guardada em texto puro: para cada usuário guardamos M cifrada com a
  **senha dele** (PBKDF2-SHA256, 310.000 rodadas).

Resultado: `js/usuarios.js` publicado no GitHub é só ruído. Trocar a senha de um
usuário não mexe nos outros.

**Limite honesto:** quem tem uma senha válida consegue, com esforço, extrair a
chave anon — o navegador precisa dela em claro para falar com o Supabase. A
defesa real do banco continua sendo o **RLS**.

Para criar/remover usuários ou trocar a chave do Supabase: abra `admin.html`,
gere o novo `js/usuarios.js` e publique.

---

## Publicar uma atualização

1. mudar `APP_VERSION` em `js/app.js`;
2. mudar `CACHE_VERSION` em `sw.js` (mesmo número, ex. `pcp-lion-v2.7`);
3. se criou arquivo novo, adicionar em `ARQUIVOS` no `sw.js`;
4. commit + push (GitHub Pages).

Sem trocar o `CACHE_VERSION` os celulares continuam com a versão antiga em cache.

Teste local: `python -m http.server 8080` e abrir `http://localhost:8080`
(precisa ser servido por HTTP — a câmera e o Service Worker não funcionam em
`file://`).
