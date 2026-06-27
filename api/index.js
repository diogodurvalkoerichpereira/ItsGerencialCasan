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
app.use(cors());
app.use(express.json({ limit: '5mb' }));

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
// Health check
// ---------------------------------------------------------------------------
app.get('/health', asyncH(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
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

  const { rows } = await pool.query(
    'SELECT * FROM casan_usuarios WHERE email = $1',
    [String(email).toLowerCase()]
  );
  const u = rows[0];
  if (!u || !u.ativo || !(await bcrypt.compare(senha, u.senha_hash))) {
    return res.status(401).json({ error: 'Credenciais invalidas' });
  }

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

app.post('/usuarios', asyncH(async (req, res) => {
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

app.put('/usuarios/:id', asyncH(async (req, res) => {
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

app.delete('/usuarios/:id', asyncH(async (req, res) => {
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
app.get('/config/:chave', asyncH(async (req, res) => {
  const { rows } = await pool.query('SELECT valor FROM casan_config WHERE chave = $1', [req.params.chave]);
  res.json(rows[0] ? rows[0].valor : null);
}));

app.put('/config/:chave', asyncH(async (req, res) => {
  await pool.query(
    `INSERT INTO casan_config (chave, valor, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = now()`,
    [req.params.chave, JSON.stringify(req.body ?? null)]
  );
  res.json({ ok: true });
}));

const PORT = process.env.PORT || 3002;
initSchema()
  .then(() => app.listen(PORT, () => console.log(`api rodando na porta ${PORT}`)))
  .catch((err) => {
    console.error('Falha ao iniciar:', err.message);
    process.exit(1);
  });
