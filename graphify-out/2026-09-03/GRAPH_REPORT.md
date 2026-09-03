# Graph Report - App Pcp lion fitness  (2026-09-03)

## Corpus Check
- 24 files · ~30,078 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 314 nodes · 780 edges · 19 communities (11 shown, 5 thin omitted)
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 60 edges (avg confidence: 0.85)
- Token cost: 344,102 input · 0 output

## Community Hubs (Navigation)
- Nucleo Almoxarifado PBA
- Modulo Eficiencia VG
- Shell HTML e Documentacao
- Camada de Sincronia Supabase
- Modulos de Contagem VG
- Cofre de Autenticacao
- Manifesto PWA e Referencias
- Painel Admin de Usuarios
- Icones Lion Atuais
- Icone PBA 512 Antigo
- Icone PBA Maskable Antigo
- Remocao de Usuario Admin
- Icone PBA 192 Antigo
- Apple Touch Icon
- Icone PWA 192
- Icone Maskable 512

## God Nodes (most connected - your core abstractions)
1. `criarInstancia()` - 37 edges
2. `ligarEventos()` - 35 edges
3. `criarInstancia()` - 32 edges
4. `req()` - 20 edges
5. `ligarEventos()` - 19 edges
6. `abrirItem()` - 16 edges
7. `ligarEventos()` - 16 edges
8. `index.html — Controle PCP LION (app principal)` - 16 edges
9. `toast()` - 15 edges
10. `confirmarMov()` - 15 edges

## Surprising Connections (you probably didn't know these)
- `nuvemDot — indicador visual da situação da conexão com a nuvem` --semantically_similar_to--> `Sincronização em nuvem via Supabase (estoque compartilhado)`  [INFERRED] [semantically similar]
  index.html → README.md
- `Senha do banco de dados PBA (nota)` --conceptually_related_to--> `Sincronização em nuvem via Supabase (estoque compartilhado)`  [AMBIGUOUS]
  BD/banco de dados PBA.txt → README.md
- `btnExcluirItem — Excluir item do banco de dados (nuvem + local)` --semantically_similar_to--> `Função excluir_item (Supabase, transação única)`  [INFERRED] [semantically similar]
  index.html → README.md
- `View Dados — CSV, nuvem, cadastro manual, excluir item, exportar/importar .db` --semantically_similar_to--> `Importação de itens via CSV (codigo;nome;descricao;unidade_medida;estoque_atual;estoque_minimo)`  [INFERRED] [semantically similar]
  index.html → README.md
- `View Dados — CSV, nuvem, cadastro manual, excluir item, exportar/importar .db` --semantically_similar_to--> `Exportação/Importação de banco .db para sincronizar com o PC`  [INFERRED] [semantically similar]
  index.html → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Fluxo de geração e distribuição do cofre (usuarios.js)** — admin, admin_gerar, admin_auth_admin_serializar, js_usuarios_js_module, js_auth_js_module [EXTRACTED 1.00]
- **Esquema de criptografia do cofre (AES-GCM + PBKDF2)** — readme_cofre_vault, readme_aes_gcm_encryption, readme_pbkdf2_derivation, js_usuarios_js_module [EXTRACTED 1.00]
- **Bundle de scripts carregados pelo index.html (runtime do Almoxarifado PBA + módulos)** — index, js_app_js_module, js_nuvem_js_module, js_auth_js_module, js_usuarios_js_module, js_contagem_js_module, js_eficiencia_js_module, vendor_sql_wasm_module, vendor_html5_qrcode_module [EXTRACTED 1.00]

## Communities (19 total, 5 thin omitted)

### Community 0 - "Nucleo Almoxarifado PBA"
Cohesion: 0.10
Nodes (70): abrirCadastro(), abrirItem(), abrirModulo(), abrirMov(), acharCol(), agoraISO(), aoLerQR(), atualizarPrevia() (+62 more)

### Community 1 - "Modulo Eficiencia VG"
Cohesion: 0.13
Nodes (48): chave(), criarInstancia(), abrirBanco(), abrirCadastro(), apagarTudo(), aplicarLocal(), atualizarLinha(), enviarDaqui() (+40 more)

