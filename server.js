const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ====== СТАТИКА ======
app.use(express.static('public'));

// ====== ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ ======
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'SkyMonder';
const DATA_DIR = path.join(__dirname, 'data');

// ====== ФУНКЦИЯ ПОЛУЧЕНИЯ IP ======
function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
  return ip.split(':')[0];
}

// ====== ФАЙЛОВАЯ БД ======
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function dbPut(bucket, key, data) {
  const dir = path.join(DATA_DIR, bucket);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, key + '.json'), JSON.stringify(data, null, 2));
}

function dbGet(bucket, key) {
  const file = path.join(DATA_DIR, bucket, key + '.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { return null; }
}

function dbList(bucket) {
  const dir = path.join(DATA_DIR, bucket);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
}

function dbDelete(bucket, key) {
  const file = path.join(DATA_DIR, bucket, key + '.json');
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// ====== МОДЕРАЦИЯ ======
const BANNED_WORDS = [
  'мат', 'дурак', 'идиот', 'дебил', 'урод', 'козёл', 'сволочь', 'подонок',
  'уёбок', 'пизда', 'хуй', 'блядь', 'сука', 'нахуй', 'похуй', 'заебал',
  'террорист', 'терракт', 'взорвать', 'взрыв', 'бомба', 'оружие', 'стрельба',
  'убить', 'насилие', 'экстремизм', 'диверсия', 'исламское государство', 'игил',
  'захват', 'заложник', 'смертник', 'шахид', 'джихад', 'наркотик', 'наркота',
  'расчленить', 'отрезать', 'пытать', 'насиловать', 'педофил', 'педофилия',
  'украсть', 'ограбить', 'воровать', 'мошенник', 'скам', 'фишинг', 'взломать',
  'расстрел', 'застрелить', 'отрубить', 'отрезать', 'зарезать', 'задушить'
];

function containsBannedWords(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const word of BANNED_WORDS) {
    if (lower.includes(word)) return true;
  }
  return false;
}

// ====== ИИ-МОДЕРАЦИЯ ======
async function moderateWithAI(text) {
  const HF_TOKEN = process.env.HF_TOKEN;
  if (!HF_TOKEN) return null;
  try {
    const response = await fetch(
      'https://api-inference.huggingface.co/models/unitary/toxic-bert',
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: text }),
        signal: AbortSignal.timeout(5000)
      }
    );
    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
    return null;
  }
}

async function checkModerationAndBan(text, req, res) {
  if (!text) return { banned: false };

  // 1. Стоп-лист
  if (containsBannedWords(text)) {
    await banIP(getClientIP(req), text);
    return { banned: true, reason: 'Запрещённые слова' };
  }

  // 2. ИИ-модерация
  const aiResult = await moderateWithAI(text);
  if (aiResult && Array.isArray(aiResult) && aiResult.length > 0) {
    const toxic = aiResult.find(item => item.label === 'toxic');
    if (toxic && toxic.score > 0.7) {
      await banIP(getClientIP(req), text);
      return { banned: true, reason: 'Токсичный контент (ИИ)' };
    }
  }

  return { banned: false };
}

async function banIP(ip, reason) {
  const cleanIp = ip.split(',')[0].split(':')[0];
  await dbPut('banned_ips', cleanIp, {
    bannedAt: Date.now(),
    reason: 'Violation',
    message: reason || 'Нарушение правил'
  });
  console.log(`🚫 IP ${cleanIp} забанен за: "${reason}"`);
}

// ====== MIDDLEWARE: ПРОВЕРКА БАНА ======
app.use(async (req, res, next) => {
  if (req.path === '/ban.html' || req.path === '/favicon.ico') {
    return next();
  }

  const ip = getClientIP(req);
  const banned = dbGet('banned_ips', ip);

  if (banned) {
    // API-запросы — JSON
    const isApi = req.path.startsWith('/api/') ||
                  req.path === '/register' ||
                  req.path === '/login' ||
                  req.path === '/verify' ||
                  req.path === '/ban-info' ||
                  req.path.startsWith('/email/');

    if (isApi) {
      return res.status(403).json({ error: 'Banned', message: banned.message || 'Ваш IP заблокирован' });
    }

    // HTML-страницы — редирект на ban.html
    return res.redirect('/ban.html');
  }

  next();
});

