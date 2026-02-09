const express = require("express");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const { randomUUID } = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "responses.json");

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.text({ type: "text/plain" }));
app.use(express.static(path.join(__dirname, "../public")));

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 0);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false") === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || "no-reply@localhost";

const mailer =
  SMTP_HOST && SMTP_PORT
    ? nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
      })
    : null;

const createId = () => {
  if (typeof randomUUID === "function") {
    return randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const ensureDataFile = () => {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify({ responses: [], emailArchive: [] }, null, 2),
    );
  }
};

const normalizeData = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { responses: [], emailArchive: [] };
  }
  if (Array.isArray(raw.responses) || Array.isArray(raw.emailArchive)) {
    return {
      responses: Array.isArray(raw.responses) ? raw.responses : [],
      emailArchive: Array.isArray(raw.emailArchive) ? raw.emailArchive : [],
    };
  }
  const responses = Object.entries(raw).map(([to, entry]) => ({
    id: createId(),
    to,
    ...entry,
    migrated: true,
  }));
  return { responses, emailArchive: [] };
};

const readData = () => {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = raw ? JSON.parse(raw) : null;
    return normalizeData(parsed);
  } catch (error) {
    return { responses: [], emailArchive: [] };
  }
};

const writeData = (data) => {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
};

const parsePayload = (req) => {
  if (typeof req.body === "string") {
    const trimmed = req.body.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      return null;
    }
  }
  if (req.body && typeof req.body === "object") {
    return req.body;
  }
  return null;
};

const answerLabel = (answer) => {
  if (answer === "yes") return "Oui";
  if (answer === "no") return "Non";
  if (answer === "exit") return "Aucune réponse";
  return String(answer || "Inconnu");
};

const buildEmailContent = (entry) => {
  const label = answerLabel(entry.answer);
  const reasonLine = entry.reason
    ? `Raison: ${entry.reason}`
    : "Raison: non précisée";
  const text = [
    `Réponse: ${label}`,
    `Cible: ${entry.to}`,
    `Email destinataire: ${entry.fromEmail || "non fourni"}`,
    `Date: ${entry.date}`,
    `Compteur "non": ${entry.noCompt ?? "n/a"}`,
    reasonLine,
  ].join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; color: #1f1f1f;">
      <h2 style="margin: 0 0 12px;">Réponse enregistrée</h2>
      <table style="border-collapse: collapse; width: 100%; max-width: 520px;">
        <tr>
          <td style="padding: 6px 0; font-weight: bold;">Réponse</td>
          <td style="padding: 6px 0;">${label}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; font-weight: bold;">Cible</td>
          <td style="padding: 6px 0;">${entry.to}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; font-weight: bold;">Email destinataire</td>
          <td style="padding: 6px 0;">${entry.fromEmail || "non fourni"}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; font-weight: bold;">Date</td>
          <td style="padding: 6px 0;">${entry.date}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; font-weight: bold;">Compteur "non"</td>
          <td style="padding: 6px 0;">${entry.noCompt ?? "n/a"}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; font-weight: bold;">Raison</td>
          <td style="padding: 6px 0;">${entry.reason || "non précisée"}</td>
        </tr>
      </table>
    </div>
  `;

  return { text, html };
};

const sendEmail = async (entry) => {
  const subject =
    entry.answer === "exit"
      ? `Aucune réponse de ${entry.to}`
      : `Réponse de ${entry.to}`;
  const { text, html } = buildEmailContent(entry);

  if (!entry.fromEmail) {
    return { status: "skipped", error: "missing_recipient", subject };
  }
  if (!mailer) {
    return { status: "skipped", error: "smtp_not_configured", subject };
  }

  try {
    const info = await mailer.sendMail({
      from: SMTP_FROM,
      to: entry.fromEmail,
      subject,
      text,
      html,
    });
    return { status: "sent", messageId: info.messageId, subject };
  } catch (error) {
    return { status: "failed", error: error.message, subject };
  }
};

ensureDataFile();

app.post("/api/respond", async (req, res) => {
  const payload = parsePayload(req);
  if (!payload) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const { to, fromEmail, answer, noCompt, reason } = payload;
  if (!to || !answer) {
    return res.status(400).json({ error: "Invalid data" });
  }

  const entry = {
    id: createId(),
    to,
    fromEmail,
    answer,
    noCompt,
    reason:
      reason ||
      (answer === "exit"
        ? "La personne a quitté la page sans répondre."
        : "Réponse fournie par l'utilisateur."),
    date: new Date().toISOString(),
  };

  const data = readData();
  data.responses.push(entry);

  const emailResult = await sendEmail(entry);
  data.emailArchive.push({
    id: createId(),
    responseId: entry.id,
    to: entry.fromEmail || null,
    subject: emailResult.subject,
    status: emailResult.status,
    error: emailResult.error || null,
    messageId: emailResult.messageId || null,
    date: new Date().toISOString(),
  });

  writeData(data);
  res.json({ success: true, email: emailResult.status });
});

app.get("/api/responses", (req, res) => {
  const data = readData();
  res.json(data);
});

app.listen(PORT, () => {
  console.log("Server running on http://localhost:" + PORT);
});
