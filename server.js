// server.js — SkyMail с модерацией (совместим с клиентом)
const express = require('express');
const session = require('cookie-session');
const bcrypt = require('bcrypt');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// -------------------- Конфигурация --------------------
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const EMAILS_FILE = path.join(DATA_DIR, 'emails.json');

// Гарантируем наличие папки data
fs.mkdir(DATA_DIR, { recursive: true }).catch(console.error);

// -------------------- Загрузка/сохранение данных --------------------
let users = [];
let emails = {}; // { "user@skymail.ru": { inbox: [...], sent: [...], drafts: [...], trash: [...] } }

async function loadData() {
    try {
        const usersData = await fs.readFile(USERS_FILE, 'utf-8');
        users = JSON.parse(usersData);
    } catch (err) {
        users = [];
    }
    try {
        const emailsData = await fs.readFile(EMAILS_FILE, 'utf-8');
        emails = JSON.parse(emailsData);
    } catch (err) {
        emails = {};
    }
}

async function saveUsers() {
    await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

async function saveEmails() {
    await fs.writeFile(EMAILS_FILE, JSON.stringify(emails, null, 2));
}

// Инициализация данных
loadData().then(() => {
    console.log('Data loaded.');
});

// -------------------- Вспомогательные функции --------------------
function generateId() {
    return crypto.randomUUID();
}

function getUserByUsername(username) {
    return users.find(u => u.username === username);
}

function getUserEmail(username) {
    return `${username}@skymail.ru`;
}

// Получить папку пользователя (создать, если отсутствует)
function getUserFolder(userEmail, folder) {
    if (!emails[userEmail]) {
        emails[userEmail] = { inbox: [], sent: [], drafts: [], trash: [] };
    }
    if (!emails[userEmail][folder]) {
        emails[userEmail][folder] = [];
    }
    return emails[userEmail][folder];
}

// Сохранить письмо в папку пользователя
function saveEmailToFolder(userEmail, email, folder) {
    const folderData = getUserFolder(userEmail, folder);
    folderData.push(email);
}

// Поиск письма по id в папках пользователя (возвращает { folder, index, item })
function findEmailInUser(userEmail, emailId) {
    const userEmails = emails[userEmail];
    if (!userEmails) return null;
    for (const folder of ['inbox', 'sent', 'drafts', 'trash']) {
        const list = userEmails[folder] || [];
        const idx = list.findIndex(e => e.id === emailId);
        if (idx !== -1) {
            return { folder, index: idx, item: list[idx] };
        }
    }
    return null;
}

// Отправить реальное письмо через SMTP (если настроен)
async function sendExternalEmail(from, to, subject, body) {
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });

    try {
        const info = await transporter.sendMail({
            from,
            to,
            subject,
            text: body,
        });
        console.log(`Email sent to ${to}: ${info.messageId}`);
        return true;
    } catch (err) {
        console.error(`Failed to send email to ${to}:`, err.message);
        return false;
    }
}

// -------------------- Модерация --------------------
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

async function checkModerationAndBan(text, ip) {
    if (!text) return { banned: false };

    // 1. Стоп-лист
    if (containsBannedWords(text)) {
        await banIP(ip, text);
        return { banned: true, reason: 'Запрещённые слова' };
    }

    // 2. ИИ-модерация
    const aiResult = await moderateWithAI(text);
    if (aiResult && Array.isArray(aiResult) && aiResult.length > 0) {
        const toxic = aiResult.find(item => item.label === 'toxic');
        if (toxic && toxic.score > 0.7) {
            await banIP(ip, text);
            return { banned: true, reason: 'Токсичный контент (ИИ)' };
        }
    }

    return { banned: false };
}

async function banIP(ip, reason) {
    const cleanIp = ip.split(',')[0].split(':')[0];
    const BANNED_FILE = path.join(DATA_DIR, 'banned_ips.json');
    let banned = [];
    try {
        const data = await fs.readFile(BANNED_FILE, 'utf-8');
        banned = JSON.parse(data);
    } catch (e) {
        banned = [];
    }
    if (!banned.find(b => b.ip === cleanIp)) {
        banned.push({ ip: cleanIp, bannedAt: Date.now(), reason: reason || 'Нарушение правил' });
        await fs.writeFile(BANNED_FILE, JSON.stringify(banned, null, 2));
        console.log(`🚫 IP ${cleanIp} забанен за: "${reason}"`);
    }
}

async function isIPBanned(ip) {
    const cleanIp = ip.split(',')[0].split(':')[0];
    const BANNED_FILE = path.join(DATA_DIR, 'banned_ips.json');
    try {
        const data = await fs.readFile(BANNED_FILE, 'utf-8');
        const banned = JSON.parse(data);
        return banned.find(b => b.ip === cleanIp) || null;
    } catch (e) {
        return null;
    }
}

function getClientIP(req) {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
    return ip.split(':')[0];
}

