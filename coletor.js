/* =====================================================================
   RADAR DE TESES COLETIVAS  -  coletor.js
   Consulta a API Pública do DataJud (CNJ) e gera:
     - painel.html       (abre por duplo-clique, sem internet)
     - painel_web.html   (versão para publicar como link web)
     - dados.json        (dados crus, para enriquecimento futuro)
   Uso:  duplo-clique em "atualizar.bat"  (ou:  node coletor.js)
   ===================================================================== */

const fs = require("fs");
const path = require("path");

/* ------------------------- CONFIGURAÇÃO ------------------------------ */
const CONFIG = {
  // Chave pública do DataJud. MUDA de tempos em tempos.
  // Se der erro 401, pegue a nova em:
  //   http://datajud-wiki.cnj.jus.br/api-publica/acesso/
  API_KEY: "cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==",

  // Tribunais consultados. Acrescente "trf1" p/ servidores federais (1ª Região = GO e TO).
  TRIBUNAIS: ["tjgo", "tjto"],

  MAX_POR_GRUPO: 300,   // processos por grupo de busca, por tribunal (100 por página)
  ANO_MINIMO: 2019,     // traz só ajuizados a partir deste ano
};

const BASE = "https://api-publica.datajud.cnj.jus.br/api_publica_";

/* Classes (TPU) --------------------------------------------------------------- */
const CLASSES_COLETIVAS_EXEC = [15160, 15161]; // Cumpr. de Sentença de Ações Coletivas (def./prov.)
const CLASSE_MS_COLETIVO = [119];              // Mandado de Segurança Coletivo
const CLASSE_ACAO_COLETIVA = [63];             // Ação Civil Coletiva
const CLASSE_ACP = [65];                       // Ação Civil Pública
const NOME_CLASSE = {
  15160: "Cumpr. Sentença Ações Coletivas", 15161: "Cumpr. Provisório Ações Coletivas",
  119: "Mandado de Segurança Coletivo", 63: "Ação Civil Coletiva", 65: "Ação Civil Pública",
};

/* Estado / rótulo por tribunal ------------------------------------------------ */
const TRIBUNAL_INFO = {
  TJGO: { uf: "GO", estado: "Goiás", justica: "Estadual", label: "Goiás · TJGO" },
  TJTO: { uf: "TO", estado: "Tocantins", justica: "Estadual", label: "Tocantins · TJTO" },
  TRF1: { uf: "1ª Reg.", estado: "Justiça Federal", justica: "Federal", label: "Federal · TRF1" },
};

/* Palavras-chave p/ classificar a frente pelo assunto ------------------------- */
const KW = {
  servidores: ["irredutibilidade", "data base", "data-base", "piso salarial", "progress",
    "revisão geral", "revisao geral", "subsíd", "subsid", "policial", "policiais", "vencimento",
    "remuneraç", "gratificaç", "quinquên", "quinquen", "adicional", "servidor", "reajuste",
    "urv", "proventos", "verba", "13º", "décimo terceiro", "promoção", "promocao"],
  consumidor: ["consumidor", "inscrição indevida", "inclusão indevida", "cadastro de inadimplentes",
    "cobrança indevida", "cobranca indevida", "repetição de indébito", "repeticao de indebito",
    "tarifa", "telefonia", "energia", "juros", "cláusula", "clausula", "cartão", "cartao",
    "plano de saúde", "plano de saude", "empréstimo", "emprestimo", "financiamento"],
  seguros: ["seguro", "cobertura", "sinistro", "dpvat", "apólice", "apolice"],
};
// Consórcio / propaganda enganosa (trilha prioritária)
const KW_CONSORCIO = ["consórcio", "consorcio", "propaganda enganosa", "publicidade enganosa",
  "publicidade abusiva", "oferta e publicidade"];

