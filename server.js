// server.js — основной сервер SkyMail

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

// -------------------- Middleware --------------------
app.use(express.json());
app.use(express.static(__dirname)); // для отдачи index.html

// Сессии (httpOnly, зашифрованные)
app.use(session({
    name: 'session',
    secret: 'skymail-secret-key-change-in-production',
    maxAge: 24 * 60 * 60 * 1000, // 24 часа
    httpOnly: true,
    sameSite: 'lax',
}));

// Проверка аутентификации
function requireAuth(req, res, next) {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Не авторизован' });
    }
    next();
}

// -------------------- API Маршруты --------------------

// Регистрация
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Имя и пароль обязательны' });
    }
    // Проверка на допустимые символы (латиница, цифры, подчёркивание)
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        return res.status(400).json({ error: 'Имя может содержать только латиницу, цифры и подчёркивание' });
    }
    if (getUserByUsername(username)) {
        return res.status(400).json({ error: 'Пользователь с таким именем уже существует' });
    }
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

// Получить письма из папки
app.get('/emails/:folder', requireAuth, async (req, res) => {
    const folder = req.params.folder;
    if (!['inbox', 'sent', 'drafts', 'trash'].includes(folder)) {
        return res.status(400).json({ error: 'Некорректная папка' });
    }
    const userEmail = getUserEmail(req.session.user);
    const folderData = getUserFolder(userEmail, folder);
    // Сортировка от новых к старым по дате
    const sorted = folderData.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(sorted);
});

// Отправить письмо
app.post('/email/send', requireAuth, async (req, res) => {
    const { to, subject, body } = req.body;
    if (!to || !subject || !body) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }
    const sender = req.session.user;
    const senderEmail = getUserEmail(sender);
    const date = new Date().toISOString();

    // Проверяем, зарегистрирован ли получатель в SkyMail
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
        read: false, // для sent не используется, но оставим
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

// Сохранить черновик
app.post('/email/save-draft', requireAuth, async (req, res) => {
    const { id, to, subject, body } = req.body;
    if (!to || !subject || !body) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }
    const senderEmail = getUserEmail(req.session.user);
    const drafts = getUserFolder(senderEmail, 'drafts');

    if (id) {
        // Обновить существующий черновик
        const idx = drafts.findIndex(e => e.id === id);
        if (idx === -1) {
            return res.status(404).json({ error: 'Черновик не найден' });
        }
        drafts[idx].to = to;
        drafts[idx].subject = subject;
        drafts[idx].body = body;
        drafts[idx].date = new Date().toISOString();
    } else {
        // Новый черновик
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

// Переместить письмо в другую папку
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
    // Если перемещаем в ту же папку — ничего не делаем
    if (currentFolder === targetFolder) {
        return res.json({ message: 'Письмо уже в этой папке' });
    }
    // Удаляем из текущей папки
    const currentList = getUserFolder(userEmail, currentFolder);
    currentList.splice(index, 1);
    // Добавляем в целевую
    // При перемещении в корзину запоминаем исходную папку
    if (targetFolder === 'trash') {
        item.originalFolder = currentFolder; // запоминаем, откуда пришло
    } else {
        // Если восстанавливаем из корзины, используем originalFolder, если есть
        if (currentFolder === 'trash' && item.originalFolder) {
            // Возвращаем в исходную папку (но можно и в указанную, если явно)
            // В нашем случае targetFolder может быть 'inbox' или 'sent' или 'drafts'
            // но для восстановления лучше использовать originalFolder, если он есть
            // Если пользователь явно указал другую папку, используем её
            // Здесь мы используем targetFolder, но если он не совпадает с originalFolder,
            // то перемещаем в targetFolder, но сохраняем новый originalFolder?
            // Упростим: при восстановлении из корзины всегда используем originalFolder,
            // если он не задан, то в inbox.
            if (item.originalFolder && targetFolder === 'inbox') {
                // Если явно восстановили в inbox, но originalFolder был sent, то лучше вернуть в sent?
                // Позволим пользователю выбрать папку при восстановлении? 
                // В интерфейсе мы можем дать кнопку "Восстановить" которая перемещает в originalFolder или inbox.
                // Для простоты будем перемещать в targetFolder, который приходит.
                // Но сохраним originalFolder, если он ещё не задан.
            }
        }
        // Если перемещаем не из корзины, просто меняем папку
        // При этом стираем originalFolder, если он был (например, если пользователь перемещает из inbox в sent)
        delete item.originalFolder;
    }
    // Добавляем в целевую папку
    const targetList = getUserFolder(userEmail, targetFolder);
    // Обновляем folder у письма
    item.folder = targetFolder;
    targetList.push(item);
    await saveEmails();
    res.json({ message: `Письмо перемещено в ${targetFolder}` });
});

// Окончательное удаление письма (из любой папки, но обычно из корзины)
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

// Поиск по письмам (по теме или тексту) — опционально
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
                results.push({ ...email, folder }); // добавляем информацию о папке
            }
        }
    }
    // Сортировка по дате
    results.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(results);
});

// Получить информацию о текущем пользователе
app.get('/me', requireAuth, (req, res) => {
    res.json({ username: req.session.user });
});
// Health check endpoints (для Render и других хостингов)
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Если вы хотели именно /heal – добавьте и его, например, как алиас:
app.get('/heal', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
// -------------------- Запуск сервера --------------------
app.listen(PORT, () => {
    console.log(`SkyMail сервер запущен на http://localhost:${PORT}`);
});