// Middleware проверки бана
app.use(async (req, res, next) => {
    if (req.path === '/ban.html' || req.path === '/favicon.ico') {
        return next();
    }
    const ip = getClientIP(req);
    const banned = await isIPBanned(ip);
    if (banned) {
        const isApi = req.path.startsWith('/api/') ||
                      req.path === '/register' ||
                      req.path === '/login' ||
                      req.path === '/verify' ||
                      req.path === '/ban-info' ||
                      req.path.startsWith('/email/') ||
                      req.path === '/me' ||
                      req.path === '/logout' ||
                      req.path === '/search';
        if (isApi) {
            return res.status(403).json({ error: 'Banned', message: banned.reason || 'Ваш IP заблокирован' });
        }
        return res.redirect('/ban.html');
    }
    next();
});

// -------------------- Сессии (как в оригинале) --------------------
app.use(express.json());
app.use(express.static(__dirname));

app.use(session({
    name: 'session',
    secret: process.env.SESSION_SECRET || 'skymail-secret-key-change-in-production',
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
}));

function requireAuth(req, res, next) {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Не авторизован' });
    }
    next();
}

// -------------------- API Маршруты (совместимые с клиентом) --------------------

// Регистрация с модерацией
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Имя и пароль обязательны' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        return res.status(400).json({ error: 'Имя может содержать только латиницу, цифры и подчёркивание' });
    }
    if (getUserByUsername(username)) {
        return res.status(400).json({ error: 'Пользователь с таким именем уже существует' });
    }

    // Модерация логина
    const ip = getClientIP(req);
    const modResult = await checkModerationAndBan(username, ip);
    if (modResult.banned) {
        return res.status(403).json({ error: `Доступ запрещён: ${modResult.reason}` });
    }
    // Можно также проверить пароль, но для простоты пропустим

    const hash = await bcrypt.hash(password, 10);
    users.push({ username, passwordHash: hash });
    await saveUsers();
    res.status(201).json({ message: 'Регистрация успешна' });
});

// Логин
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Имя и пароль обязательны' });
    }
    const user = getUserByUsername(username);
    if (!user) {
        return res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
    }
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
        return res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
    }
    req.session.user = username;
    res.json({ message: 'Вход выполнен', username });
});

// Логаут
app.get('/logout', (req, res) => {
    req.session = null;
    res.json({ message: 'Выход выполнен' });
});

// Получить информацию о текущем пользователе
app.get('/me', requireAuth, (req, res) => {
    res.json({ username: req.session.user });
});

// Получить письма из папки (inbox, sent, drafts, trash)
app.get('/emails/:folder', requireAuth, async (req, res) => {
    const folder = req.params.folder;
    if (!['inbox', 'sent', 'drafts', 'trash'].includes(folder)) {
        return res.status(400).json({ error: 'Некорректная папка' });
    }
    const userEmail = getUserEmail(req.session.user);
    const folderData = getUserFolder(userEmail, folder);
    const sorted = folderData.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(sorted);
});

// Отправить письмо с модерацией
app.post('/email/send', requireAuth, async (req, res) => {
    const { to, subject, body } = req.body;
    if (!to || !subject || !body) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }

    const ip = getClientIP(req);
    const subjectMod = await checkModerationAndBan(subject, ip);
    if (subjectMod.banned) {
        return res.status(403).json({ error: `Тема содержит запрещённый контент: ${subjectMod.reason}` });
    }
    const bodyMod = await checkModerationAndBan(body, ip);
    if (bodyMod.banned) {
        return res.status(403).json({ error: `Текст содержит запрещённый контент: ${bodyMod.reason}` });
    }

    const sender = req.session.user;
    const senderEmail = getUserEmail(sender);
    const date = new Date().toISOString();

    const recipientUsername = to.split('@')[0];
    const recipientDomain = to.split('@')[1];
    const isLocal = (recipientDomain === 'skymail.ru' && getUserByUsername(recipientUsername));

    // Создаём письмо для отправителя (в папку sent)
    const sentEmail = {
        id: generateId(),
        from: senderEmail,
        to,
        subject,
        body,
        date,
        read: false,
        folder: 'sent',
    };
    saveEmailToFolder(senderEmail, sentEmail, 'sent');

    // Если получатель локальный, сохраняем в его inbox
    if (isLocal) {
        const recipientEmail = getUserEmail(recipientUsername);
        const inboxEmail = {
            id: generateId(),
            from: senderEmail,
            to,
            subject,
            body,
            date,
            read: false,
            folder: 'inbox',
        };
        saveEmailToFolder(recipientEmail, inboxEmail, 'inbox');
        await saveEmails();
        return res.json({ message: 'Письмо отправлено локальному пользователю' });
    }

    // Получатель внешний — пытаемся отправить через SMTP
    let smtpSent = false;
    if (process.env.SMTP_HOST && process.env.SMTP_USER) {
        smtpSent = await sendExternalEmail(senderEmail, to, subject, body);
    } else {
        console.log(`SMTP не настроен, письмо для ${to} не отправлено реально`);
    }

    await saveEmails();
    res.json({
        message: smtpSent
            ? 'Письмо отправлено внешнему адресату'
            : 'Письмо сохранено в отправленных, но не доставлено (SMTP не настроен)'
    });
});