/* --------------------------- HTTP + paginação ------------------------ */
async function buscar(alias, body) {
  const res = await fetch(BASE + alias + "/_search", {
    method: "POST",
    headers: { Authorization: "APIKey " + CONFIG.API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " (" + alias + ") " + (await res.text()).slice(0, 160));
  return res.json();
}
// Repete a consulta em erros transitórios (503/DNS, 429, 5xx, timeouts) antes de desistir do grupo.
async function buscarComRetry(alias, body, tentativas = 4) {
  let ultimoErro;
  for (let t = 0; t < tentativas; t++) {
    try { return await buscar(alias, body); }
    catch (e) {
      ultimoErro = e;
      const msg = String((e && e.message) || e);
      const transitorio = /HTTP (429|500|502|503|504|529)|DNS|fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket|network|timeout/i.test(msg);
      if (!transitorio || t === tentativas - 1) throw e;
      const espera = 800 * Math.pow(2, t); // 0.8s, 1.6s, 3.2s
      console.log("   ~ retry " + (t + 1) + "/" + (tentativas - 1) + " (" + msg.slice(0, 60) + ") em " + espera + "ms");
      await new Promise((ok) => setTimeout(ok, espera));
    }
  }
  throw ultimoErro;
}
async function coletarGrupo(alias, filtro, frenteForcada) {
  const out = [];
  let searchAfter = null;
  const paginas = Math.ceil(CONFIG.MAX_POR_GRUPO / 100);
  for (let p = 0; p < paginas; p++) {
    const body = {
      size: 100,
      _source: ["numeroProcesso", "tribunal", "grau", "classe", "assuntos", "orgaoJulgador",
        "dataAjuizamento", "movimentos", "sistema"],
      query: filtro, sort: [{ dataAjuizamento: { order: "desc" } }],
    };
    if (searchAfter) body.search_after = searchAfter;
    let r; try { r = await buscarComRetry(alias, body); } catch (e) { console.log("   ! " + e.message); break; }
    const hits = (r.hits && r.hits.hits) || [];
    if (!hits.length) break;
    for (const h of hits) out.push({ src: h._source, frenteForcada });
    searchAfter = hits[hits.length - 1].sort;
    if (hits.length < 100) break;
    await new Promise((ok) => setTimeout(ok, 130));
  }
  return out;
}

/* --------------------------- utilidades ------------------------------ */
function formatarNumero(n) {
  if (!n || n.length !== 20) return n || "";
  return n.slice(0,7)+"-"+n.slice(7,9)+"."+n.slice(9,13)+"."+n.slice(13,14)+"."+n.slice(14,16)+"."+n.slice(16,20);
}
function anoDe(d) { return (d && d.length >= 4) ? (parseInt(d.slice(0,4),10)||0) : 0; }
function dataBR(d) { return (d && d.length >= 8) ? d.slice(6,8)+"/"+d.slice(4,6)+"/"+d.slice(0,4) : ""; }
function normal(s) { return (s||"").toString().toLowerCase(); }
function algum(txt, lista) { return lista.some((k) => txt.includes(k)); }

function faseDe(c) {
  if (CLASSES_COLETIVAS_EXEC.includes(c)) return { nome: "Execução (coletiva)", peso: 100 };
  if (c === 12078) return { nome: "Execução (Fazenda)", peso: 95 };
  if (c === 156 || c === 157) return { nome: "Execução (individual)", peso: 60 };
  return { nome: "Conhecimento", peso: 30 };
}
function ultimoMovimento(movs) {
  if (!Array.isArray(movs) || !movs.length) return { nome: "", data: "" };
  const ord = movs.filter((m) => m.dataHora).sort((a,b) => (a.dataHora < b.dataHora ? 1 : -1));
  const m = ord[0] || movs[movs.length-1];
  return { nome: m.nome || "", data: (m.dataHora||"").slice(0,10) };
}
function temTransito(movs) {
  const t = (movs||[]).map((m)=>normal(m.nome)).join(" | ");
  return t.includes("trânsito em julgado") || t.includes("transito em julgado");
}

/* frente + trilha + prioridade */
function classificar(assuntosTxt, classeCod, tribunal, frenteForcada) {
  const t = normal(assuntosTxt);
  const frentes = new Set();
  if (frenteForcada) frentes.add(frenteForcada);
  for (const f of ["servidores","consumidor","seguros"]) if (algum(t, KW[f])) frentes.add(f);
  if (CLASSE_MS_COLETIVO.includes(classeCod)) frentes.add("servidores");
  if (CLASSES_COLETIVAS_EXEC.includes(classeCod) && frentes.size === 0) frentes.add("servidores");

  const ehConsorcio = algum(t, KW_CONSORCIO);
  if (ehConsorcio) frentes.add("consumidor");

  // trilha (categoria principal) + prioridade
  let trilha = "Outros", prioridade = false;
  const estadual = tribunal === "TJGO" || tribunal === "TJTO";
  if (ehConsorcio) { trilha = "Consórcio"; prioridade = true; }
  else if (frentes.has("servidores") && estadual) { trilha = "Servidores estaduais"; prioridade = true; }
  else if (frentes.has("seguros")) { trilha = "Seguros"; }
  else if (frentes.has("consumidor")) { trilha = "Consumidor"; }
  return { frentes: [...frentes], trilha, prioridade };
}

/* ------------------------------ main --------------------------------- */
(async function main() {
  console.log("== RADAR DE TESES COLETIVAS ==  chave ..." + CONFIG.API_KEY.slice(-6));
  const anoGte = String(CONFIG.ANO_MINIMO) + "0101000000";
  const brutos = [];

  const termosConsumo = ["Direito do Consumidor","Inclusão Indevida em Cadastro de Inadimplentes",
    "Cobrança indevida","Repetição de indébito","Práticas Abusivas","Cláusulas Abusivas",
    "Bancários","Cartão de Crédito","Empréstimo consignado","Fornecimento de Energia Elétrica",
    "Telefonia","Planos de Saúde","Tarifas"];
  const termosConsorcio = ["Consórcio","Propaganda Enganosa","Publicidade Enganosa",
    "Publicidade Abusiva","Oferta e Publicidade"];

  for (const alias of CONFIG.TRIBUNAIS) {
    console.log("\n[" + alias.toUpperCase() + "]");

    // 1) Servidores estaduais: execuções coletivas + MS coletivo + ação coletiva
    let f = { bool: { must: [{ terms: { "classe.codigo": [...CLASSES_COLETIVAS_EXEC, ...CLASSE_MS_COLETIVO, ...CLASSE_ACAO_COLETIVA] } }],
      filter: [{ range: { dataAjuizamento: { gte: anoGte } } }] } };
    let r = await coletarGrupo(alias, f, null);
    console.log("  - Coletivas/MS (servidores): " + r.length); brutos.push(...r);

    // 2) CONSÓRCIO: ACP / coletiva / execução coletiva com assunto de consórcio ou propaganda enganosa
    f = { bool: {
      must: [{ terms: { "classe.codigo": [...CLASSE_ACP, ...CLASSE_ACAO_COLETIVA, ...CLASSES_COLETIVAS_EXEC] } }],
      should: termosConsorcio.map((tt)=>({ match_phrase: { "assuntos.nome": tt } })), minimum_should_match: 1,
      filter: [{ range: { dataAjuizamento: { gte: anoGte } } }] } };
    r = await coletarGrupo(alias, f, "consumidor");
    console.log("  - Consórcio (ACP/CDC): " + r.length); brutos.push(...r);

    // 3) Consumidor geral (ACP)
    f = { bool: {
      must: [{ terms: { "classe.codigo": [...CLASSE_ACP, ...CLASSE_ACAO_COLETIVA] } }],
      should: termosConsumo.map((tt)=>({ match_phrase: { "assuntos.nome": tt } })), minimum_should_match: 1,
      filter: [{ range: { dataAjuizamento: { gte: anoGte } } }] } };
    r = await coletarGrupo(alias, f, "consumidor");
    console.log("  - Consumidor geral (ACP): " + r.length); brutos.push(...r);

    // 4) Seguros (assunto)
    f = { bool: { must: [{ match_phrase: { "assuntos.nome": "Seguro" } }],
      filter: [{ terms: { "classe.codigo": [...CLASSES_COLETIVAS_EXEC, ...CLASSE_ACP, ...CLASSE_ACAO_COLETIVA, 156, 436, 7] } },
        { range: { dataAjuizamento: { gte: anoGte } } }] } };
    r = await coletarGrupo(alias, f, "seguros");
    console.log("  - Seguros (assunto): " + r.length); brutos.push(...r);
  }

  /* ----- normalizar + deduplicar + ranquear ----- */
  const map = new Map();
  for (const b of brutos) {
    const s = b.src;
    if (anoDe(s.dataAjuizamento) < CONFIG.ANO_MINIMO) continue;
    const chave = (s.tribunal||"") + "-" + (s.numeroProcesso||"");
    if (map.has(chave)) { if (b.frenteForcada) { const e = map.get(chave); if (!e.frentes.includes(b.frenteForcada)) e.frentes.push(b.frenteForcada); } continue; }

    const assuntos = (s.assuntos||[]).map((a)=>a.nome).filter(Boolean);
    const assuntosTxt = assuntos.join("; ");
    const classeCod = (s.classe && s.classe.codigo) || 0;
    const fase = faseDe(classeCod);
    const um = ultimoMovimento(s.movimentos);
    const transito = temTransito(s.movimentos);
    const cls = classificar(assuntosTxt, classeCod, s.tribunal, b.frenteForcada);
    const info = TRIBUNAL_INFO[s.tribunal] || { uf: "?", estado: s.tribunal, justica: "?", label: s.tribunal };

    let score = fase.peso + Math.max(0, anoDe(s.dataAjuizamento) - CONFIG.ANO_MINIMO) * 2;
    if (transito) score += 15;
    if (cls.prioridade) score += 300;

    map.set(chave, {
      numero: s.numeroProcesso, numeroFmt: formatarNumero(s.numeroProcesso),
      tribunal: s.tribunal, tribunalLabel: info.label, uf: info.uf, justica: info.justica,
      grau: s.grau, classeCod, classe: (s.classe && s.classe.nome) || NOME_CLASSE[classeCod] || String(classeCod),
      assuntos, assuntosTxt, orgao: (s.orgaoJulgador && s.orgaoJulgador.nome) || "",
      sistema: (s.sistema && s.sistema.nome) || "",
      ajuizadoBR: dataBR(s.dataAjuizamento), ajuizadoSort: (s.dataAjuizamento||"").slice(0,8),
      ultMov: um.nome, ultMovData: um.data, transito,
      frentes: cls.frentes, trilha: cls.trilha, prioridade: cls.prioridade, fase: fase.nome, score,
    });
  }
  let registros = [...map.values()];

  // Resiliência: se um tribunal voltou vazio (o índice do CNJ às vezes fica sem dados
  // durante reindexação), reaproveita a última coleta para não zerar aquele estado.
  let anterior = null;
  try { anterior = JSON.parse(fs.readFileSync(path.join(__dirname,"dados.json"),"utf8")); } catch(e){}
  const comDados = new Set(registros.map((r)=>r.tribunal));
  const vazios = [];
  for (const alias of CONFIG.TRIBUNAIS) {
    const TT = alias.toUpperCase();
    if (!comDados.has(TT)) {
      vazios.push(TT);
      if (anterior && Array.isArray(anterior.registros)) {
        const ant = anterior.registros.filter((r)=>r.tribunal===TT);
        if (ant.length) { ant.forEach((r)=>{r.stale=true;}); registros = registros.concat(ant);
          console.log("  (mantidos "+ant.length+" registros anteriores de "+TT+" — indice vazio agora)"); }
      }
    }
  }
  registros.sort((a,b)=>b.score-a.score);

  const cont = (fn) => registros.reduce((m,r)=>{const k=fn(r)||"?";m[k]=(m[k]||0)+1;return m;},{});
  const meta = {
    geradoEm: new Date().toLocaleString("pt-BR"),
    total: registros.length,
    prioritarios: registros.filter((r)=>r.prioridade).length,
    tribunaisVazios: vazios,
    porTribunal: cont((r)=>r.tribunal), porTrilha: cont((r)=>r.trilha), porFase: cont((r)=>r.fase),
  };

  fs.writeFileSync(path.join(__dirname,"dados.json"), JSON.stringify({meta,registros},null,2), "utf8");
  const dj = "window.DADOS="+JSON.stringify(registros)+";";
  const mj = "window.META="+JSON.stringify(meta)+";";
  const body = BODY.replace("/*__DADOS__*/", dj).replace("/*__META__*/", mj);
  const head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>Radar de Teses Coletivas — GO/TO</title><style>'+STYLE+'</style>';
  fs.writeFileSync(path.join(__dirname,"painel.html"),
    '<!doctype html><html lang="pt-br"><head>'+head+'</head><body>'+body+'</body></html>', "utf8");
  fs.writeFileSync(path.join(__dirname,"painel_web.html"), '<style>'+STYLE+'</style>'+body, "utf8");

  console.log("\n== PRONTO =="); console.log("Total: "+registros.length+" | Prioritários: "+meta.prioritarios);
  console.log("Por trilha: "+JSON.stringify(meta.porTrilha));
  console.log("Arquivos: painel.html, painel_web.html, dados.json");
})().catch((e)=>{ console.error("FALHA:", e.message); process.exit(1); });

/* ============================ DESIGN ================================= */
const STYLE = `
:root{
  --bg:#f5f7fa; --card:#ffffff; --card2:#fbfcfe; --line:#e3e8ef; --txt:#16202c; --mut:#5c6b7c;
  --acc:#1f5fb0; --acc-soft:rgba(31,95,176,.10);
  --exec:#137a44; --exec-bg:rgba(19,122,68,.12);
  --liq:#a86a12; --liq-bg:rgba(168,106,18,.12);
  --conh:#5c6b7c; --conh-bg:rgba(92,107,124,.10);
  --t-consorcio:#a8560f; --t-consorcio-bg:rgba(168,86,15,.12);
  --t-serv:#1f5fb0; --t-serv-bg:rgba(31,95,176,.12);
  --t-cons:#137a44; --t-cons-bg:rgba(19,122,68,.10);
  --t-seg:#6d4bb0; --t-seg-bg:rgba(109,75,176,.12);
  --t-out:#5c6b7c; --t-out-bg:rgba(92,107,124,.10);
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0d141c; --card:#141e2a; --card2:#111a25; --line:#243244; --txt:#e7eef6; --mut:#93a4b6;
  --acc:#5aa2ff; --acc-soft:rgba(90,162,255,.14);
  --exec:#43d081; --exec-bg:rgba(67,208,129,.14);
  --liq:#e0a83a; --liq-bg:rgba(224,168,58,.14);
  --conh:#93a4b6; --conh-bg:rgba(147,164,182,.12);
  --t-consorcio:#f0a35a; --t-consorcio-bg:rgba(240,163,90,.15);
  --t-serv:#5aa2ff; --t-serv-bg:rgba(90,162,255,.15);
  --t-cons:#43d081; --t-cons-bg:rgba(67,208,129,.13);
  --t-seg:#b18bf0; --t-seg-bg:rgba(177,139,240,.16);
  --t-out:#93a4b6; --t-out-bg:rgba(147,164,182,.12);
}}
:root[data-theme="light"]{
  --bg:#f5f7fa; --card:#ffffff; --card2:#fbfcfe; --line:#e3e8ef; --txt:#16202c; --mut:#5c6b7c;
  --acc:#1f5fb0; --acc-soft:rgba(31,95,176,.10);
  --exec:#137a44; --exec-bg:rgba(19,122,68,.12); --liq:#a86a12; --liq-bg:rgba(168,106,18,.12);
  --conh:#5c6b7c; --conh-bg:rgba(92,107,124,.10);
  --t-consorcio:#a8560f; --t-consorcio-bg:rgba(168,86,15,.12); --t-serv:#1f5fb0; --t-serv-bg:rgba(31,95,176,.12);
  --t-cons:#137a44; --t-cons-bg:rgba(19,122,68,.10); --t-seg:#6d4bb0; --t-seg-bg:rgba(109,75,176,.12);
  --t-out:#5c6b7c; --t-out-bg:rgba(92,107,124,.10);
}
:root[data-theme="dark"]{
  --bg:#0d141c; --card:#141e2a; --card2:#111a25; --line:#243244; --txt:#e7eef6; --mut:#93a4b6;
  --acc:#5aa2ff; --acc-soft:rgba(90,162,255,.14);
  --exec:#43d081; --exec-bg:rgba(67,208,129,.14); --liq:#e0a83a; --liq-bg:rgba(224,168,58,.14);
  --conh:#93a4b6; --conh-bg:rgba(147,164,182,.12);
  --t-consorcio:#f0a35a; --t-consorcio-bg:rgba(240,163,90,.15); --t-serv:#5aa2ff; --t-serv-bg:rgba(90,162,255,.15);
  --t-cons:#43d081; --t-cons-bg:rgba(67,208,129,.13); --t-seg:#b18bf0; --t-seg-bg:rgba(177,139,240,.16);
  --t-out:#93a4b6; --t-out-bg:rgba(147,164,182,.12);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased}
.tnum{font-variant-numeric:tabular-nums}
header{padding:22px 26px 16px;border-bottom:1px solid var(--line);background:var(--card);
  position:sticky;top:0;z-index:6}
.eyebrow{font-size:11px;font-weight:700;letter-spacing:.14em;color:var(--acc);text-transform:uppercase}
h1{margin:4px 0 3px;font-size:22px;font-weight:750;letter-spacing:-.01em;text-wrap:balance}
.sub{color:var(--mut);font-size:12.5px}
.wrap{padding:18px 26px 70px;max-width:1400px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:6px 0 18px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px 15px}
.kpi b{display:block;font-size:24px;font-weight:750;letter-spacing:-.02em}
.kpi span{color:var(--mut);font-size:12px;display:flex;align-items:center;gap:6px}
.kpi.prio{border-color:var(--acc);box-shadow:inset 3px 0 0 var(--acc)}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 14px}
input,select{background:var(--card);color:var(--txt);border:1px solid var(--line);border-radius:9px;
  padding:9px 11px;font-size:13px;font-family:inherit}
input[type=search]{min-width:240px;flex:1}
select{cursor:pointer}
input:focus,select:focus{outline:2px solid var(--acc);outline-offset:1px;border-color:var(--acc)}
label.chk{display:flex;align-items:center;gap:6px;color:var(--mut);font-size:13px;cursor:pointer;user-select:none}
.count{margin-left:auto;color:var(--mut);font-size:13px}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--card)}
table{width:100%;border-collapse:collapse;min-width:1080px}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
th{position:sticky;top:0;background:var(--card2);cursor:pointer;user-select:none;font-size:11px;
  font-weight:650;letter-spacing:.04em;color:var(--mut);text-transform:uppercase;white-space:nowrap}
th:hover{color:var(--txt)} th .ar{opacity:.6;font-size:10px}
tbody tr:hover td{background:var(--acc-soft)}
tr.prio td:first-child{box-shadow:inset 3px 0 0 var(--acc)}
td.sc{color:var(--mut);font-size:12px}
.num a{color:var(--acc);text-decoration:none;font-weight:650;white-space:nowrap;font-variant-numeric:tabular-nums}
.num a:hover{text-decoration:underline}
.meta-sub{font-size:11px;color:var(--mut);margin-top:2px}
.assun{color:var(--mut);font-size:12px;max-width:300px}
.natur{max-width:180px}
.pill{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;white-space:nowrap}
.fase-exec{color:var(--exec);background:var(--exec-bg)} .fase-liq{color:var(--liq);background:var(--liq-bg)}
.fase-conh{color:var(--conh);background:var(--conh-bg)}
.t-Consorcio{color:var(--t-consorcio);background:var(--t-consorcio-bg)}
.t-Servidores{color:var(--t-serv);background:var(--t-serv-bg)}
.t-Consumidor{color:var(--t-cons);background:var(--t-cons-bg)}
.t-Seguros{color:var(--t-seg);background:var(--t-seg-bg)}
.t-Outros{color:var(--t-out);background:var(--t-out-bg)}
.badge-t{font-size:10px;color:var(--acc);background:var(--acc-soft);padding:1px 6px;border-radius:6px;margin-left:6px;white-space:nowrap}
.foot{color:var(--mut);font-size:12px;margin-top:14px;max-width:760px;line-height:1.6}
.empty{padding:26px;color:var(--mut);text-align:center}
.aviso{background:var(--liq-bg);color:var(--liq);border:1px solid var(--liq);border-radius:10px;
  padding:10px 14px;margin:0 0 16px;font-size:13px;display:none}
.aviso.show{display:block}
`;

const BODY = `
<header>
  <div class="eyebrow">Radar jurídico · Goiás · Tocantins</div>
  <h1>Teses coletivas em fase de cumprimento</h1>
  <div class="sub" id="sub"></div>
</header>
<div class="wrap">
  <div class="aviso" id="aviso"></div>
  <div class="cards" id="cards"></div>
  <div class="bar">
    <input type="search" id="q" placeholder="Buscar por número, assunto ou vara/comarca...">
    <select id="fTrilha">
      <option value="prioritarios">🎯 Prioritários (padrão)</option>
      <option value="Consórcio">Consórcio (ACP / CDC)</option>
      <option value="Servidores estaduais">Servidores estaduais GO/TO</option>
      <option value="Consumidor">Consumidor (geral)</option>
      <option value="Seguros">Seguros</option>
      <option value="">Todos</option>
    </select>
    <select id="fTrib"><option value="">Todos os estados</option></select>
    <select id="fFase"><option value="">Todas as fases</option></select>
    <label class="chk"><input type="checkbox" id="fTransito"> só com trânsito em julgado</label>
    <span class="count" id="count"></span>
  </div>
  <div class="tablewrap">
    <table>
      <thead><tr>
        <th data-k="score">★</th>
        <th data-k="numeroFmt">Nº do processo</th>
        <th data-k="classe">Natureza</th>
        <th data-k="ajuizadoSort">Distribuição</th>
        <th data-k="tribunal">Estado / Tribunal</th>
        <th data-k="trilha">Trilha</th>
        <th data-k="assuntosTxt">Assuntos</th>
        <th data-k="fase">Fase</th>
        <th data-k="orgao">Vara / Comarca</th>
      </tr></thead>
      <tbody id="tb"></tbody>
    </table>
  </div>
  <div class="foot" id="foot"></div>
</div>
<script>/*__DADOS__*/</script>
<script>/*__META__*/</script>
<script>
(function(){
  var D=window.DADOS||[], M=window.META||{};
  var q=g("q"),fTrilha=g("fTrilha"),fTrib=g("fTrib"),fFase=g("fFase"),fTransito=g("fTransito"),
      tb=g("tb"),count=g("count");
  var sortK="score",sortDir=-1;
  function g(id){return document.getElementById(id);}
  function esc(s){return String(s==null?"":s).replace(/[&<>]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;"}[c];});}

  g("sub").textContent="Atualizado em "+(M.geradoEm||"")+"  ·  fonte: API Pública do DataJud (CNJ)  ·  TJGO + TJTO";
  if(M.tribunaisVazios&&M.tribunaisVazios.length){var av=g("aviso");av.className="aviso show";
    av.textContent="Atenção: o índice do CNJ para "+M.tribunaisVazios.join(", ")+" estava temporariamente sem dados nesta atualização (reindexação). Se houver registros desses tribunais, são da coleta anterior. Rode o 'atualizar.bat' mais tarde para completar.";}

  var pt=M.porTrilha||{}, pf=M.porFase||{};
  var cards=[["b",M.total||D.length,"processos",""],
    ["prio",pt["Consórcio"]||0,"Consórcio (ACP / CDC)","var(--t-consorcio)"],
    ["prio",pt["Servidores estaduais"]||0,"Servidores estaduais","var(--t-serv)"],
    ["b",pf["Execução (coletiva)"]||0,"em execução coletiva","var(--exec)"],
    ["b",M.prioritarios||0,"prioritários no total","var(--acc)"]];
  g("cards").innerHTML=cards.map(function(c){
    var d=c[3]?'<span class="dot" style="background:'+c[3]+'"></span>':'';
    return '<div class="kpi '+(c[0]==="prio"?"prio":"")+'"><b class="tnum">'+c[1]+'</b><span>'+d+c[2]+'</span></div>';
  }).join("");

  var trs={}; D.forEach(function(r){trs[r.tribunal]=r.tribunalLabel;});
  Object.keys(trs).sort().forEach(function(t){fTrib.appendChild(opt(t,trs[t]));});
  var fss={}; D.forEach(function(r){fss[r.fase]=1;});
  Object.keys(fss).sort().forEach(function(f){fFase.appendChild(opt(f,f));});
  function opt(v,t){var o=document.createElement("option");o.value=v;o.textContent=t;return o;}

  function link(r){return "https://www.google.com/search?q="+encodeURIComponent('"'+r.numeroFmt+'"');}
  function faseCls(f){return f.indexOf("Execu")===0?"fase-exec":(f.indexOf("Liquid")===0?"fase-liq":"fase-conh");}
  function trilhaCls(t){return "t-"+({"Consórcio":"Consorcio","Servidores estaduais":"Servidores","Consumidor":"Consumidor","Seguros":"Seguros"}[t]||"Outros");}

  function filtrar(){
    var s=(q.value||"").toLowerCase(),tr=fTrilha.value,tb2=fTrib.value,fa=fFase.value,tj=fTransito.checked;
    return D.filter(function(r){
      if(tr==="prioritarios"){if(!r.prioridade)return false;}
      else if(tr){if(r.trilha!==tr)return false;}
      if(tb2&&r.tribunal!==tb2)return false;
      if(fa&&r.fase!==fa)return false;
      if(tj&&!r.transito)return false;
      if(s){var h=(r.numeroFmt+" "+r.assuntosTxt+" "+r.orgao+" "+r.classe).toLowerCase();if(h.indexOf(s)<0)return false;}
      return true;
    });
  }
  function ordenar(a){a.sort(function(x,y){var vx=x[sortK],vy=y[sortK];
    if(typeof vx==="number"&&typeof vy==="number")return (vx-vy)*sortDir;
    return String(vx).localeCompare(String(vy),"pt")*sortDir;});return a;}

  function render(){
    var rows=ordenar(filtrar());
    count.textContent=rows.length+" de "+D.length;
    var h="";
    for(var i=0;i<rows.length;i++){var r=rows[i];
      h+='<tr class="'+(r.prioridade?"prio":"")+'">'
        +'<td class="sc tnum">'+r.score+'</td>'
        +'<td class="num"><a href="'+link(r)+'" target="_blank" rel="noopener">'+r.numeroFmt+'</a>'
          +(r.transito?'<span class="badge-t">trânsito</span>':'')
          +'<div class="meta-sub">'+esc(r.tribunal)+(r.sistema?' · '+esc(r.sistema):'')+'</div></td>'
        +'<td class="natur">'+esc(r.classe)+'</td>'
        +'<td class="tnum">'+esc(r.ajuizadoBR)+'</td>'
        +'<td>'+esc(r.tribunalLabel)+'</td>'
        +'<td><span class="pill '+trilhaCls(r.trilha)+'">'+esc(r.trilha)+'</span></td>'
        +'<td class="assun">'+esc((r.assuntos||[]).slice(0,4).join(" · "))+'</td>'
        +'<td><span class="pill '+faseCls(r.fase)+'">'+esc(r.fase)+'</span></td>'
        +'<td>'+esc(r.orgao)+'</td>'
        +'</tr>';
    }
    tb.innerHTML=h||'<tr><td class="empty" colspan="9">Nenhum processo com esses filtros.</td></tr>';
  }
  [q,fTrilha,fTrib,fFase,fTransito].forEach(function(el){el.addEventListener("input",render);});
  Array.prototype.forEach.call(document.querySelectorAll("th[data-k]"),function(th){
    th.addEventListener("click",function(){var k=th.getAttribute("data-k");
      if(sortK===k)sortDir*=-1;else{sortK=k;sortDir=(k==="score"||k==="ajuizadoSort")?-1:1;}render();});
  });
  g("foot").innerHTML="<b>Como usar:</b> clique no número do processo para localizar as partes (seguradora, administradora de consórcio, sindicato) na consulta pública — a API do CNJ não fornece o nome das partes. "
    +"O ranking (★) prioriza as trilhas de Consórcio e Servidores estaduais, depois fase de cumprimento, recência e trânsito em julgado.";
  render();
})();
</script>
`;
