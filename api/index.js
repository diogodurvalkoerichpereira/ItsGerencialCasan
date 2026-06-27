const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// Conexao com o Postgres. A string vem de DATABASE_URL (definida no Coolify,
// nunca commitada no git). ssl desativado pois o trafego e' interno ao VPS.
// ---------------------------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
});

const app = express();

// CORS restrito: apenas as origens permitidas (CORS_ORIGINS no Coolify,
// separadas por virgula). O front roda same-origin via /api, entao o padrao
// e' o dominio de producao. Sem credenciais por cookie (auth e' Bearer token).
const ORIGENS = (process.env.CORS_ORIGINS ||
  'https://casan.its-customer-service.online')
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    // Requests same-origin/curl nao mandam Origin → permitidos.
    if (!origin || ORIGENS.includes(origin)) return cb(null, true);
    return cb(new Error('Origem nao permitida pelo CORS'));
  },
}));
app.use(express.json({ limit: '5mb' }));

// Permite acesso via prefixo de caminho /api (Traefik roteia /api/* ate aqui
// sem remover o prefixo). Assim o front chama https://<dominio>/api/... na
// mesma origem HTTPS, evitando bloqueio de mixed content.
app.use((req, _res, next) => {
  if (req.url === '/api' || req.url.startsWith('/api/')) req.url = req.url.slice(4) || '/';
  next();
});

const asyncH = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error(err.message);
    res.status(500).json({ error: 'Erro interno' });
  });

// ---------------------------------------------------------------------------
// Inicializa o schema na primeira execucao.
// ---------------------------------------------------------------------------
async function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);

  // Cria um admin inicial se nao houver nenhum usuario.
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM casan_usuarios');
  if (rows[0].n === 0) {
    const senha = process.env.ADMIN_SENHA || 'admin123';
    const hash = await bcrypt.hash(senha, 12);
    await pool.query(
      `INSERT INTO casan_usuarios (nome, email, senha_hash, perfil)
       VALUES ($1, $2, $3, 'Admin')`,
      ['Administrador', process.env.ADMIN_EMAIL || 'admin@its.com', hash]
    );
    console.log('Usuario admin inicial criado.');
  }
  console.log('Schema pronto.');
}

// ---------------------------------------------------------------------------
// Health check — liveness (nao depende do banco, para nao derrubar a stack
// caso o Postgres ainda nao esteja configurado/disponivel).
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Readiness — verifica o banco de fato.
app.get('/ready', asyncH(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ready' });
}));

// ---------------------------------------------------------------------------
// Autenticacao (login por token + 2FA TOTP / Google Authenticator)
// ---------------------------------------------------------------------------
const APP_NAME = 'iTS Gerencial CASAN';
const SESSION_DIAS = 7;
// Tokens temporarios para o passo 2 do 2FA (em memoria, curta duracao).
const pending2fa = new Map();

function novoToken() { return crypto.randomBytes(32).toString('hex'); }