// Сохранить черновик с модерацией
app.post('/email/save-draft', requireAuth, async (req, res) => {
    const { id, to, subject, body } = req.body;
    if (!to || !subject || !body) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }

    const ip = getClientIP(req);
    const subjectMod = await checkModerationAndBan(subject, ip);
    if (subjectMod.banned) {
        return res.status(403).json({ error: `Тема содержит запрещённый контент: ${subjectMod.reason}` });
    }
    const bodyMod = await checkModerationAndBan(body, ip);
    if (bodyMod.banned) {
        return res.status(403).json({ error: `Текст содержит запрещённый контент: ${bodyMod.reason}` });
    }

    const senderEmail = getUserEmail(req.session.user);
    const drafts = getUserFolder(senderEmail, 'drafts');

    if (id) {
        const idx = drafts.findIndex(e => e.id === id);
        if (idx === -1) {
            return res.status(404).json({ error: 'Черновик не найден' });
        }
        drafts[idx].to = to;
        drafts[idx].subject = subject;
        drafts[idx].body = body;
        drafts[idx].date = new Date().toISOString();
    } else {
        const draft = {
            id: generateId(),
            from: senderEmail,
            to,
            subject,
            body,
            date: new Date().toISOString(),
            read: false,
            folder: 'drafts',
        };
        drafts.push(draft);
    }
    await saveEmails();
    res.json({ message: 'Черновик сохранён' });
});

// Пометить письмо как прочитанное (только для inbox)
app.put('/email/:id/read', requireAuth, async (req, res) => {
    const emailId = req.params.id;
    const userEmail = getUserEmail(req.session.user);
    const found = findEmailInUser(userEmail, emailId);
    if (!found) {
        return res.status(404).json({ error: 'Письмо не найдено' });
    }
    if (found.folder !== 'inbox') {
        return res.status(400).json({ error: 'Пометка прочтения доступна только для входящих' });
    }
    found.item.read = true;
    await saveEmails();
    res.json({ message: 'Письмо отмечено как прочитанное' });
});

// Переместить письмо в другую папку (включая корзину и восстановление)
app.put('/email/:id/move', requireAuth, async (req, res) => {
    const { targetFolder } = req.body;
    if (!['trash', 'inbox', 'sent', 'drafts'].includes(targetFolder)) {
        return res.status(400).json({ error: 'Некорректная папка назначения' });
    }
    const emailId = req.params.id;
    const userEmail = getUserEmail(req.session.user);
    const found = findEmailInUser(userEmail, emailId);
    if (!found) {
        return res.status(404).json({ error: 'Письмо не найдено' });
    }
    const { folder: currentFolder, index, item } = found;
    if (currentFolder === targetFolder) {
        return res.json({ message: 'Письмо уже в этой папке' });
    }
    // Удаляем из текущей папки
    const currentList = getUserFolder(userEmail, currentFolder);
    currentList.splice(index, 1);
    // Добавляем в целевую
    if (targetFolder === 'trash') {
        item.originalFolder = currentFolder;
    } else {
        delete item.originalFolder;
    }
    item.folder = targetFolder;
    const targetList = getUserFolder(userEmail, targetFolder);
    targetList.push(item);
    await saveEmails();
    res.json({ message: `Письмо перемещено в ${targetFolder}` });
});

// Окончательное удаление письма
app.delete('/email/:id', requireAuth, async (req, res) => {
    const emailId = req.params.id;
    const userEmail = getUserEmail(req.session.user);
    const found = findEmailInUser(userEmail, emailId);
    if (!found) {
        return res.status(404).json({ error: 'Письмо не найдено' });
    }
    const { folder, index } = found;
    const list = getUserFolder(userEmail, folder);
    list.splice(index, 1);
    await saveEmails();
    res.json({ message: 'Письмо окончательно удалено' });
});

// Поиск по письмам
app.get('/search', requireAuth, async (req, res) => {
    const q = req.query.q || '';
    if (!q.trim()) {
        return res.json([]);
    }
    const userEmail = getUserEmail(req.session.user);
    const userEmails = emails[userEmail];
    if (!userEmails) return res.json([]);
    const results = [];
    for (const folder of ['inbox', 'sent', 'drafts', 'trash']) {
        const list = userEmails[folder] || [];
        for (const email of list) {
            if (email.subject.toLowerCase().includes(q.toLowerCase()) ||
                email.body.toLowerCase().includes(q.toLowerCase())) {
                results.push({ ...email, folder });
            }
        }
    }
    results.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(results);
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.get('/heal', (req, res) => {
    res.redirect('/health');
});

// -------------------- Запуск сервера --------------------
app.listen(PORT, () => {
    console.log(`✈️ SkyMail с модерацией запущен на http://localhost:${PORT}`);
});
