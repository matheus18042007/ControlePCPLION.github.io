# Almoxarifado PBA — PWA de estoque por QR Code

Aplicativo web instalável (PWA) para uso operacional dentro do almoxarifado:
escaneia o QR Code do item, escolhe **Entrada** ou **Saída**, informa a quantidade
e o saldo é atualizado automaticamente.

- 100% HTML + CSS + JavaScript puro (sem framework, sem build).
- Banco **SQLite** rodando no próprio navegador (`sql.js` / WebAssembly), persistido em **IndexedDB**.
- Funciona **offline** (Service Worker) — importante onde não há sinal.
- Leitura de QR Code pela câmera do celular (`html5-qrcode` + `getUserMedia`), sem app externo.
- Exporta o arquivo `.db` (SQLite) para sincronizar com o app do PC.

---

## 1. Estrutura de arquivos

```
Almoxarifado PBA/
├── index.html                  # interface (todas as telas)
├── manifest.json               # metadados do PWA (nome, ícones, standalone)
├── sw.js                       # Service Worker (cache offline + atualização)
├── .nojekyll                   # necessário no GitHub Pages
├── css/styles.css              # tema escuro, botões grandes para uso com luva
├── js/app.js                   # banco SQLite, telas, scanner, import/export
├── js/nuvem.js                 # cliente do Supabase (sincronização)
├── js/auth.js                  # login, senhas e criptografia do cofre
├── js/usuarios.js              # COFRE: usuários + URL/chave cifrados (gerado)
├── admin.html                  # painel que gera o js/usuarios.js
├── supabase.sql                # script para criar as tabelas na nuvem
├── vendor/
│   ├── sql-wasm.js             # sql.js 1.10.3
│   ├── sql-wasm.wasm           # SQLite compilado para WebAssembly
│   └── html5-qrcode.min.js     # leitor de QR Code 2.3.8
├── icons/                      # ícones 192 / 512 / maskable
├── tools/gerar_icones.ps1      # regera os ícones (PowerShell)
└── exemplo_itens.csv           # modelo de importação
```

As bibliotecas estão **hospedadas junto com o app** (pasta `vendor/`), e não em CDN —
assim o app abre offline de verdade, sem depender da internet.

---

## 2. Publicar no GitHub Pages

1. Crie um repositório no GitHub (ex.: `almoxarifado-pba`).
2. Envie **todo o conteúdo desta pasta** para a raiz do repositório
   (o `index.html` precisa ficar na raiz).

   Pelo terminal, dentro desta pasta:

   ```bash
   git init
   git add .
   git commit -m "PWA almoxarifado PBA"
   git branch -M main
   git remote add origin https://github.com/SEU_USUARIO/almoxarifado-pba.git
   git push -u origin main
   ```

3. No GitHub: **Settings → Pages → Build and deployment**
   - Source: `Deploy from a branch`
   - Branch: `main` / `/ (root)` → **Save**
4. Em 1–2 minutos o site fica disponível em:
   `https://SEU_USUARIO.github.io/almoxarifado-pba/`
   (HTTPS automático — requisito para o navegador liberar a câmera).

> Se o repositório for **privado**, o GitHub Pages exige plano pago. Para uso interno
> comum, deixe o repositório público (os dados de estoque **não** ficam no GitHub, só o app).

---

## 3. Instalar no celular (Samsung S25 / Chrome)

1. Abra o link do GitHub Pages no **Chrome**.
2. Menu (⋮) → **Adicionar à tela inicial** / **Instalar aplicativo**.
   (Ou toque no botão **📲 Instalar na tela inicial** na aba *Dados*.)
3. O app passa a abrir em tela cheia, com ícone próprio, sem barra do navegador.
4. Na primeira leitura, o Chrome pede permissão de **câmera** → *Permitir*.

