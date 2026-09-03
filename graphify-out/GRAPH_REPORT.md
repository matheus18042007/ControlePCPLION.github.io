# Graph Report - App Pcp lion fitness  (2026-09-03)

## Corpus Check
- 17 files · ~64,751 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1627 nodes · 4305 edges · 91 communities (26 shown, 55 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 67 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- app.js
- criarInstancia
- index.html — Controle PCP LION (app principal)
- nuvem.js
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
- r
- ht
- .append
- .getX
- .get
- sr
- ke
- ae
- gr
- .decode
- c
- be
- pr
- ze
- cr
- .toString
- .decode
- .encode
- j
- me
- p
- ie
- w
- je
- .decodeRow
- e
- et
- .getSize
- s
- .encode
- .parseInformation
- .substring
- T
- fr
- ct
- fe
- ot
- e
- oe
- x
- ce
- lt
- nt
- mb
- _
- it
- .setHints
- .encode
- m
- O
- Qe
- .charAt
- ar
- ge
- Nr
- ye
- a
- d
- le
- Va
- ma
- wt

## God Nodes (most connected - your core abstractions)
1. `_` - 110 edges
2. `f` - 64 edges
3. `c` - 50 edges
4. `p` - 41 edges
5. `criarInstancia()` - 37 edges
6. `sr` - 37 edges
7. `N` - 36 edges
8. `ligarEventos()` - 35 edges
9. `it` - 35 edges
10. `ke` - 33 edges

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

## Communities (91 total, 55 thin omitted)

### Community 0 - "app.js"
Cohesion: 0.10
Nodes (70): abrirCadastro(), abrirItem(), abrirModulo(), abrirMov(), acharCol(), agoraISO(), aoLerQR(), atualizarPrevia() (+62 more)

### Community 1 - "criarInstancia"
Cohesion: 0.13
Nodes (48): chave(), criarInstancia(), abrirBanco(), abrirCadastro(), apagarTudo(), aplicarLocal(), atualizarLinha(), enviarDaqui() (+40 more)

### Community 2 - "index.html — Controle PCP LION (app principal)"
Cohesion: 0.06
Nodes (52): admin.html — Cadastro de usuários (página), Auth.admin.abrir (definida em js/auth.js), Auth.admin.addUsuario (definida em js/auth.js), Auth.admin.criar (definida em js/auth.js), Auth.admin.serializar (definida em js/auth.js), Auth.admin.trocarNuvem (definida em js/auth.js), btnAbrir click handler — destrava cofre existente, btnAddUser click handler — salva/atualiza usuário (+44 more)

### Community 3 - "nuvem.js"
Cohesion: 0.11
Nodes (35): aparelho(), ativa(), cadastrarItem(), carregar(), contagem(), cadastrar(), definir(), enviarItens() (+27 more)

### Community 4 - "criarInstancia"
Cohesion: 0.19
Nodes (37): criarInstancia(), abrirBanco(), abrirCadastro(), abrirQtd(), apagarTudo(), aplicarLocal(), confirmarQtd(), enviarDaqui() (+29 more)

### Community 5 - "auth.js"
Cohesion: 0.19
Nodes (15): acharUsuario(), aleatorio(), cifrar(), cofre(), deB64(), decifrar(), derivar(), destrancar() (+7 more)

### Community 6 - "manifest.json"
Cohesion: 0.11
Nodes (18): background_color, categories, description, dir, display, icons, id, lang (+10 more)

### Community 7 - "ee"
Cohesion: 0.06
Nodes (4): bt, ee, ne, rt

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
Cohesion: 0.07
Nodes (7): c, he, K, Q, tt, xe, Z

### Community 20 - "f"
Cohesion: 0.07
Nodes (3): a, decodeBitmap(), f

### Community 21 - "sql-wasm.js"
Cohesion: 0.12
Nodes (34): ab(), ac(), b(), bb(), bc(), cb(), cc(), createNode() (+26 more)

### Community 22 - "r"
Cohesion: 0.07
Nodes (3): b, l, r()

### Community 23 - "ht"
Cohesion: 0.13
Nodes (4): ht, kt, vt, xt

### Community 24 - ".append"
Cohesion: 0.11
Nodes (3): or, y, zt

### Community 25 - ".getX"
Cohesion: 0.17
Nodes (3): de, dt, ft

### Community 30 - "gr"
Cohesion: 0.15
Nodes (3): br(), gr, Vr

### Community 32 - "c"
Cohesion: 0.15
Nodes (5): a(), c(), oa(), Qa(), sb()

### Community 51 - "s"
Cohesion: 0.18
Nodes (3): I, s, tr

### Community 66 - "mb"
Cohesion: 0.20
Nodes (7): d(), ha(), lc(), mb(), readlink(), symlink(), Zb()

### Community 69 - ".setHints"
Cohesion: 0.31
Nodes (3): constructor(), gt, lr

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
- **50 isolated node(s):** `name`, `short_name`, `description`, `id`, `start_url` (+45 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 330 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **55 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Sincronização em nuvem via Supabase (estoque compartilhado)` and `Senha do banco de dados PBA (nota)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `_` connect `_` to `ee`, `c`, `f`, `r`, `ht`, `.append`, `.getX`, `.get`, `sr`, `ke`, `ae`, `gr`, `.decode`, `be`, `pr`, `ze`, `cr`, `.toString`, `.decode`, `.encode`, `j`, `me`, `p`, `ie`, `w`, `je`, `.decodeRow`, `e`, `et`, `.getSize`, `s`, `.encode`, `.parseInformation`, `.substring`, `T`, `fr`, `ct`, `fe`, `ot`, `oe`, `x`, `ce`, `lt`, `nt`, `it`, `.setHints`, `.encode`, `m`, `O`, `Qe`, `.charAt`, `ar`, `ge`, `Nr`, `ye`, `d`, `le`, `wt`?**
  _High betweenness centrality (0.434) - this node is a cross-community bridge._
- **Why does `R()` connect `sql-wasm.js` to `a`, `Va`, `ma`, `.decodeRow`?**
  _High betweenness centrality (0.099) - this node is a cross-community bridge._
- **Why does `f` connect `f` to `s`, `_`, `w`, `.toString`?**
  _High betweenness centrality (0.078) - this node is a cross-community bridge._
- **What connects `name`, `short_name`, `description` to the rest of the system?**
  _50 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `app.js` be split into smaller, more focused modules?**
  _Cohesion score 0.10211267605633803 - nodes in this community are weakly interconnected._
- **Should `criarInstancia` be split into smaller, more focused modules?**
  _Cohesion score 0.13350340136054423 - nodes in this community are weakly interconnected._