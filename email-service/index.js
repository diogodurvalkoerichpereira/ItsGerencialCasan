const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '465'),
  secure: process.env.SMTP_SECURE !== 'false',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Cores por prioridade (alinhadas ao design kit ITS)
const PRIO_COLORS = {
  'Simples':       { bg: '#f0fdf4', text: '#16a34a', border: '#bbf7d0' },
  'Intermediária': { bg: '#fff3ee', text: '#E85928', border: '#fdd0be' },
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
                <td style="background:#E85928;width:38px;height:38px;border-radius:8px;text-align:center;vertical-align:middle;color:#fff;font-weight:900;font-size:13px;">ITS</td>
                <td style="padding-left:12px;">
                  <div style="color:#ffffff;font-size:17px;font-weight:700;">ITS Gerencial CASAN</div>
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
                Esta é uma notificação automática do <strong style="color:#183c5a;">ITS Gerencial CASAN</strong>.<br>
                ITS Customer Service — não responda a este e-mail.
              </div>
            </td>
          </tr>

        </table>
      </td></tr>
    </table>
  </body>`;
}

function buildText(task) {
  return `Nova tarefa criada no ITS Gerencial CASAN:\n\n` +
    `Título: ${task.titulo}\n` +
    `Área: ${task.area}\n` +
    `Responsável: ${task.resp}\n` +
    `Prazo: ${task.prazo || '—'}\n` +
    `Prioridade: ${task.prio}\n` +
    `Status: ${task.status || '—'}\n` +
    `Descrição: ${task.desc || '—'}`;
}

app.post('/send', async (req, res) => {
  const { to, task } = req.body;
  if (!to || !task || !task.titulo) {
    return res.status(400).json({ error: 'Campos obrigatórios: to, task.titulo' });
  }
  try {
    await transporter.sendMail({
      from: `"ITS Gerencial CASAN" <${process.env.SMTP_USER}>`,
      to,
      subject: `🔔 Nova Tarefa: ${task.titulo}`,
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