Atualizações: basta publicar no GitHub. O Service Worker detecta a nova versão e
recarrega sozinho; também há o botão **🔄 Procurar atualização** na aba *Dados*.

---

## 3.1 Estoque compartilhado entre celulares (Supabase — grátis)

Sem isso, **cada aparelho tem o próprio estoque**. Com isso, todos veem o mesmo saldo.

1. Crie a conta em <https://supabase.com> → **New project** (guarde a senha do banco).
2. No painel: **SQL Editor** → cole TUDO do arquivo `supabase.sql` → **Run**.
3. Pegue as duas chaves no painel: ⚙️ **Project Settings → API Keys**
   - **Project URL** → algo como `https://abcdefgh.supabase.co`
   - chave **anon** / **public** → a chave longa que começa com `eyJ...`
   - ⚠️ nunca use a **service_role** (é a chave de administrador).
4. Leve os dois valores para o **cofre** (`admin.html`) — veja a seção **3.2**.
   A URL e a chave ficam **cifradas** dentro de `js/usuarios.js`, e só são abertas
   depois que o operador faz login. Nada de chave em texto puro no GitHub.

   Pronto: **todo celular que instalar o app já abre conectado**, ninguém digita nada
   além do próprio login.
   - No primeiro aparelho, ele pergunta se quer **enviar o catálogo** para a nuvem. Aceite.
   - Nos demais, o estoque desce da nuvem automaticamente.
   - Se preferir não usar o cofre, deixe `js/usuarios.js` vazio: o app abre **sem login**
     e a nuvem é configurada na mão em cada celular (aba **Dados** → *Banco na nuvem* →
     cole os dois campos → **Conectar**).
   - O botão **Desconectar** deixa aquele aparelho só local, e ele *não* volta a se conectar
     sozinho; para religar, use **Conectar** naquele celular.

   **Tamanho da base:** o Supabase corta toda resposta em 1000 linhas, então o app baixa
   em páginas até acabar — o catálogo desce inteiro, com 500 ou 50.000 itens (durante a
   descida o status mostra o andamento). Do histórico ele traz as **5.000 movimentações
   mais recentes**; as antigas continuam guardadas na nuvem e aparecem no painel do
   Supabase.

Como funciona:

- Toda entrada/saída vai **direto ao servidor**, dentro de uma transação que trava a linha
  do item (`select ... for update`). Dois celulares dando baixa no mesmo instante **não**
  se sobrescrevem — as quantidades se somam corretamente.
- Ao abrir um item, o app **confere o saldo oficial** na nuvem antes de deixar movimentar.
- O SQLite local vira só **cache de leitura** (abre rápido e permite consultar sem sinal).
- **Sem sinal, a baixa não é gravada** e o app avisa `NÃO gravado` — nada de saldo fantasma.
  O ponto verde/vermelho no topo mostra a situação da conexão; toque nele para sincronizar.
- A nuvem **nunca apaga** os itens do aparelho: se ela estiver vazia, o app pede que você
  envie os dados primeiro.

O histórico na nuvem é *append-only* (a política de segurança não permite apagar nem editar
movimentação pelo celular) — some só pelo painel do Supabase.

---

## 3.2 Login dos operadores e cofre da chave (`admin.html`)

O app pode exigir **login** e guardar a URL/chave do Supabase **criptografadas**.
Tudo isso mora em um único arquivo gerado: `js/usuarios.js` (o *cofre*).

Como o cofre funciona:

- A URL e a chave são cifradas com **AES-GCM 256** por uma *chave-mestra* aleatória.
- Para cada usuário, essa chave-mestra é embrulhada na **senha dele**, derivada com
  **PBKDF2-SHA256, 310.000 rodadas**, com *salt* próprio.
- **Nenhuma senha é guardada** — nem em texto, nem em hash reversível. Sem uma senha
  válida, o arquivo publicado não serve para nada: não dá para ler a chave do Supabase.
- Cada usuário tem a **sua** senha e todos abrem a mesma chave-mestra.