async function criarSessao(usuarioId) {
  const token = novoToken();
  await pool.query(
    `INSERT INTO casan_sessions (token, usuario_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [token, usuarioId, String(SESSION_DIAS)]
  );
  return token;
}

function pubUser(u) {
  return { id: u.id, nome: u.nome, email: u.email, perfil: u.perfil, totp_enabled: u.totp_enabled };
}

// ---------------------------------------------------------------------------
// Rate limit simples para o login (em memoria). Bloqueia forca bruta por
// chave email+IP: max de tentativas falhas numa janela deslizante.
// ---------------------------------------------------------------------------
const LOGIN_MAX = 8;            // tentativas falhas
const LOGIN_JANELA = 15 * 60e3; // 15 minutos
const loginTentativas = new Map(); // chave -> { n, reset }

function loginChave(req, email) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  return `${ip}|${String(email || '').toLowerCase()}`;
}
function loginBloqueado(chave) {
  const e = loginTentativas.get(chave);
  if (!e) return false;
  if (Date.now() > e.reset) { loginTentativas.delete(chave); return false; }
  return e.n >= LOGIN_MAX;
}
function registrarFalha(chave) {
  const e = loginTentativas.get(chave);
  if (!e || Date.now() > e.reset) loginTentativas.set(chave, { n: 1, reset: Date.now() + LOGIN_JANELA });
  else e.n += 1;
}
function limparTentativas(chave) { loginTentativas.delete(chave); }

// Middleware: exige que o usuario autenticado tenha um dos perfis informados.
const requirePerfil = (...perfis) => (req, res, next) => {
  if (!req.user || !perfis.includes(req.user.perfil)) {
    return res.status(403).json({ error: 'acesso negado: permissao insuficiente' });
  }
  next();
};
const PERFIS_GESTAO = ['Admin', 'Gerente'];

// Middleware: exige token de sessao valido (Authorization: Bearer <token>)
const requireAuth = asyncH(async (req, res, next) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'nao autenticado' });
  const { rows } = await pool.query(
    `SELECT u.* FROM casan_sessions s
       JOIN casan_usuarios u ON u.id = s.usuario_id
      WHERE s.token = $1 AND s.expires_at > now() AND u.ativo = true`,
    [token]
  );
  if (!rows[0]) return res.status(401).json({ error: 'sessao invalida ou expirada' });
  req.user = rows[0];
  req.token = token;
  next();
});

app.post('/auth/login', asyncH(async (req, res) => {
  const { email, senha } = req.body || {};
  if (!email || !senha) return res.status(400).json({ error: 'email e senha obrigatorios' });

  const chave = loginChave(req, email);
  if (loginBloqueado(chave)) {
    return res.status(429).json({ error: 'Muitas tentativas. Tente novamente em alguns minutos.' });
  }

  const { rows } = await pool.query(
    'SELECT * FROM casan_usuarios WHERE email = $1',
    [String(email).toLowerCase()]
  );
  const u = rows[0];
  if (!u || !u.ativo || !(await bcrypt.compare(senha, u.senha_hash))) {
    registrarFalha(chave);
    return res.status(401).json({ error: 'Credenciais invalidas' });
  }
  limparTentativas(chave);

  // Se tem 2FA ativo, exige o segundo passo.
  if (u.totp_enabled) {
    const loginToken = novoToken();
    pending2fa.set(loginToken, { id: u.id, exp: Date.now() + 5 * 60 * 1000 });
    return res.json({ need2fa: true, login_token: loginToken });
  }

  const token = await criarSessao(u.id);
  res.json({ token, user: pubUser(u) });
}));

// Passo 2 do 2FA: valida o codigo do Google Authenticator.
app.post('/auth/2fa/verify', asyncH(async (req, res) => {
  const { login_token, code } = req.body || {};
  const p = pending2fa.get(login_token);
  if (!p || p.exp < Date.now()) {
    pending2fa.delete(login_token);
    return res.status(401).json({ error: 'sessao de login expirada, faca login novamente' });
  }
  const { rows } = await pool.query('SELECT * FROM casan_usuarios WHERE id = $1', [p.id]);
  const u = rows[0];
  if (!u || !u.totp_secret || !authenticator.verify({ token: String(code || ''), secret: u.totp_secret })) {
    return res.status(401).json({ error: 'codigo invalido' });
  }
  pending2fa.delete(login_token);
  const token = await criarSessao(u.id);
  res.json({ token, user: pubUser(u) });
}));

app.post('/auth/logout', requireAuth, asyncH(async (req, res) => {
  await pool.query('DELETE FROM casan_sessions WHERE token = $1', [req.token]);
  res.json({ ok: true });
}));

app.get('/auth/me', requireAuth, asyncH(async (req, res) => {
  res.json(pubUser(req.user));
}));

// ---------------------------------------------------------------------------
// 2FA — cadastro do Google Authenticator
// ---------------------------------------------------------------------------
// Gera segredo e QR Code para o usuario escanear no app.
app.post('/auth/2fa/setup', requireAuth, asyncH(async (req, res) => {
  const secret = authenticator.generateSecret();
  await pool.query(
    'UPDATE casan_usuarios SET totp_secret = $2, updated_at = now() WHERE id = $1',
    [req.user.id, secret]
  );
  const otpauth = authenticator.keyuri(req.user.email, APP_NAME, secret);
  const qr = await QRCode.toDataURL(otpauth);
  res.json({ qr, secret, otpauth });
}));

// Confirma o primeiro codigo e ativa o 2FA.
app.post('/auth/2fa/enable', requireAuth, asyncH(async (req, res) => {
  const { code } = req.body || {};
  const { rows } = await pool.query('SELECT totp_secret FROM casan_usuarios WHERE id = $1', [req.user.id]);
  const secret = rows[0] && rows[0].totp_secret;
  if (!secret) return res.status(400).json({ error: 'inicie o cadastro do 2FA primeiro' });
  if (!authenticator.verify({ token: String(code || ''), secret })) {
    return res.status(401).json({ error: 'codigo invalido' });
  }
  await pool.query('UPDATE casan_usuarios SET totp_enabled = true, updated_at = now() WHERE id = $1', [req.user.id]);
  res.json({ ok: true });
}));

// Desativa o 2FA (exige codigo atual).
app.post('/auth/2fa/disable', requireAuth, asyncH(async (req, res) => {
  const { code } = req.body || {};
  const { rows } = await pool.query('SELECT totp_secret FROM casan_usuarios WHERE id = $1', [req.user.id]);
  const secret = rows[0] && rows[0].totp_secret;
  if (!secret || !authenticator.verify({ token: String(code || ''), secret })) {
    return res.status(401).json({ error: 'codigo invalido' });
  }
  await pool.query(
    'UPDATE casan_usuarios SET totp_enabled = false, totp_secret = NULL, updated_at = now() WHERE id = $1',
    [req.user.id]
  );
  res.json({ ok: true });
}));

// Troca de senha do proprio usuario (exige a senha atual).
app.post('/auth/password', requireAuth, asyncH(async (req, res) => {
  const { atual, nova } = req.body || {};
  if (!atual || !nova) return res.status(400).json({ error: 'senha atual e nova obrigatorias' });
  if (String(nova).length < 4) return res.status(400).json({ error: 'a nova senha deve ter ao menos 4 caracteres' });
  if (!(await bcrypt.compare(String(atual), req.user.senha_hash))) {
    return res.status(401).json({ error: 'senha atual incorreta' });
  }
  const hash = await bcrypt.hash(String(nova), 12);
  await pool.query(
    'UPDATE casan_usuarios SET senha_hash = $2, updated_at = now() WHERE id = $1',
    [req.user.id, hash]
  );
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// A PARTIR DAQUI todas as rotas exigem token de sessao valido.
// ---------------------------------------------------------------------------
app.use(requireAuth);

// ---------------------------------------------------------------------------
// Usuarios
// ---------------------------------------------------------------------------
app.get('/usuarios', asyncH(async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT id, nome, email, perfil, ativo FROM casan_usuarios ORDER BY nome'
  );
  res.json(rows);
}));

app.post('/usuarios', requirePerfil(...PERFIS_GESTAO), asyncH(async (req, res) => {
  const { nome, email, senha, perfil } = req.body || {};
  if (!nome || !email || !senha) return res.status(400).json({ error: 'nome, email e senha obrigatorios' });
  const hash = await bcrypt.hash(senha, 12);
  const { rows } = await pool.query(
    `INSERT INTO casan_usuarios (nome, email, senha_hash, perfil)
     VALUES ($1, $2, $3, COALESCE($4, 'Cliente'))
     RETURNING id, nome, email, perfil, ativo`,
    [nome, String(email).toLowerCase(), hash, perfil]
  );
  res.status(201).json(rows[0]);
}));

app.put('/usuarios/:id', requirePerfil(...PERFIS_GESTAO), asyncH(async (req, res) => {
  const { nome, perfil, ativo, senha } = req.body || {};
  const hash = senha ? await bcrypt.hash(senha, 12) : null;
  const { rows } = await pool.query(
    `UPDATE casan_usuarios SET
       nome   = COALESCE($2, nome),
       perfil = COALESCE($3, perfil),
       ativo  = COALESCE($4, ativo),
       senha_hash = COALESCE($5, senha_hash),
       updated_at = now()
     WHERE id = $1
     RETURNING id, nome, email, perfil, ativo`,
    [req.params.id, nome, perfil, ativo, hash]
  );
  if (!rows[0]) return res.status(404).json({ error: 'nao encontrado' });
  res.json(rows[0]);
}));

app.delete('/usuarios/:id', requirePerfil(...PERFIS_GESTAO), asyncH(async (req, res) => {
  await pool.query('DELETE FROM casan_usuarios WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Ponto (por mes)
// ---------------------------------------------------------------------------
app.get('/ponto', asyncH(async (_req, res) => {
  const { rows } = await pool.query('SELECT mes_key, registros, sups FROM casan_ponto');
  const out = {};
  rows.forEach((r) => { out[r.mes_key] = { registros: r.registros, sups: r.sups }; });
  res.json(out);
}));

// mes_key e' "MM/YYYY" (contem barra), por isso o parametro curinga (*).
app.put('/ponto/:mesKey(*)', asyncH(async (req, res) => {
  const { registros = [], sups = [] } = req.body || {};
  await pool.query(
    `INSERT INTO casan_ponto (mes_key, registros, sups, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (mes_key) DO UPDATE
       SET registros = EXCLUDED.registros, sups = EXCLUDED.sups, updated_at = now()`,
    [req.params.mesKey, JSON.stringify(registros), JSON.stringify(sups)]
  );
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Generico para tarefas / chamados
// ---------------------------------------------------------------------------
function crud(tabela) {
  app.get(`/${tabela}`, asyncH(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT id, dados, status, created_at, updated_at FROM casan_${tabela} ORDER BY id`
    );
    res.json(rows);
  }));
  app.post(`/${tabela}`, asyncH(async (req, res) => {
    const { dados, status } = req.body || {};
    const { rows } = await pool.query(
      `INSERT INTO casan_${tabela} (dados, status) VALUES ($1, $2)
       RETURNING id, dados, status, created_at, updated_at`,
      [JSON.stringify(dados || {}), status || null]
    );
    res.status(201).json(rows[0]);
  }));
  app.put(`/${tabela}/:id`, asyncH(async (req, res) => {
    const { dados, status } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE casan_${tabela} SET dados = COALESCE($2, dados),
         status = COALESCE($3, status), updated_at = now()
       WHERE id = $1 RETURNING id, dados, status, created_at, updated_at`,
      [req.params.id, dados ? JSON.stringify(dados) : null, status]
    );
    if (!rows[0]) return res.status(404).json({ error: 'nao encontrado' });
    res.json(rows[0]);
  }));
  app.delete(`/${tabela}/:id`, asyncH(async (req, res) => {
    await pool.query(`DELETE FROM casan_${tabela} WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  }));
}
crud('tarefas');
crud('chamados');