// ====== АУТЕНТИФИКАЦИЯ ======
function generateJWT(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

function verifyJWT(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const decoded = verifyJWT(auth);
  if (!decoded) return res.status(401).json({ error: 'Invalid token' });
  req.user = decoded;
  next();
}

// ====== РЕГИСТРАЦИЯ С МОДЕРАЦИЕЙ ======
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  // Модерация логина
  const modResult = await checkModerationAndBan(username, req, res);
  if (modResult.banned) {
    return res.redirect('/ban.html');
  }

  if (dbGet('users', username)) {
    return res.status(409).json({ error: 'Username already exists' });
  }

  const salt = crypto.randomBytes(16).toString('base64');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  const token = crypto.randomBytes(32).toString('hex');

  dbPut('users', username, { username, salt, hash, token });

  const jwtToken = generateJWT({ username });
  res.json({ username, token, jwt: jwtToken });
});

// ====== ЛОГИН ======
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = dbGet('users', username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const hash = crypto.pbkdf2Sync(password, user.salt, 10000, 64, 'sha512').toString('hex');
  if (hash !== user.hash) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const newToken = crypto.randomBytes(32).toString('hex');
  user.token = newToken;
  dbPut('users', username, user);

  const jwtToken = generateJWT({ username });
  res.json({ username, token: newToken, jwt: jwtToken });
});

// ====== ОТПРАВКА ПИСЬМА С МОДЕРАЦИЕЙ ======
app.post('/email/send', requireAuth, async (req, res) => {
  const { to, subject, body } = req.body;
  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'To, subject and body required' });
  }

  // Модерация темы и текста
  const subjectMod = await checkModerationAndBan(subject, req, res);
  if (subjectMod.banned) {
    return res.redirect('/ban.html');
  }

  const bodyMod = await checkModerationAndBan(body, req, res);
  if (bodyMod.banned) {
    return res.redirect('/ban.html');
  }

  // Сохраняем письмо
  const emailId = Date.now() + '_' + crypto.randomBytes(4).toString('hex');
  const emailData = {
    id: emailId,
    from: req.user.username,
    to,
    subject,
    body,
    timestamp: Date.now(),
    read: false
  };

  // Сохраняем в inbox получателя
  const inbox = dbGet('inboxes', to) || [];
  inbox.push(emailData);
  dbPut('inboxes', to, inbox);

  // И в outbox отправителя
  const outbox = dbGet('outboxes', req.user.username) || [];
  outbox.push({ ...emailData, to });
  dbPut('outboxes', req.user.username, outbox);

  res.json({ ok: true, id: emailId });
});

// ====== ПОЛУЧЕНИЕ ВХОДЯЩИХ ======
app.get('/email/inbox', requireAuth, (req, res) => {
  const inbox = dbGet('inboxes', req.user.username) || [];
  inbox.sort((a, b) => b.timestamp - a.timestamp);
  res.json(inbox);
});

// ====== ПОЛУЧЕНИЕ ИСХОДЯЩИХ ======
app.get('/email/outbox', requireAuth, (req, res) => {
  const outbox = dbGet('outboxes', req.user.username) || [];
  outbox.sort((a, b) => b.timestamp - a.timestamp);
  res.json(outbox);
});

// ====== ПРОЧИТАТЬ ПИСЬМО ======
app.get('/email/read/:id', requireAuth, (req, res) => {
  const inbox = dbGet('inboxes', req.user.username) || [];
  const email = inbox.find(e => e.id === req.params.id);
  if (!email) {
    return res.status(404).json({ error: 'Email not found' });
  }
  email.read = true;
  dbPut('inboxes', req.user.username, inbox);
  res.json(email);
});

