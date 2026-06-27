require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Permite acesso via prefixo de caminho /email (Traefik roteia /email/* ate aqui
// sem remover o prefixo). Assim o front chama https://<dominio>/email/send.
app.use((req, _res, next) => {
  if (req.url === '/email' || req.url.startsWith('/email/')) req.url = req.url.slice(6) || '/';
  next();
});

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '465'),
  secure: process.env.SMTP_SECURE !== 'false',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Cores por prioridade (alinhadas ao design kit iTS)
const PRIO_COLORS = {
  'Simples':       { bg: '#f0fdf4', text: '#16a34a', border: '#bbf7d0' },
  'Intermediária': { bg: '#fefce8', text: '#a16207', border: '#fde68a' },
  'Complexa':      { bg: '#fef2f2', text: '#dc2626', border: '#fecaca' },
};

function buildHtml(task) {
  const prio = PRIO_COLORS[task.prio] || PRIO_COLORS['Intermediária'];
  const linha = (label, valor) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;font-size:13px;color:#64748b;font-weight:600;width:140px;vertical-align:top;">${label}</td>
      <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;font-size:14px;color:#1e293b;">${valor || '—'}</td>
    </tr>`;

  return `
  <body style="margin:0;padding:0;background:#f0f2f5;font-family:'Segoe UI',system-ui,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.10);">

          <!-- Cabeçalho -->
          <tr>
            <td style="background:#183c5a;padding:24px 28px;">
              <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                <td style="background:#E85928;width:38px;height:38px;border-radius:8px;text-align:center;vertical-align:middle;color:#fff;font-weight:900;font-size:13px;">iTS</td>
                <td style="padding-left:12px;">
                  <div style="color:#ffffff;font-size:17px;font-weight:700;">iTS Gerencial CASAN</div>
                  <div style="color:rgba(255,255,255,.65);font-size:12px;">Notificação de Nova Tarefa</div>
                </td>
              </tr></table>
            </td>
          </tr>

          <!-- Faixa laranja -->
          <tr><td style="height:4px;background:#E85928;"></td></tr>

          <!-- Corpo -->
          <tr>
            <td style="padding:28px;">
              <div style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;font-weight:600;border-left:3px solid #E85928;padding-left:10px;margin-bottom:16px;">
                Uma nova tarefa foi criada
              </div>

              <h1 style="margin:0 0 18px;font-size:20px;color:#183c5a;line-height:1.3;">${task.titulo}</h1>

              <span style="display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;background:${prio.bg};color:${prio.text};border:1px solid ${prio.border};margin-bottom:20px;">
                ● Prioridade ${task.prio}
              </span>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${linha('Área', task.area)}
                ${linha('Responsável', task.resp)}
                ${linha('Prazo', task.prazo)}
                ${linha('Status', task.status)}
                ${linha('Descrição', task.desc)}
              </table>
            </td>
          </tr>

          <!-- Rodapé -->
          <tr>
            <td style="background:#f8fafc;padding:18px 28px;border-top:1px solid #e2e8f0;">
              <div style="font-size:12px;color:#64748b;line-height:1.5;">
                Esta é uma notificação automática do <strong style="color:#183c5a;">iTS Gerencial CASAN</strong>.<br>
                iTS Customer Service — não responda a este e-mail.
              </div>
            </td>
          </tr>

        </table>
      </td></tr>
    </table>
  </body>`;
}

function buildText(task) {
  return `Nova tarefa criada no iTS Gerencial CASAN:\n\n` +
    `Título: ${task.titulo}\n` +
    `Área: ${task.area}\n` +
    `Responsável: ${task.resp}\n` +
    `Prazo: ${task.prazo || '—'}\n` +
    `Prioridade: ${task.prio}\n` +
    `Status: ${task.status || '—'}\n` +
    `Descrição: ${task.desc || '—'}`;
}

// Email generico para qualquer evento (chamado, emergencia, aviso, etc.)
// n = { titulo, subtitulo, linhas: [{label, valor}], cabecalho }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function buildHtmlGeneric(n) {
  const linha = (label, valor) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;font-size:13px;color:#64748b;font-weight:600;width:140px;vertical-align:top;">${esc(label)}</td>
      <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;font-size:14px;color:#1e293b;">${esc(valor) || '—'}</td>
    </tr>`;
  const linhasHtml = (n.linhas || []).map(l => linha(l.label, l.valor)).join('');
  return `
  <body style="margin:0;padding:0;background:#f0f2f5;font-family:'Segoe UI',system-ui,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.10);">
          <tr>
            <td style="background:#183c5a;padding:24px 28px;">
              <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                <td style="background:#E85928;width:38px;height:38px;border-radius:8px;text-align:center;vertical-align:middle;color:#fff;font-weight:900;font-size:13px;">iTS</td>
                <td style="padding-left:12px;">
                  <div style="color:#ffffff;font-size:17px;font-weight:700;">iTS Gerencial CASAN</div>
                  <div style="color:rgba(255,255,255,.65);font-size:12px;">${esc(n.cabecalho || 'Notificação')}</div>
                </td>
              </tr></table>
            </td>
          </tr>
          <tr><td style="height:4px;background:#E85928;"></td></tr>
          <tr>
            <td style="padding:28px;">
              <div style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;font-weight:600;border-left:3px solid #E85928;padding-left:10px;margin-bottom:16px;">${esc(n.subtitulo || '')}</div>
              <h1 style="margin:0 0 18px;font-size:20px;color:#183c5a;line-height:1.3;">${esc(n.titulo)}</h1>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${linhasHtml}</table>
            </td>
          </tr>
          <tr>
            <td style="background:#f8fafc;padding:18px 28px;border-top:1px solid #e2e8f0;">
              <div style="font-size:12px;color:#64748b;line-height:1.5;">
                Esta é uma notificação automática do <strong style="color:#183c5a;">iTS Gerencial CASAN</strong>.<br>
                iTS Customer Service — não responda a este e-mail.
              </div>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </body>`;
}

function buildTextGeneric(n) {
  return `${n.titulo}\n\n` + (n.linhas || []).map(l => `${l.label}: ${l.valor || '—'}`).join('\n') +
    `\n\n— iTS Gerencial CASAN`;
}

app.post('/send', async (req, res) => {
  const { to, task, notificacao, assunto } = req.body;
  // Caminho generico: qualquer evento (chamado, emergencia, aviso, etc.)
  if (notificacao && notificacao.titulo) {
    if (!to) return res.status(400).json({ error: 'Campo obrigatório: to' });
    try {
      await transporter.sendMail({
        from: `"iTS Gerencial CASAN" <${process.env.SMTP_USER}>`,
        to,
        subject: assunto || `🔔 ${notificacao.titulo}`,
        text: buildTextGeneric(notificacao),
        html: buildHtmlGeneric(notificacao),
      });
      return res.json({ ok: true });
    } catch (err) {
      console.error('Erro ao enviar e-mail:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }
  // Caminho legado: tarefa.
  if (!to || !task || !task.titulo) {
    return res.status(400).json({ error: 'Campos obrigatórios: to, task.titulo' });
  }
  try {
    await transporter.sendMail({
      from: `"iTS Gerencial CASAN" <${process.env.SMTP_USER}>`,
      to,
      subject: assunto || `🔔 Nova Tarefa: ${task.titulo}`,
      text: buildText(task),
      html: buildHtml(task),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao enviar e-mail:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(3001, () => console.log('email-service rodando na porta 3001'));
