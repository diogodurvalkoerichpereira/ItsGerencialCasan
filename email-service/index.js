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

app.post('/send', async (req, res) => {
  const { to, subject, text } = req.body;
  if (!to || !subject || !text) {
    return res.status(400).json({ error: 'Campos obrigatórios: to, subject, text' });
  }
  try {
    await transporter.sendMail({
      from: `"ITS Gerencial" <${process.env.SMTP_USER}>`,
      to,
      subject,
      text,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao enviar e-mail:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(3001, () => console.log('email-service rodando na porta 3001'));
