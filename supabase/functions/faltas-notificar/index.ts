// ============================================================
//  Controle PCP LION - Edge Function "faltas-notificar"
//
//  Quem chama: o app, toda vez que uma falta e registrada
//  (js/faltas.js -> Nuvem.push.notificar).
//
//  O que faz: olha o cooldown de 1 min em faltas_notif_estado.
//  Se ja passou (ou nunca enviou) e existem faltas pendentes,
//  manda UMA notificacao agregada para todos os aparelhos
//  inscritos em push_subscriptions e marca as faltas como
//  notificadas. Se nao passou, responde sem enviar nada.
//
//  Deploy:
//    supabase functions deploy faltas-notificar
//    supabase secrets set VAPID_PUBLIC=... VAPID_PRIVATE=... VAPID_SUBJECT=mailto:voce@empresa.com
// ============================================================

import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const COOLDOWN_MIN = 1;
const MODULO = "faltas";
const LOTE = 100;

const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC") ?? "";
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:pcp@lionfitness.com";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* carimbo em toda resposta: o app usa para saber se o deploy e o atual */
const FN_VERSION = "1.20.0";

function responder(corpo: unknown, status = 200) {
  if (corpo && typeof corpo === "object") corpo = { ...corpo, versao: FN_VERSION };
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  let modulo = MODULO;
  let forcar = false;
  try {
    const body = await req.json();
    if (body && typeof body.modulo === "string" && body.modulo) modulo = body.modulo;
    if (body && body.forcar) forcar = true;
  } catch (_) { /* corpo vazio: usa o padrao */ }

  const agora = new Date();

  // ---------- 1. cooldown ----------
  const { data: estado, error: e1 } = await db
    .from("faltas_notif_estado")
    .select("ultimo_envio")
    .eq("modulo", modulo)
    .maybeSingle();

  if (e1) return responder({ erro: e1.message }, 500);

  const ultimo = estado?.ultimo_envio ? new Date(estado.ultimo_envio) : null;
  const proximo = ultimo ? new Date(ultimo.getTime() + COOLDOWN_MIN * 60000) : null;

  // ---------- 2. faltas pendentes ----------
  /* forcar (botao "Notificar faltas"): manda TODAS as faltas em aberto do
     modulo, mesmo as ja notificadas, e ignora o cooldown */
  let q = db
    .from("faltas")
    .select("codigo, nome, qtd")
    .eq("modulo", modulo)
    .is("suprida_em", null);
  if (!forcar) q = q.is("notificada_em", null);
  const { data: pendentes, error: e2 } = await q
    .order("criado_em", { ascending: false });

  if (e2) return responder({ erro: e2.message }, 500);

  const lista = pendentes ?? [];

  if (!lista.length) {
    return responder({ enviadas: 0, pendentes: 0, proximoEnvioEm: proximo });
  }

  if (!forcar && proximo && proximo > agora) {
    // ainda no cooldown: as faltas continuam pendentes e vao junto no proximo flush
    return responder({ enviadas: 0, pendentes: lista.length, proximoEnvioEm: proximo });
  }

  // ---------- 3. texto agregado ----------
  const titulo = lista.length === 1
    ? "1 nova falta"
    : `${lista.length} novas faltas`;

  const linhas = lista.slice(0, 3).map((f) => {
    const qtd = Number(f.qtd) || 0;
    return `${f.codigo} ${f.nome || ""}`.trim() + (qtd ? ` (${qtd})` : "");
  });
  if (lista.length > 3) linhas.push(`e mais ${lista.length - 3}...`);
  const corpo = linhas.join("\n");

  // ---------- 4. fan-out ----------
  const { data: subs, error: e3 } = await db
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth");

  if (e3) return responder({ erro: e3.message }, 500);

  const payload = JSON.stringify({ titulo, corpo });
  const mortas: string[] = [];
  const erros: string[] = [];
  let enviadas = 0;

  const todas = subs ?? [];
  for (let i = 0; i < todas.length; i += LOTE) {
    const fatia = todas.slice(i, i + LOTE);
    await Promise.all(fatia.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
        );
        enviadas++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        erros.push(`${status ?? "?"}: ${(err as Error).message}`.slice(0, 200));
        // 404/410 = aparelho desinstalou o app ou revogou a permissao
        if (status === 404 || status === 410) mortas.push(s.endpoint);
      }
    }));
  }

  if (mortas.length) {
    await db.from("push_subscriptions").delete().in("endpoint", mortas);
  }

  // ---------- 5. marca como notificadas + reinicia o cooldown ----------
  /* so queima a fila se alguem recebeu de verdade. Se todo o fan-out falhou
     (VAPID errada, servico de push fora), as faltas continuam pendentes e
     entram no proximo disparo - senao a notificacao some sem ninguem ver. */
  if (enviadas > 0) {
    await db
      .from("faltas")
      .update({ notificada_em: agora.toISOString() })
      .eq("modulo", modulo)
      .is("notificada_em", null)
      .is("suprida_em", null);

    await db
      .from("faltas_notif_estado")
      .upsert({ modulo, ultimo_envio: agora.toISOString() }, { onConflict: "modulo" });
  }

  return responder({
    enviadas,
    pendentes: 0,
    removidas: mortas.length,
    inscritos: todas.length,
    erros,
    proximoEnvioEm: new Date(agora.getTime() + COOLDOWN_MIN * 60000),
  });
});