// ====== УДАЛИТЬ ПИСЬМО ======
app.delete('/email/delete/:id', requireAuth, (req, res) => {
  const inbox = dbGet('inboxes', req.user.username) || [];
  const filtered = inbox.filter(e => e.id !== req.params.id);
  dbPut('inboxes', req.user.username, filtered);
  res.json({ ok: true });
});

// ====== ЧЕРНОВИКИ С МОДЕРАЦИЕЙ ======
app.post('/email/save-draft', requireAuth, async (req, res) => {
  const { id, to, subject, body } = req.body;

  // Модерация черновика
  if (subject) {
    const subjectMod = await checkModerationAndBan(subject, req, res);
    if (subjectMod.banned) return res.redirect('/ban.html');
  }
  if (body) {
    const bodyMod = await checkModerationAndBan(body, req, res);
    if (bodyMod.banned) return res.redirect('/ban.html');
  }

  const drafts = dbGet('drafts', req.user.username) || [];
  if (id) {
    const index = drafts.findIndex(d => d.id === id);
    if (index !== -1) {
      drafts[index] = { ...drafts[index], to, subject, body, updatedAt: Date.now() };
    } else {
      drafts.push({ id: Date.now() + '_' + crypto.randomBytes(4).toString('hex'), to, subject, body, updatedAt: Date.now() });
    }
  } else {
    drafts.push({ id: Date.now() + '_' + crypto.randomBytes(4).toString('hex'), to, subject, body, updatedAt: Date.now() });
  }
  dbPut('drafts', req.user.username, drafts);
  res.json({ ok: true });
});

app.get('/email/drafts', requireAuth, (req, res) => {
  const drafts = dbGet('drafts', req.user.username) || [];
  drafts.sort((a, b) => b.updatedAt - a.updatedAt);
  res.json(drafts);
});

app.delete('/email/draft/:id', requireAuth, (req, res) => {
  const drafts = dbGet('drafts', req.user.username) || [];
  const filtered = drafts.filter(d => d.id !== req.params.id);
  dbPut('drafts', req.user.username, filtered);
  res.json({ ok: true });
});

// ====== ВЕРИФИКАЦИЯ ======
app.post('/verify', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });
  const decoded = verifyJWT(token);
  if (!decoded) return res.status(401).json({ error: 'Invalid token' });
  res.json({ username: decoded.username });
});

// ====== ИНФОРМАЦИЯ О БАНЕ ======
app.get('/ban-info', (req, res) => {
  const ip = getClientIP(req);
  const banData = dbGet('banned_ips', ip);
  if (!banData) {
    return res.status(404).json({ error: 'Not banned' });
  }
  res.json({
    banned: true,
    message: banData.message || 'Нарушение правил',
    bannedAt: banData.bannedAt
  });
});

// ====== АДМИН-ПАНЕЛЬ ======
function isAdmin(req, res, next) {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const decoded = verifyJWT(auth);
  if (!decoded || decoded.username !== ADMIN_LOGIN) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  req.user = decoded;
  next();
}

app.get('/admin/users', isAdmin, (req, res) => {
  const users = dbList('users');
  const result = users.map(u => {
    const data = dbGet('users', u);
    return { username: data.username, created: data.created || 0 };
  });
  res.json(result);
});

app.get('/admin/stats', isAdmin, (req, res) => {
  const users = dbList('users');
  const banned = dbList('banned_ips');
  res.json({
    users: users.length,
    banned: banned.length
  });
});

app.get('/admin/violations', isAdmin, (req, res) => {
  const ips = dbList('banned_ips');
  const result = ips.map(ip => {
    const data = dbGet('banned_ips', ip);
    return { ip, ...data };
  });
  res.json(result);
});

app.post('/admin/unban', isAdmin, (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP required' });
  dbDelete('banned_ips', ip);
  res.json({ ok: true });
});

// ====== BAN.HTML (статический файл) ======
// Файл ban.html должен лежать в папке public

// ====== ЗАПУСК ======
app.listen(PORT, () => {
  console.log(`🛡️ SkyMail_REBORN running on port ${PORT}`);
  console.log(`🔒 JWT_SECRET: ${JWT_SECRET}`);
});
