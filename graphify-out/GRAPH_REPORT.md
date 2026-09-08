# Graph Report - App Pcp lion fitness  (2026-09-08)

## Corpus Check
- 18 files · ~58,235 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1722 nodes · 4459 edges · 93 communities (28 shown, 58 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 98 edges (avg confidence: 0.85)
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
- base.js
- Apple Touch Icon (PCP Lion, 180px)
- PWA Icon 192x192 (PCP Lion Logo)
- Maskable Adaptive Icon (512x512)
- c
- f
- sql-wasm.js
- r
- ht
- .toString
- criarInstancia
- N
- sr
- ke
- a
- gr
- .decode
- c
- be
- .get
- ze
- criarInstancia
- .encode
- er
- ve
- ft
- j
- me
- p
- ie
- .decodeRow
- je
- x
- .decode
- et
- at
- .getHeight
- .getSize
- cr
- .charAt
- T
- wt
- .getY
- ot
- e
- ar
- oe
- ce
- _
- .decodeRow
- mb
- .getX
- it
- ae
- w
- m
- le
- e
- lt
- ge
- push.js
- .decode
- b
- a
- index.ts
- nt
- .decode
- Va
- O
- ma
- Nr
- .encodeLayers
- yt

## God Nodes (most connected - your core abstractions)
1. `_` - 110 edges
2. `f` - 64 edges
3. `c` - 50 edges
4. `criarInstancia()` - 41 edges
5. `p` - 41 edges
6. `sr` - 37 edges
7. `N` - 36 edges
8. `criarInstancia()` - 35 edges
9. `criarInstancia()` - 35 edges
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
- `index.html — Controle PCP LION (app principal)` --references--> `js/app.js — banco SQLite, telas, scanner, import/export`  [EXTRACTED]
  index.html → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Fluxo de geração e distribuição do cofre (usuarios.js)** — admin, admin_gerar, admin_auth_admin_serializar, js_usuarios_js_module, js_auth_js_module [EXTRACTED 1.00]
- **Bundle de scripts carregados pelo index.html (runtime do Almoxarifado PBA + módulos)** — index, js_app_js_module, js_nuvem_js_module, js_auth_js_module, js_usuarios_js_module, js_contagem_js_module, js_eficiencia_js_module, vendor_sql_wasm_module, vendor_html5_qrcode_module [EXTRACTED 1.00]
- **Esquema de criptografia do cofre (AES-GCM + PBKDF2)** — readme_cofre_vault, readme_aes_gcm_encryption, readme_pbkdf2_derivation, js_usuarios_js_module [EXTRACTED 1.00]

## Communities (93 total, 58 thin omitted)

### Community 0 - "app.js"
Cohesion: 0.10
Nodes (63): abrirCadastro(), abrirItem(), abrirModulo(), abrirMov(), acharCol(), agoraISO(), aoLerQR(), atualizarPrevia() (+55 more)

### Community 1 - "criarInstancia"
Cohesion: 0.14
Nodes (40): chave(), criarInstancia(), abrirBanco(), abrirCadastro(), apagarTudo(), aplicarLocal(), atualizarLinha(), enviarDaqui() (+32 more)

### Community 2 - "index.html — Controle PCP LION (app principal)"
Cohesion: 0.06
Nodes (51): admin.html — Cadastro de usuários (página), Auth.admin.abrir (definida em js/auth.js), Auth.admin.addUsuario (definida em js/auth.js), Auth.admin.criar (definida em js/auth.js), Auth.admin.serializar (definida em js/auth.js), Auth.admin.trocarNuvem (definida em js/auth.js), btnAbrir click handler — destrava cofre existente, btnAddUser click handler — salva/atualiza usuário (+43 more)

### Community 3 - "req"
Cohesion: 0.08
Nodes (51): aparelho(), ativa(), cadastrarItem(), carregar(), contagem(), apagarFoto(), cadastrar(), definir() (+43 more)

### Community 4 - "criarInstancia"
Cohesion: 0.15
Nodes (40): criarInstancia(), abrirCadastro(), abrirQtd(), abrirVisor(), ainda(), apagarFotoDoItem(), apagarTudo(), aplicarLocal() (+32 more)

### Community 5 - "auth.js"
Cohesion: 0.19
Nodes (15): acharUsuario(), aleatorio(), cifrar(), cofre(), deB64(), decifrar(), derivar(), destrancar() (+7 more)

### Community 6 - "manifest.json"
Cohesion: 0.11
Nodes (18): background_color, categories, description, dir, display, icons, id, lang (+10 more)

### Community 7 - "ee"
Cohesion: 0.06
Nodes (5): bt, ee, ne, re, rt

### Community 8 - "PCP Lion PWA Icon (512x512)"
Cohesion: 0.40
Nodes (5): PCP Lion PWA Icon (512x512), Yellow Lion Head with Crown Motif, PCP Wordmark, manifest.json (PWA manifest), pcplion.ico (source icon asset)

### Community 9 - "PBA Legacy App Icon (512x512)"
Cohesion: 0.50
Nodes (4): PBA Legacy App Icon (512x512), Lion Logo App Icon (successor, pcplion.ico), PBA Wordmark, QR-Code Finder Pattern Motif

### Community 10 - "PBA Maskable App Icon (512px, superseded)"
Cohesion: 0.50
Nodes (4): PBA Maskable App Icon (512px, superseded), Android Adaptive Icon Maskable Safe Zone, PBA Brand Mark / Wordmark, QR-Code Finder Pattern Motif

### Community 13 - "base.js"
Cohesion: 0.19
Nodes (8): idbGet(), idbKeys(), idbOpen(), idbSet(), kit(), k, lerCsv(), semAcento()

### Community 19 - "c"
Cohesion: 0.07
Nodes (7): c, dr, K, Q, tt, xe, Z

### Community 21 - "sql-wasm.js"
Cohesion: 0.12
Nodes (34): ab(), ac(), b(), bb(), bc(), cb(), cc(), createNode() (+26 more)

### Community 23 - "ht"
Cohesion: 0.11
Nodes (4): ht, kt, vt, xt

### Community 24 - ".toString"
Cohesion: 0.13
Nodes (3): Qt, y, zt

### Community 25 - "criarInstancia"
Cohesion: 0.15
Nodes (38): clsStatus(), criarInstancia(), abrirBanco(), abrirNova(), acharFalta(), adicionarFalta(), aoDigitarCodigo(), apagarLocal() (+30 more)

### Community 30 - "gr"
Cohesion: 0.16
Nodes (3): br(), gr, Vr

### Community 31 - ".decode"
Cohesion: 0.18
Nodes (3): he, te, ue

### Community 32 - "c"
Cohesion: 0.15
Nodes (5): a(), c(), oa(), Qa(), sb()

### Community 36 - "criarInstancia"
Cohesion: 0.17
Nodes (22): criarInstancia(), abrirCopia(), acordarModulos(), baixarFila(), baixarNuvem(), bancosConhecidos(), carimbo(), carregarSQL() (+14 more)

### Community 48 - ".decode"
Cohesion: 0.15
Nodes (3): ir(), or, rr()

### Community 66 - "mb"
Cohesion: 0.20
Nodes (7): d(), ha(), lc(), mb(), readlink(), symlink(), Zb()

### Community 76 - "ge"
Cohesion: 0.17
Nodes (3): constructor(), ge, lr

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

## Knowledge Gaps
- **51 isolated node(s):** `name`, `short_name`, `description`, `id`, `start_url` (+46 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 338 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **58 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `_` connect `_` to `ee`, `c`, `f`, `r`, `ht`, `.toString`, `N`, `sr`, `ke`, `a`, `gr`, `.decode`, `be`, `.get`, `ze`, `.encode`, `er`, `ve`, `ft`, `j`, `me`, `p`, `ie`, `.decodeRow`, `je`, `x`, `.decode`, `et`, `at`, `.getHeight`, `.getSize`, `cr`, `.charAt`, `T`, `wt`, `.getY`, `ot`, `ar`, `oe`, `ce`, `.decodeRow`, `.getX`, `it`, `ae`, `w`, `m`, `le`, `e`, `lt`, `ge`, `.decode`, `b`, `nt`, `.decode`, `O`, `Nr`, `.encodeLayers`, `yt`?**
  _High betweenness centrality (0.346) - this node is a cross-community bridge._
- **Why does `R()` connect `sql-wasm.js` to `a`, `.decodeRow`, `Va`, `ma`?**
  _High betweenness centrality (0.070) - this node is a cross-community bridge._
- **Why does `f` connect `f` to `_`, `er`, `w`, `e`, `.attachStreamToVideo`, `.decodeOnceFromStream`, `a`?**
  _High betweenness centrality (0.050) - this node is a cross-community bridge._
- **What connects `name`, `short_name`, `description` to the rest of the system?**
  _51 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `app.js` be split into smaller, more focused modules?**
  _Cohesion score 0.09761295822676896 - nodes in this community are weakly interconnected._
- **Should `criarInstancia` be split into smaller, more focused modules?**
  _Cohesion score 0.14268292682926828 - nodes in this community are weakly interconnected._
- **Should `index.html — Controle PCP LION (app principal)` be split into smaller, more focused modules?**
  _Cohesion score 0.05803921568627451 - nodes in this community are weakly interconnected._