### Criar o cofre (primeira vez)

1. Abra **`admin.html`** no seu PC (basta dar duplo clique, ou usar o servidor local da
   seção 8). **Não precisa de internet** e ele **nunca** deve ser aberto pelos operadores.
2. Cole a **URL do projeto** e a **chave anon** do Supabase.
3. Informe **seu login, seu nome e sua senha** (mínimo 6 caracteres) → **Criar cofre**.
4. Em *Passo final*, clique **Baixar usuarios.js** e substitua o arquivo `js/usuarios.js`
   do projeto. Publique no GitHub.
5. Suba a `CACHE_VERSION` em `sw.js` (senão o celular continua com o cofre antigo em cache).

### Adicionar, trocar senha ou remover operador

1. Abra `admin.html`, cole a URL/chave outra vez **ou** carregue o cofre atual: o painel
   pede o **seu login e senha** para destravar.
2. Em *Usuários*: digite login + nome + senha → **Salvar usuário**.
   - Se o login já existir, a senha é **substituída** (é assim que se reseta uma senha).
   - **Remover** tira o acesso daquela pessoa.
3. **Baixar usuarios.js** → substitua o arquivo → publique → suba a `CACHE_VERSION`.

> Trocar a chave do Supabase depois? Use *Banco na nuvem* → **Atualizar dados da nuvem**
> dentro do `admin.html`: o cofre é re-cifrado sem que ninguém precise trocar de senha.

### No celular

- Ao abrir o app aparece a tela de **Entrar** (login + senha).
- **Manter conectado neste aparelho** deixa a sessão salva até alguém clicar em **Sair**
  (aba *Dados*). Sem marcar, a sessão cai ao fechar o app.
- O nome de quem está logado vai gravado em **toda movimentação** (coluna *usuário* do
  histórico e da nuvem) — não é mais preciso "definir operador" na mão.
- Senha esquecida? Não há recuperação (é esse o ponto): gere um cofre novo com uma
  senha nova para aquele login, como descrito acima.

---

## 4. Como usar

| Aba | Função |
|---|---|
| **📦 Estoque** | Lista pesquisável por código/nome, filtros *Estoque baixo* e *Zerados*. Toque no item para abrir. |
| **⛶ Escanear** | Liga a câmera e lê o QR Code. Também aceita digitar o código manualmente. |
| **🕘 Histórico** | Todas as movimentações, com filtro por tipo (entrada/saída), período e texto. |
| **⚙ Dados** | Importar CSV, cadastro manual, **excluir item**, exportar `.db`/`.csv`, importar `.db`, apagar dados. |

**Fluxo operacional:**

```
Escanear QR  →  Tela do item (nome + saldo)  →  [➕ Entrada] ou [➖ Saída]
             →  quantidade + observação      →  Confirmar
             →  saldo atualizado + registro no histórico
```

- Saída maior que o saldo disponível **pede confirmação** antes de deixar negativo.
- Toque no botão do topo direito para definir o **nome do operador** — ele é gravado
  em cada movimentação.
- Cada confirmação grava no banco e persiste imediatamente no aparelho.

### Excluir um item por completo (aba *Dados*)

O card **Excluir item** apaga o código **do banco na nuvem**: some o item e todo o
histórico dele, numa única transação (função `excluir_item`). Não tem como desfazer —
exporte o backup antes.

- Digite o código e confirme duas vezes (a segunda mostra quantas movimentações vão embora).
- **Com nuvem ligada:** só apaga aqui depois que o servidor confirmar. Se a nuvem não
  responder, **nada é apagado** — nem no celular. Assim dois aparelhos não ficam divergentes.
- **Sem nuvem** (app local): apaga só neste aparelho.
- Fica um rastro na tabela `exclusoes` do Supabase (código, nome, saldo final, quantas
  movimentações, quem excluiu e de qual aparelho) — as políticas de RLS continuam sem
  permitir `DELETE` solto pelo app.