### Community 2 - "Shell HTML e Documentacao"
Cohesion: 0.08
Nodes (39): admin.html — Painel gerador do cofre (js/usuarios.js), Senha do banco de dados PBA (nota), index.html — Controle PCP LION (app principal), btnExcluirItem — Excluir item do banco de dados (nuvem + local), Hub de funções — seletor de módulos (Almoxarifado, Contagem, Eficiência), Tela de login (usuário/senha, manter conectado), nuvemDot — indicador visual da situação da conexão com a nuvem, Sheet de Cadastro de item (código, nome, unidade, mínimo, saldo) (+31 more)

### Community 3 - "Camada de Sincronia Supabase"
Cohesion: 0.11
Nodes (35): aparelho(), ativa(), cadastrarItem(), carregar(), contagem(), cadastrar(), definir(), enviarItens() (+27 more)

### Community 4 - "Modulos de Contagem VG"
Cohesion: 0.19
Nodes (37): criarInstancia(), abrirBanco(), abrirCadastro(), abrirQtd(), apagarTudo(), aplicarLocal(), confirmarQtd(), enviarDaqui() (+29 more)

### Community 5 - "Cofre de Autenticacao"
Cohesion: 0.19
Nodes (15): acharUsuario(), aleatorio(), cifrar(), cofre(), deB64(), decifrar(), derivar(), destrancar() (+7 more)

### Community 6 - "Manifesto PWA e Referencias"
Cohesion: 0.11
Nodes (18): background_color, categories, description, dir, display, icons, id, lang (+10 more)

### Community 7 - "Painel Admin de Usuarios"
Cohesion: 0.21
Nodes (13): admin.html — Cadastro de usuários (página), Auth.admin.abrir (definida em js/auth.js), Auth.admin.addUsuario (definida em js/auth.js), Auth.admin.criar (definida em js/auth.js), Auth.admin.serializar (definida em js/auth.js), Auth.admin.trocarNuvem (definida em js/auth.js), btnAbrir click handler — destrava cofre existente, btnAddUser click handler — salva/atualiza usuário (+5 more)

### Community 8 - "Icones Lion Atuais"
Cohesion: 0.40
Nodes (5): PCP Lion PWA Icon (512x512), Yellow Lion Head with Crown Motif, PCP Wordmark, manifest.json (PWA manifest), pcplion.ico (source icon asset)

### Community 9 - "Icone PBA 512 Antigo"
Cohesion: 0.50
Nodes (4): PBA Legacy App Icon (512x512), Lion Logo App Icon (successor, pcplion.ico), PBA Wordmark, QR-Code Finder Pattern Motif

### Community 10 - "Icone PBA Maskable Antigo"
Cohesion: 0.50
Nodes (4): PBA Maskable App Icon (512px, superseded), Android Adaptive Icon Maskable Safe Zone, PBA Brand Mark / Wordmark, QR-Code Finder Pattern Motif

## Ambiguous Edges - Review These
- `Senha do banco de dados PBA (nota)` → `Sincronização em nuvem via Supabase (estoque compartilhado)`  [AMBIGUOUS]
  BD/banco de dados PBA.txt · relation: conceptually_related_to

## Knowledge Gaps
- **50 isolated node(s):** `name`, `short_name`, `description`, `id`, `start_url` (+45 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 63 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Senha do banco de dados PBA (nota)` and `Sincronização em nuvem via Supabase (estoque compartilhado)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `admin.html — Cadastro de usuários (página)` connect `Painel Admin de Usuarios` to `Shell HTML e Documentacao`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **Are the 12 inferred relationships involving `ligarEventos()` (e.g. with `atualizarPrevia()` and `confirmarMov()`) actually correct?**
  _`ligarEventos()` has 12 INFERRED edges - model-reasoned connections that need verification._
- **Are the 10 inferred relationships involving `ligarEventos()` (e.g. with `apagarTudo()` and `confirmarQtd()`) actually correct?**
  _`ligarEventos()` has 10 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `short_name`, `description` to the rest of the system?**
  _50 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Nucleo Almoxarifado PBA` be split into smaller, more focused modules?**
  _Cohesion score 0.10211267605633803 - nodes in this community are weakly interconnected._
- **Should `Modulo Eficiencia VG` be split into smaller, more focused modules?**
  _Cohesion score 0.13350340136054423 - nodes in this community are weakly interconnected._