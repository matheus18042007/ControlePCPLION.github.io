# Controle PCP LION

PWA (app instalável) de controle de chão de fábrica. Roda 100% no navegador —
HTML + CSS + JavaScript puro, sem framework, sem build. Funciona offline e
sincroniza com o Supabase quando tem internet.

Versão atual: **1.20.0** (`APP_VERSION` em `js/app.js`, `CACHE_VERSION` em `sw.js`).

---

## Hub de funções

A tela inicial é um hub com os módulos. Cada módulo é **independente**: tem suas
próprias telas, sua própria tabbar e seu **próprio banco local** — um não derruba
o outro.

| Módulo | Id | O que faz | Banco local | Tabelas no Supabase |
|---|---|---|---|---|
| 📦 Almoxarifado PBA | `almox` | Entrada/saída de estoque por QR Code, itens, movimentações, estoque baixo | `pcp_almox` | `itens`, `movimentacoes`, `exclusoes` |
| 🔢 Contagem de Quadros VG | `quadro` | Contagem cíclica de quadros na produção | `pcp_quadro` | `contagem_itens`, `contagem_movimentacoes` (modulo=`quadro`) |
| 🛡️ Carenagens VG | `carenagem` | Contagem cíclica de carenagens | `pcp_carenagem` | idem, modulo=`carenagem` |
| ⏱️ Eficiência VG | `eficiencia` | Faltas e horas extras do dia, por setor. Histórico de 10 dias | `pcp_eficiencia` | `eficiencia_colaboradores`, `eficiencia_dias` |
| ⚠️ Faltas VG | `faltas` | Registro de faltas de peças, com base de componentes e aviso por push | `pcp_faltas` | `faltas`, `faltas_componentes` |

### Como adicionar um módulo novo

1. criar as `<section class="view" data-modulo="xxx">` no `index.html` e os
   `<button class="tab" data-modulo="xxx">`;
2. registrar o módulo em `MODULOS` (`js/app.js`, ~L347);
3. se for do tipo `contagem`, **nada mais precisa ser escrito** — o motor
   genérico `js/contagem.js` monta tela e banco a partir do `cfg`.

---

## Arquivos

```
index.html          Shell do app: hub, views e tabbars de todos os módulos
admin.html          Gerador do cofre (js/usuarios.js) — uso do administrador
css/styles.css      Estilo único (claro/escuro)
sw.js               Service Worker — cache offline (ARQUIVOS + CACHE_VERSION)
manifest.json       PWA: ícones, nome, cor

js/app.js           Núcleo: banco SQLite, hub, telas do Almoxarifado,
                    scanner QR, import/export CSV e .db
js/contagem.js      Motor genérico dos módulos de contagem (quadro, carenagem)
js/eficiencia.js    Módulo Eficiência VG (folha do dia + histórico)
js/faltas.js        Módulo Faltas VG (registro de faltas + base de componentes)
js/push.js          Inscrição do aparelho em notificações (VAPID) — só o Faltas usa
js/nuvem.js         Camada Supabase (REST/PostgREST) — um namespace por tipo de módulo
js/auth.js          Login e cofre AES-GCM da config da nuvem
js/usuarios.js      Cofre cifrado — GERADO por admin.html, não editar à mão

supabase/functions/faltas-notificar/   Edge Function que dispara o push
vendor/             sql-wasm (SQLite), html5-qrcode
tools/gerar_icones.ps1   Gera os ícones a partir da logo
exemplo_itens.csv   Modelo de importação do Almoxarifado
```

### SQL (rodar no SQL Editor do Supabase, nesta ordem)

```
supabase.sql                  Almoxarifado
supabase_contagem.sql         Quadros + Carenagens
supabase_eficiencia.sql       Eficiência VG
supabase_eficiencia_ordem.sql Eficiência VG — coluna "ordem"
supabase_fotos.sql            Foto de referência dos itens de contagem
supabase_faltas.sql           Faltas VG + base de componentes + push
```

Todos são idempotentes: podem ser rodados de novo sem apagar dados.

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

Isso é o que o `supabase_eficiencia_ordem.sql` instala:

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

## Foto de referência (contagem)

Item de contagem pode ter **uma foto**, pra quem está no chão de fábrica
reconhecer a peça. Hoje só o módulo **Carenagens VG** liga isso
(`TEM_FOTO = (id === 'carenagem')` em `js/contagem.js`); pra ligar em outro
módulo é mexer nessa linha.

- Aparece na **tela do item** e no **cadastro** (adicionar / remover).
- Guardada em base64 (data URL), já reduzida pelo app (~100 KB).
- **Local:** IndexedDB, chave `foto_<codigo>` — fora do SQLite **de propósito**,
  porque o sync apaga e regrava a tabela de itens e levaria a foto junto.
- **Nuvem:** tabela própria `contagem_fotos` (`modulo` + `codigo` como chave),
  também separada de `contagem_itens` pelo mesmo motivo. RLS aberta (select /
  insert / update / delete para `anon` e `authenticated`), sem função
  `security definer` — é a exceção da regra abaixo.

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

### Notificações (push)

Único módulo com notificação. Toda falta registrada bate na Edge Function
`faltas-notificar` — o cliente **não** decide se envia, só avisa que tem
novidade.

A função:
- olha `faltas_notif_estado.ultimo_envio`;
- se passaram ≥ 10 min e há faltas com `notificada_em is null`, monta **uma**
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

## Nuvem (Supabase)

Sincronia por REST (PostgREST), com paginação. Toda escrita passa por função
`security definer` no banco — o app nunca faz `insert` direto:

- Almoxarifado: `registrar_movimentacao`, `cadastrar_item`, `excluir_item`
- Contagem: `contagem_definir`, `contagem_cadastrar`, `contagem_zerar`, `contagem_excluir`
- Eficiência: `eficiencia_marcar`, `eficiencia_cadastrar`, `eficiencia_finalizar`, `eficiencia_excluir`
- Faltas: `faltas_registrar`, `faltas_status`, `faltas_suprir`, `faltas_reabrir`, `faltas_excluir`, `push_registrar`, `push_remover`

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
2. mudar `CACHE_VERSION` em `sw.js` (mesmo número, ex. `pcp-lion-v1.20.0`);
3. se criou arquivo novo, adicionar em `ARQUIVOS` no `sw.js`;
4. commit + push (GitHub Pages).

Sem trocar o `CACHE_VERSION` os celulares continuam com a versão antiga em cache.

Teste local: `python -m http.server 8080` e abrir `http://localhost:8080`
(precisa ser servido por HTTP — a câmera e o Service Worker não funcionam em
`file://`).