### QR Codes aceitos

O conteúdo do QR é tratado como o **código do item**. O app também entende automaticamente:

- texto puro: `ACAD-000001`
- JSON: `{"codigo":"ACAD-000001"}` (também aceita `payload`, `serial`, `code`, `id`)
- URL: `https://.../item?codigo=ACAD-000001` ou `https://.../ACAD-000001`

Se o código não existir no cadastro, o app avisa e oferece **cadastro rápido**.

---

## 5. Importação de itens (CSV)

Modelo em `exemplo_itens.csv`. Cabeçalho aceito (separador `;` ou `,`):

```
codigo;nome;descricao;unidade_medida;estoque_atual;estoque_minimo
```

Sinônimos reconhecidos: `cod/sku/payload/serial` (código), `unidade/un/um`,
`estoque/saldo/quantidade/qtd` (saldo), `minimo/min`.

- Item **novo** → é criado com o saldo do arquivo.
- Item **já existente** → nome/descrição/unidade/mínimo são atualizados.
  O saldo só é sobrescrito se a opção *“Atualizar saldo dos itens já existentes”* estiver marcada
  (evita apagar movimentações feitas no chão de fábrica).

---

## 6. Sincronizar com o app do PC

Aba **Dados → ⬇ Exportar banco (.db SQLite)**: gera `almoxarifado_AAAAMMDD_HHMM.db`
na pasta *Downloads* do celular. Leve para o PC por cabo USB, nuvem ou e-mail.

O arquivo é um SQLite padrão com o schema:

```sql
CREATE TABLE itens (
  codigo         TEXT PRIMARY KEY,
  nome           TEXT NOT NULL,
  descricao      TEXT,
  unidade_medida TEXT DEFAULT 'UN',
  estoque_atual  REAL NOT NULL DEFAULT 0,
  estoque_minimo REAL DEFAULT 0,
  data_cadastro  DATETIME
);

CREATE TABLE movimentacoes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo_item  TEXT NOT NULL REFERENCES itens(codigo),
  tipo         TEXT NOT NULL,          -- 'ENTRADA' | 'SAIDA'
  quantidade   REAL NOT NULL,
  data_hora    DATETIME NOT NULL,
  usuario      TEXT,
  observacao   TEXT
);
```

Também é possível exportar `itens.csv` e `movimentacoes.csv` para abrir no Excel.

O caminho inverso (**Importar banco .db**) substitui os dados do celular pelo arquivo
enviado do PC — útil para distribuir o cadastro atualizado.

---

## 7. Onde ficam os dados

No próprio aparelho, em `IndexedDB → almox_pba → kv → dbfile` (o arquivo SQLite em bytes).
Nada é enviado para servidor algum.

⚠️ Consequências: limpar os dados do navegador/app apaga o estoque, e cada celular tem
seu próprio banco. **Exporte o `.db` periodicamente** como backup.

---

## 8. Testar no PC antes de publicar

Não abra por `file://` (Service Worker e WASM exigem servidor). Use:

```bash
python -m http.server 8080
```

e acesse `http://localhost:8080` (localhost é tratado como seguro, a câmera funciona).

---

## 9. Manutenção

- **Publicou mudanças e o celular não atualizou?** Suba a versão em `sw.js`
  (`CACHE_VERSION = 'almox-pba-v1.5.0'`) e em `APP_VERSION` no `js/app.js`.
- **Trocou o `js/usuarios.js` (cofre)?** Suba a `CACHE_VERSION` também — senão o celular
  segue usando o cofre velho que está no cache.
- **Trocar o ícone:** edite/rode `tools/gerar_icones.ps1`.
- **Atualizar bibliotecas:** substitua os arquivos em `vendor/`
  (sql.js e html5-qrcode) e suba a `CACHE_VERSION`.