// ---------------------------------------------------------------------------
// Config (chave/valor)
// ---------------------------------------------------------------------------
// Chaves de configuracao sensiveis: escrita restrita a perfis de gestao.
const CONFIG_SENSIVEL = new Set(['its_users', 'its_admin_hash', 'its_cfg']);
// Chaves que guardam segredos (tokens): nunca acessiveis pelo /config generico.
// Sao manipuladas apenas pelas rotas dedicadas /integracoes/*.
const CONFIG_BLOQUEADA = new Set(['its_zapi']);

app.get('/config/:chave', asyncH(async (req, res) => {
  if (CONFIG_BLOQUEADA.has(req.params.chave)) return res.status(403).json({ error: 'chave protegida' });
  const { rows } = await pool.query('SELECT valor FROM casan_config WHERE chave = $1', [req.params.chave]);
  res.json(rows[0] ? rows[0].valor : null);
}));

app.put('/config/:chave', asyncH(async (req, res) => {
  if (CONFIG_BLOQUEADA.has(req.params.chave)) return res.status(403).json({ error: 'chave protegida' });
  if (CONFIG_SENSIVEL.has(req.params.chave) && !PERFIS_GESTAO.includes(req.user.perfil)) {
    return res.status(403).json({ error: 'acesso negado: permissao insuficiente' });
  }
  await pool.query(
    `INSERT INTO casan_config (chave, valor, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = now()`,
    [req.params.chave, JSON.stringify(req.body ?? null)]
  );
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Integracao Z-API (WhatsApp). Credenciais guardadas em casan_config
// (chave its_zapi) e usadas SOMENTE no servidor. O navegador nunca recebe os
// tokens — apenas flags de "configurado". Envio/teste feitos daqui.
// ---------------------------------------------------------------------------
async function getZapi() {
  const { rows } = await pool.query('SELECT valor FROM casan_config WHERE chave = $1', ['its_zapi']);
  return (rows[0] && rows[0].valor) || {};
}
function zapiBase(cfg) {
  return `https://api.z-api.io/instances/${cfg.instance}/token/${cfg.token}`;
}

// Retorna apenas flags, nunca os tokens. groupId nao e segredo, pode ir.
app.get('/integracoes/zapi/config', requirePerfil(...PERFIS_GESTAO), asyncH(async (_req, res) => {
  const c = await getZapi();
  res.json({ instance: c.instance || '', ativo: !!c.ativo, tokenSet: !!c.token, clientTokenSet: !!c.clientToken,
    groupId: c.groupId || '', groupAtivo: !!c.groupAtivo });
}));

// Salva/atualiza. Tokens vazios mantem os ja gravados (merge).
app.put('/integracoes/zapi/config', requirePerfil(...PERFIS_GESTAO), asyncH(async (req, res) => {
  const atual = await getZapi();
  const { instance, token, clientToken, ativo, groupId, groupAtivo } = req.body || {};
  const novo = {
    instance: (instance != null ? String(instance).trim() : atual.instance) || '',
    token: token ? String(token).trim() : (atual.token || ''),
    clientToken: clientToken ? String(clientToken).trim() : (atual.clientToken || ''),
    ativo: !!ativo,
    groupId: (groupId != null ? String(groupId).trim() : atual.groupId) || '',
    groupAtivo: !!groupAtivo,
  };
  await pool.query(
    `INSERT INTO casan_config (chave, valor, updated_at) VALUES ('its_zapi', $1, now())
     ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = now()`,
    [JSON.stringify(novo)]
  );
  res.json({ ok: true });
}));

// Testa a conexao consultando o status da instancia na Z-API.
app.post('/integracoes/zapi/test', requirePerfil(...PERFIS_GESTAO), asyncH(async (_req, res) => {
  const c = await getZapi();
  if (!c.instance || !c.token) return res.status(400).json({ error: 'configure Instance ID e Token primeiro' });
  try {
    const r = await fetch(`${zapiBase(c)}/status`, {
      headers: c.clientToken ? { 'Client-Token': c.clientToken } : {},
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: d.error || `Z-API respondeu HTTP ${r.status}` });
    // Z-API status: { connected: true/false, ... }
    res.json({ connected: !!d.connected, status: d.connected ? 'connected' : (d.error || 'desconectado') });
  } catch (e) {
    res.status(502).json({ error: 'nao foi possivel contatar a Z-API: ' + e.message });
  }
}));

// Envia mensagem de texto via Z-API.
app.post('/integracoes/zapi/send', asyncH(async (req, res) => {
  const { phone, message } = req.body || {};
  if (!phone || !message) return res.status(400).json({ error: 'phone e message obrigatorios' });
  const c = await getZapi();
  if (!c.ativo) return res.status(400).json({ error: 'integracao WhatsApp desativada' });
  if (!c.instance || !c.token) return res.status(400).json({ error: 'Z-API nao configurada' });
  try {
    const r = await fetch(`${zapiBase(c)}/send-text`, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, c.clientToken ? { 'Client-Token': c.clientToken } : {}),
      body: JSON.stringify({ phone: String(phone).replace(/\D/g, ''), message: String(message) }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: d.error || `Z-API respondeu HTTP ${r.status}` });
    res.json({ ok: true, id: d.messageId || d.id || null });
  } catch (e) {
    res.status(502).json({ error: 'falha ao enviar: ' + e.message });
  }
}));

// Envia mensagem para o GRUPO predefinido (groupId fica no servidor).
// Disponivel para qualquer usuario autenticado (eventos disparam isso).
// allowDisabled=true permite testar mesmo com o grupo desligado.
async function enviarGrupo(message, { ignorarFlag = false } = {}) {
  const c = await getZapi();
  if (!c.ativo) return { ok: false, error: 'integracao WhatsApp desativada' };
  if (!ignorarFlag && !c.groupAtivo) return { ok: false, error: 'envio para grupo desativado' };
  if (!c.instance || !c.token) return { ok: false, error: 'Z-API nao configurada' };
  if (!c.groupId) return { ok: false, error: 'ID do grupo nao configurado' };
  const r = await fetch(`${zapiBase(c)}/send-text`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, c.clientToken ? { 'Client-Token': c.clientToken } : {}),
    // Para grupos, a Z-API usa o ID do grupo no campo phone (sem normalizar).
    body: JSON.stringify({ phone: String(c.groupId), message: String(message) }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: d.error || `Z-API respondeu HTTP ${r.status}` };
  return { ok: true, id: d.messageId || d.id || null };
}

app.post('/integracoes/zapi/send-group', asyncH(async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message obrigatoria' });
  const out = await enviarGrupo(message).catch((e) => ({ ok: false, error: e.message }));
  if (!out.ok) return res.status(502).json(out);
  res.json(out);
}));

// Lista os grupos em que o numero conectado participa (para o usuario pegar o ID).
app.get('/integracoes/zapi/groups', requirePerfil(...PERFIS_GESTAO), asyncH(async (_req, res) => {
  const c = await getZapi();
  if (!c.instance || !c.token) return res.status(400).json({ error: 'configure a Z-API primeiro' });
  try {
    const r = await fetch(`${zapiBase(c)}/chats`, {
      headers: c.clientToken ? { 'Client-Token': c.clientToken } : {},
    });
    const d = await r.json().catch(() => ([]));
    if (!r.ok) return res.status(502).json({ error: (d && d.error) || `Z-API respondeu HTTP ${r.status}` });
    const lista = Array.isArray(d) ? d : [];
    const grupos = lista
      .filter((x) => x && (x.isGroup === true || /(-group|@g\.us)$/.test(String(x.phone || x.id || ''))))
      .map((x) => ({ id: String(x.phone || x.id || ''), name: x.name || x.subject || x.phone || '(sem nome)' }))
      .filter((g) => g.id);
    res.json(grupos);
  } catch (e) {
    res.status(502).json({ error: 'nao foi possivel listar grupos: ' + e.message });
  }
}));

// Teste manual do grupo (gestao), ignora a flag groupAtivo.
app.post('/integracoes/zapi/test-group', requirePerfil(...PERFIS_GESTAO), asyncH(async (_req, res) => {
  const out = await enviarGrupo('✅ Teste de grupo — iTS Gerencial CASAN. Notificações chegarão aqui!', { ignorarFlag: true })
    .catch((e) => ({ ok: false, error: e.message }));
  if (!out.ok) return res.status(502).json(out);
  res.json(out);
}));

const PORT = process.env.PORT || 3002;

// Sobe o servidor IMEDIATAMENTE (health responde na hora) e inicializa o
// schema em segundo plano com novas tentativas. Assim, um Postgres ausente
// ou ainda nao pronto nao deixa o container em crash-loop nem derruba a stack.
app.listen(PORT, () => console.log(`api rodando na porta ${PORT}`));

async function initComRetry(tentativa = 1) {
  try {
    await initSchema();
  } catch (err) {
    const espera = Math.min(30, tentativa * 3);
    console.error(`Schema ainda nao pronto (tentativa ${tentativa}): ${err.message}. Nova tentativa em ${espera}s.`);
    setTimeout(() => initComRetry(tentativa + 1), espera * 1000);
  }
}
initComRetry();
