# Graph Report - App Pcp lion fitness  (2026-09-04)

## Corpus Check
- 23 files · ~106,178 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1712 nodes · 4529 edges · 89 communities (28 shown, 53 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 92 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- app.js
- criarInstancia
- index.html — Controle PCP LION (app principal)
- req
- criarInstancia
- auth.js
- manifest.json
- ee
- PCP Lion PWA Icon (512x512)
- PBA Legacy App Icon (512x512)
- PBA Maskable App Icon (512px, superseded)
- Auth.admin.removerUsuario (definida em js/auth.js)
- PBA Branding Mark
- Apple Touch Icon (PCP Lion, 180px)
- PWA Icon 192x192 (PCP Lion Logo)
- Maskable Adaptive Icon (512x512)
- c
- f
- sql-wasm.js
- b
- ht
- y
- criarInstancia
- N
- sr
- ke
- .getCount
- gr
- .decode
- c
- be
- pr
- ze
- .getHeight
- .encode
- .toString
- .decode
- .get
- j
- me
- p
- ie
- w
- je
- x
- .parseInformation
- et
- at
- e
- .getSize
- .append
- .substring
- T
- ct
- .getX
- _
- e
- oe
- ae
- ce
- mb
- ge
- it
- .decode
- .encode
- m
- O
- Qe
- .decodeRow
- we
- r
- push.js
- ye
- ft
- le
- a
- index.ts
- l
- BANCO DE DADOS MC PBA_3fd48885.md
- Va
- ma

## God Nodes (most connected - your core abstractions)
1. `_` - 110 edges
2. `f` - 64 edges
3. `c` - 50 edges
4. `criarInstancia()` - 45 edges
5. `p` - 41 edges
6. `criarInstancia()` - 39 edges
7. `sr` - 37 edges
8. `N` - 36 edges
9. `ligarEventos()` - 35 edges
10. `it` - 35 edges

## Surprising Connections (you probably didn't know these)
- `nuvemDot — indicador visual da situação da conexão com a nuvem` --semantically_similar_to--> `Sincronização em nuvem via Supabase (estoque compartilhado)`  [INFERRED] [semantically similar]
  index.html → README.md
- `btnExcluirItem — Excluir item do banco de dados (nuvem + local)` --semantically_similar_to--> `Função excluir_item (Supabase, transação única)`  [INFERRED] [semantically similar]
  index.html → README.md
- `View Dados — CSV, nuvem, cadastro manual, excluir item, exportar/importar .db` --semantically_similar_to--> `Exportação/Importação de banco .db para sincronizar com o PC`  [INFERRED] [semantically similar]
  index.html → README.md
- `View Dados — CSV, nuvem, cadastro manual, excluir item, exportar/importar .db` --semantically_similar_to--> `Importação de itens via CSV (codigo;nome;descricao;unidade_medida;estoque_atual;estoque_minimo)`  [INFERRED] [semantically similar]
  index.html → README.md
- `Senha do banco de dados PBA (nota)` --conceptually_related_to--> `Sincronização em nuvem via Supabase (estoque compartilhado)`  [AMBIGUOUS]
  BD/banco de dados PBA.txt → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Fluxo de geração e distribuição do cofre (usuarios.js)** — admin, admin_gerar, admin_auth_admin_serializar, js_usuarios_js_module, js_auth_js_module [EXTRACTED 1.00]
- **Bundle de scripts carregados pelo index.html (runtime do Almoxarifado PBA + módulos)** — index, js_app_js_module, js_nuvem_js_module, js_auth_js_module, js_usuarios_js_module, js_contagem_js_module, js_eficiencia_js_module, vendor_sql_wasm_module, vendor_html5_qrcode_module [EXTRACTED 1.00]
- **Esquema de criptografia do cofre (AES-GCM + PBKDF2)** — readme_cofre_vault, readme_aes_gcm_encryption, readme_pbkdf2_derivation, js_usuarios_js_module [EXTRACTED 1.00]

## Communities (89 total, 53 thin omitted)

### Community 0 - "app.js"
Cohesion: 0.10
Nodes (70): abrirCadastro(), abrirItem(), abrirModulo(), abrirMov(), acharCol(), agoraISO(), aoLerQR(), atualizarPrevia() (+62 more)

### Community 1 - "criarInstancia"
Cohesion: 0.13
Nodes (50): chave(), criarInstancia(), abrirBanco(), abrirCadastro(), apagarTudo(), aplicarLocal(), atualizarLinha(), enviarDaqui() (+42 more)

### Community 2 - "index.html — Controle PCP LION (app principal)"
Cohesion: 0.06
Nodes (52): admin.html — Cadastro de usuários (página), Auth.admin.abrir (definida em js/auth.js), Auth.admin.addUsuario (definida em js/auth.js), Auth.admin.criar (definida em js/auth.js), Auth.admin.serializar (definida em js/auth.js), Auth.admin.trocarNuvem (definida em js/auth.js), btnAbrir click handler — destrava cofre existente, btnAddUser click handler — salva/atualiza usuário (+44 more)

### Community 3 - "req"
Cohesion: 0.08
Nodes (49): aparelho(), ativa(), cadastrarItem(), carregar(), contagem(), apagarFoto(), cadastrar(), definir() (+41 more)

### Community 4 - "criarInstancia"
Cohesion: 0.14
Nodes (50): criarInstancia(), abrirBanco(), abrirCadastro(), abrirQtd(), abrirVisor(), ainda(), apagarFotoDoItem(), apagarTudo() (+42 more)

### Community 5 - "auth.js"
Cohesion: 0.19
Nodes (15): acharUsuario(), aleatorio(), cifrar(), cofre(), deB64(), decifrar(), derivar(), destrancar() (+7 more)

### Community 6 - "manifest.json"
Cohesion: 0.11
Nodes (18): background_color, categories, description, dir, display, icons, id, lang (+10 more)

### Community 7 - "ee"
Cohesion: 0.07
Nodes (4): bt, ee, rt, wt

### Community 8 - "PCP Lion PWA Icon (512x512)"
Cohesion: 0.40
Nodes (5): PCP Lion PWA Icon (512x512), Yellow Lion Head with Crown Motif, PCP Wordmark, manifest.json (PWA manifest), pcplion.ico (source icon asset)

### Community 9 - "PBA Legacy App Icon (512x512)"
Cohesion: 0.50
Nodes (4): PBA Legacy App Icon (512x512), Lion Logo App Icon (successor, pcplion.ico), PBA Wordmark, QR-Code Finder Pattern Motif

### Community 10 - "PBA Maskable App Icon (512px, superseded)"
Cohesion: 0.50
Nodes (4): PBA Maskable App Icon (512px, superseded), Android Adaptive Icon Maskable Safe Zone, PBA Brand Mark / Wordmark, QR-Code Finder Pattern Motif

### Community 19 - "c"
Cohesion: 0.06
Nodes (8): c, dr, he, Q, rr(), tt, xe, Z

### Community 20 - "f"
Cohesion: 0.07
Nodes (3): a, decodeBitmap(), f

### Community 21 - "sql-wasm.js"
Cohesion: 0.12
Nodes (34): ab(), ac(), b(), bb(), bc(), cb(), cc(), createNode() (+26 more)

### Community 23 - "ht"
Cohesion: 0.15
Nodes (3): ht, kt, vt

### Community 25 - "criarInstancia"
Cohesion: 0.14
Nodes (40): clsStatus(), criarInstancia(), abrirBanco(), abrirNova(), adicionarFalta(), aoDigitarCodigo(), apagarLocal(), enviarComponentesDaqui() (+32 more)

### Community 30 - "gr"
Cohesion: 0.15
Nodes (3): br(), gr, Vr

### Community 32 - "c"
Cohesion: 0.15
Nodes (5): a(), c(), oa(), Qa(), sb()

### Community 37 - ".encode"
Cohesion: 0.09
Nodes (3): cr, mr, wr

### Community 41 - "j"
Cohesion: 0.08
Nodes (3): ar, d, j

### Community 47 - "x"
Cohesion: 0.09
Nodes (4): h, mt, nt, x

### Community 53 - ".append"
Cohesion: 0.17
Nodes (3): jt, Qt, zt

### Community 59 - "_"
Cohesion: 0.05
Nodes (11): _, constructor(), gt, I, K, lr, lt, ot (+3 more)

### Community 66 - "mb"
Cohesion: 0.20
Nodes (7): d(), ha(), lc(), mb(), readlink(), symlink(), Zb()

### Community 77 - "push.js"
Cohesion: 0.54
Nodes (7): ativar(), chaveBinaria(), configurado(), desativar(), estado(), inscricaoAtual(), suportado()

### Community 81 - "a"
Cohesion: 0.32
Nodes (8): cd(), a(), gc(), ic(), Ra(), wb(), xb(), Yb()

### Community 85 - "Va"
Cohesion: 0.33
Nodes (6): close(), fc(), fsync(), na(), read(), Va()

### Community 87 - "ma"
Cohesion: 0.40
Nodes (5): ec(), jb(), ma(), Ta(), write()

## Ambiguous Edges - Review These
- `Sincronização em nuvem via Supabase (estoque compartilhado)` → `Senha do banco de dados PBA (nota)`  [AMBIGUOUS]
  BD/banco de dados PBA.txt · relation: conceptually_related_to

## Knowledge Gaps
- **54 isolated node(s):** `name`, `short_name`, `description`, `id`, `start_url` (+49 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 335 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **53 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Sincronização em nuvem via Supabase (estoque compartilhado)` and `Senha do banco de dados PBA (nota)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `_` connect `_` to `ee`, `c`, `f`, `b`, `ht`, `y`, `N`, `sr`, `ke`, `.getCount`, `gr`, `.decode`, `be`, `pr`, `ze`, `.getHeight`, `.encode`, `.toString`, `.decode`, `.get`, `j`, `me`, `p`, `ie`, `w`, `je`, `x`, `.parseInformation`, `et`, `at`, `e`, `.getSize`, `.append`, `.substring`, `T`, `ct`, `.getX`, `oe`, `ae`, `ce`, `ge`, `it`, `.decode`, `.encode`, `m`, `O`, `Qe`, `.decodeRow`, `we`, `r`, `ye`, `ft`, `le`, `l`?**
  _High betweenness centrality (0.365) - this node is a cross-community bridge._
- **Why does `R()` connect `sql-wasm.js` to `a`, `Va`, `ma`, `x`?**
  _High betweenness centrality (0.065) - this node is a cross-community bridge._
- **Why does `f` connect `f` to `e`, `_`, `w`, `.toString`?**
  _High betweenness centrality (0.039) - this node is a cross-community bridge._
- **What connects `name`, `short_name`, `description` to the rest of the system?**
  _54 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `app.js` be split into smaller, more focused modules?**
  _Cohesion score 0.10211267605633803 - nodes in this community are weakly interconnected._
- **Should `criarInstancia` be split into smaller, more focused modules?**
  _Cohesion score 0.12941176470588237 - nodes in this community are weakly interconnected._