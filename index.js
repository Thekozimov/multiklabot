'use strict';
/**
 * Multfilmlar Olami boti v3.1
 * Node.js 24.21.0 uchun moslangan (dotenv o'rniga o'rnatilgan process.loadEnvFile).
 */
process.env.NTBA_FIX_319 = '1';
process.env.NTBA_FIX_350 = '1';

const fs = require('node:fs');
const path = require('node:path');

// .env faylini Node'ning o'zi o'qiydi (dotenv kerak emas). Fayl bo'lmasa — jim o'tadi.
try {
    process.loadEnvFile(path.join(__dirname, '.env'));
} catch (e) {
    if (e.code !== 'ENOENT') throw e;
}

// Kutubxona versiyasiga qarab eksport shakli farq qilishi mumkin (sinf yoki { default } / { TelegramBot })
const tgModule = require('node-telegram-bot-api');
const TelegramBot = typeof tgModule === 'function'
    ? tgModule
    : (tgModule.default || tgModule.TelegramBot);
if (typeof TelegramBot !== 'function') {
    console.error("❌ node-telegram-bot-api to'g'ri o'rnatilmagan. Bajaring: npm install node-telegram-bot-api@0.66.0");
    process.exit(1);
}

/* ============================ SOZLAMALAR ============================ */

const TOKEN = (process.env.BOT_TOKEN || '').trim();
const ADMIN_IDS = String(process.env.ADMIN_ID || '')
    .split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
const OWNER_ID = ADMIN_IDS[0];
const ENV_CHANNELS = String(process.env.CHANNEL_USERNAME || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => (s.startsWith('@') ? s : '@' + s));

if (!TOKEN || !OWNER_ID) {
    console.error("❌ Xatolik: .env faylida BOT_TOKEN va ADMIN_ID ko'rsatilishi shart!");
    process.exit(1);
}

const DB_FILE = path.join(__dirname, 'database.json');
const LOG_DIR = path.join(__dirname, 'logs');
const BACKUP_DIR = path.join(__dirname, 'backups');
const PAGE_SIZE = 8;
const SUB_CACHE_MS = 2 * 60 * 1000;
const BACKUP_EVERY_MS = 24 * 60 * 60 * 1000;
const RATE_MAX = Number(process.env.RATE_MAX) || 12; // 10 soniyada ruxsat etilgan amallar
const BROADCAST_DELAY_MS = 45; // ~22 xabar/soniya (Telegram limiti 30)

/* ================================ LOG =============================== */

function log(level, ...args) {
    const text = args.map((a) => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch (e) { return String(a); }
    }).join(' ');
    const line = '[' + new Date().toISOString() + '] [' + level + '] ' + text;
    console.log(line);
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
        const file = path.join(LOG_DIR, 'bot.log');
        if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) {
            fs.renameSync(file, path.join(LOG_DIR, 'bot.old.log'));
        }
        fs.appendFileSync(file, line + '\n');
    } catch (e) { /* log yozilmasa ham bot ishlayveradi */ }
}

/* ============================== BAZA ================================ */

let db;
let saveTimer = null;

function emptyDB() {
    return {
        movies: {}, users: {}, lastCode: 0,
        requests: [], lastRequestId: 0,
        channels: [], categories: [], admins: [],
        queries: {}, missed: {},
        stats: { daily: {} },
        settings: { protect: false, autopost: true }
    };
}

function newUser(name) {
    return { name: name || '', lang: 'uz', joined: new Date().toISOString(), blocked: false, banned: false, favs: [] };
}

function normPart(p) {
    if (!p) return null;
    if (typeof p === 'string') p = { id: p, type: 'video' };
    if (!p.id || String(p.id).indexOf('...') !== -1) return null; // yaroqsiz (namuna) fileId
    return { id: String(p.id), type: ['video', 'animation', 'document'].indexOf(p.type) !== -1 ? p.type : 'video' };
}

function normalizeDB(d) {
    const out = emptyDB();
    if (!d || typeof d !== 'object') d = {};

    if (Array.isArray(d.users)) {
        d.users.forEach((id) => { out.users[String(id)] = newUser(''); });
    } else if (d.users && typeof d.users === 'object') {
        Object.keys(d.users).forEach((id) => {
            const u = Object.assign(newUser(''), d.users[id]);
            if (!Array.isArray(u.favs)) u.favs = [];
            if (u.lang !== 'ru') u.lang = 'uz';
            out.users[String(id)] = u;
        });
    }

    let maxCode = 0;
    const movies = d.movies && typeof d.movies === 'object' ? d.movies : {};
    Object.keys(movies).forEach((code) => {
        const m = movies[code];
        if (!m) return;
        let parts = [];
        if (Array.isArray(m.parts)) parts = m.parts.map(normPart).filter(Boolean);
        else if (m.fileId) parts = [normPart(m.fileId)].filter(Boolean);
        if (!parts.length) { log('warn', "Yaroqsiz yozuv o'tkazib yuborildi (kod " + code + ')'); return; }
        out.movies[String(code)] = {
            title: String(m.title || 'Nomsiz'),
            category: m.category ? String(m.category) : '',
            tags: Array.isArray(m.tags) ? m.tags.map(String) : [],
            poster: m.poster ? String(m.poster) : '',
            trailer: normPart(m.trailer),
            parts: parts,
            views: Number(m.views) || 0,
            likes: Array.isArray(m.likes) ? m.likes : [],
            dislikes: Array.isArray(m.dislikes) ? m.dislikes : [],
            added: m.added || ''
        };
        if (Number(code) > maxCode) maxCode = Number(code);
    });
    out.lastCode = Math.max(Number(d.lastCode) || 0, maxCode);

    let maxReq = Number(d.lastRequestId) || 0;
    (Array.isArray(d.requests) ? d.requests : []).forEach((r) => {
        if (!r) return;
        if (!r.id) r.id = ++maxReq;
        if (r.id > maxReq) maxReq = r.id;
        out.requests.push({
            id: r.id, userId: r.userId, name: r.name || '', text: String(r.text || ''),
            date: r.date || '', done: !!r.done
        });
    });
    out.lastRequestId = maxReq;

    out.channels = Array.isArray(d.channels) ? d.channels.filter(Boolean) : [];
    out.categories = Array.isArray(d.categories) ? d.categories.filter(Boolean) : [];
    out.admins = Array.isArray(d.admins) ? d.admins.map(Number).filter((n) => n > 0) : [];
    out.queries = d.queries && typeof d.queries === 'object' ? d.queries : {};
    out.missed = d.missed && typeof d.missed === 'object' ? d.missed : {};
    out.stats = d.stats && typeof d.stats === 'object' && d.stats.daily ? d.stats : { daily: {} };
    out.settings = Object.assign(out.settings, d.settings || {});
    return out;
}

function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function writeAtomic(data) {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    if (fs.existsSync(DB_FILE)) {
        try { fs.copyFileSync(DB_FILE, DB_FILE + '.bak'); } catch (e) { /* zaxira bo'lmasa ham davom etamiz */ }
    }
    fs.renameSync(tmp, DB_FILE);
}

function loadDB() {
    if (!fs.existsSync(DB_FILE)) {
        const fresh = emptyDB();
        writeAtomic(fresh);
        return fresh;
    }
    try {
        return normalizeDB(readJSON(DB_FILE));
    } catch (err) {
        log('error', "database.json o'qilmadi (buzilgan):", err.message);
        const corrupt = DB_FILE + '.corrupt-' + Date.now();
        try { fs.renameSync(DB_FILE, corrupt); log('warn', 'Buzilgan fayl saqlandi:', corrupt); } catch (e) { /* ignore */ }
        if (fs.existsSync(DB_FILE + '.bak')) {
            try {
                const restored = normalizeDB(readJSON(DB_FILE + '.bak'));
                writeAtomic(restored);
                log('warn', '✅ Baza .bak zaxirasidan tiklandi.');
                return restored;
            } catch (e) { log('error', '.bak ham buzilgan:', e.message); }
        }
        console.error("❌ Baza buzilgan va tiklab bo'lmadi. Buzilgan nusxa saqlandi:", corrupt);
        process.exit(1);
    }
}

function saveNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try { writeAtomic(db); } catch (e) { log('error', 'Bazani saqlashda xato:', e); }
}

function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 400);
}

/* ============================ YORDAMCHILAR ========================== */

function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function todayKey() {
    return new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10); // Toshkent vaqti
}

function statInc(field) {
    const k = todayKey();
    const d = db.stats.daily[k] || (db.stats.daily[k] = { newUsers: 0, views: 0, searches: 0 });
    d[field] = (d[field] || 0) + 1;
    scheduleSave();
}

function pruneStats() {
    const keys = Object.keys(db.stats.daily).sort();
    while (keys.length > 60) delete db.stats.daily[keys.shift()];
}

function isAdmin(id) { return ADMIN_IDS.indexOf(id) !== -1 || db.admins.indexOf(id) !== -1; }
function isOwner(id) { return id === OWNER_ID; }
function allAdmins() { return ADMIN_IDS.concat(db.admins.filter((a) => ADMIN_IDS.indexOf(a) === -1)); }

function getMovie(code) {
    code = String(code);
    return Object.prototype.hasOwnProperty.call(db.movies, code) ? db.movies[code] : null;
}

function byNewest(a, b) {
    const ma = db.movies[a].added || '';
    const mb = db.movies[b].added || '';
    if (ma !== mb) return ma < mb ? 1 : -1;
    return Number(b) - Number(a);
}

function bumpCounter(obj, key) {
    obj[key] = (obj[key] || 0) + 1;
    const keys = Object.keys(obj);
    if (keys.length > 500) {
        keys.sort((a, b) => obj[a] - obj[b]).slice(0, 100).forEach((k) => { delete obj[k]; });
    }
}

function topOf(obj, n) {
    return Object.keys(obj).sort((a, b) => obj[b] - obj[a]).slice(0, n);
}

/* =============================== MATNLAR ============================ */

const TX = {
    uz: {
        welcome: (n) => 'Salom, <b>' + n + '</b>! 🎬 <b>Multfilmlar Olami</b> botiga xush kelibsiz.\n\nMultfilm <code>kodini</code> yoki <code>nomini</code> yozib yuboring, yoki pastdagi tugmalardan foydalaning:',
        btn_random: '🎲 Tasodifiy', btn_cats: '📂 Kategoriyalar', btn_top: '🔥 Top', btn_new: '🆕 Yangilar',
        btn_fav: '⭐ Sevimlilar', btn_order: '💡 Buyurtma / Aloqa', btn_lang: '🌐 Til / Язык',
        sub_needed: "⚠️ <b>Botdan foydalanish uchun quyidagi kanal(lar)ga obuna bo'ling!</b>",
        sub_check: '✅ Obunani tekshirish',
        sub_alert: "❌ Siz hali barcha kanallarga obuna bo'lmadingiz!",
        not_found: "❌ Kechirasiz, bunday multfilm topilmadi.\n\nIstasangiz, buyurtma berishingiz mumkin.",
        order_btn: '💡 Buyurtma berish',
        results: '🔎 <b>Topilgan natijalar:</b>',
        empty_db: "Hozircha bazada multfilmlar yo'q.",
        empty_list: "Bu yerda hozircha hech narsa yo'q.",
        list_top: "🔥 <b>Eng ko'p ko'rilganlar</b>", list_new: "🆕 <b>Yangi qo'shilganlar</b>",
        list_fav: '⭐ <b>Sevimlilaringiz</b>', list_all: '📚 <b>Barcha multfilmlar</b>',
        list_cat: (n) => '📂 <b>' + n + '</b>',
        cats_title: '📂 <b>Kategoriyani tanlang:</b>', cats_none: "Hozircha kategoriyalar yo'q.",
        all_btn: '📚 Barchasi', page: (p, t) => 'Sahifa ' + p + '/' + t,
        ask_request: "✍️ Ko'rmoqchi bo'lgan multfilmingiz nomini yozib yuboring.",
        request_sent: '✅ Xabaringiz adminlarga yetkazildi.',
        request_limit: "⏳ Sizda hali ko'rib chiqilmagan buyurtmalar ko'p. Iltimos, kuting.",
        fav_add: "⭐ Sevimlilarga qo'shildi", fav_del: "Sevimlilardan olib tashlandi",
        rated: 'Bahoyingiz qabul qilindi', rate_removed: 'Baho bekor qilindi',
        report_btn: '🚩 Shikoyat', reported: '✅ Shikoyat yuborildi. Rahmat!',
        reported_already: 'Siz allaqachon shikoyat yuborgansiz',
        video_error: "⚠️ Videoni yuborib bo'lmadi. Admin xabardor qilindi.",
        lang_pick: '🌐 Tilni tanlang / Выберите язык:', lang_set: "✅ Til o'zgartirildi.",
        watch: '▶️ Tomosha qilish', code: 'Kod', channel: 'Kanal', views: "Ko'rilgan",
        category: 'Kategoriya', tags: 'Teglar', expired: 'Bu tugma eskirgan'
    },
    ru: {
        welcome: (n) => 'Привет, <b>' + n + '</b>! 🎬 Добро пожаловать в бот <b>Мир мультфильмов</b>.\n\nОтправьте <code>код</code> или <code>название</code> мультфильма либо воспользуйтесь кнопками ниже:',
        btn_random: '🎲 Случайный', btn_cats: '📂 Категории', btn_top: '🔥 Топ', btn_new: '🆕 Новинки',
        btn_fav: '⭐ Избранное', btn_order: '💡 Заказ / Связь', btn_lang: '🌐 Til / Язык',
        sub_needed: '⚠️ <b>Чтобы пользоваться ботом, подпишитесь на канал(ы):</b>',
        sub_check: '✅ Проверить подписку',
        sub_alert: '❌ Вы ещё не подписались на все каналы!',
        not_found: '❌ К сожалению, такой мультфильм не найден.\n\nВы можете оставить заказ.',
        order_btn: '💡 Оставить заказ',
        results: '🔎 <b>Найдено:</b>',
        empty_db: 'В базе пока нет мультфильмов.',
        empty_list: 'Пока здесь ничего нет.',
        list_top: '🔥 <b>Самые просматриваемые</b>', list_new: '🆕 <b>Недавно добавленные</b>',
        list_fav: '⭐ <b>Ваше избранное</b>', list_all: '📚 <b>Все мультфильмы</b>',
        list_cat: (n) => '📂 <b>' + n + '</b>',
        cats_title: '📂 <b>Выберите категорию:</b>', cats_none: 'Категорий пока нет.',
        all_btn: '📚 Все', page: (p, t) => 'Страница ' + p + '/' + t,
        ask_request: '✍️ Напишите название мультфильма, который хотите посмотреть.',
        request_sent: '✅ Ваше сообщение передано администраторам.',
        request_limit: '⏳ У вас много необработанных заказов. Пожалуйста, подождите.',
        fav_add: '⭐ Добавлено в избранное', fav_del: 'Удалено из избранного',
        rated: 'Ваша оценка принята', rate_removed: 'Оценка отменена',
        report_btn: '🚩 Пожаловаться', reported: '✅ Жалоба отправлена. Спасибо!',
        reported_already: 'Вы уже отправляли жалобу',
        video_error: '⚠️ Не удалось отправить видео. Администратор уведомлён.',
        lang_pick: '🌐 Tilni tanlang / Выберите язык:', lang_set: '✅ Язык изменён.',
        watch: '▶️ Смотреть', code: 'Код', channel: 'Канал', views: 'Просмотров',
        category: 'Категория', tags: 'Теги', expired: 'Эта кнопка устарела'
    }
};

function tr(lang, key, ...rest) {
    const pack = TX[lang] || TX.uz;
    let v = pack[key];
    if (v === undefined) v = TX.uz[key];
    if (typeof v === 'function') return v(...rest);
    return v;
}

const MENU_KEYS = ['random', 'cats', 'top', 'new', 'fav', 'order', 'lang'];
const ADMIN_BTN = '⚙️ Admin Panel';

function menuAction(text) {
    if (text === ADMIN_BTN) return 'admin';
    for (let i = 0; i < MENU_KEYS.length; i++) {
        const k = MENU_KEYS[i];
        if (text === TX.uz['btn_' + k] || text === TX.ru['btn_' + k]) return k;
    }
    return null;
}

/* ============================== BOT ================================= */

const botOptions = { polling: false };
if (process.env.TG_API_URL) botOptions.baseApiUrl = process.env.TG_API_URL; // faqat sinov uchun
const bot = new TelegramBot(TOKEN, botOptions);

let BOT_USERNAME = '';
let BOT_ID = 0;

const states = new Map();      // 'a:<id>' (admin) yoki 'u:<id>' (foydalanuvchi) -> holat
const subCache = new Map();    // userId -> oxirgi muvaffaqiyatli tekshiruv vaqti
const hits = new Map();        // spamdan himoya
const reportedSet = new Set(); // 'userId:code'
const warnedChannels = new Set();
let broadcastRunning = false;

function send(chatId, text, opts) {
    return bot.sendMessage(chatId, text, opts).catch((e) => {
        log('warn', 'sendMessage xato', chatId, e && e.message);
        return null;
    });
}

function notifyAdmins(text, opts) {
    return Promise.all(allAdmins().map((id) => send(id, text, opts)));
}

function deepLink(code) {
    return 'https://t.me/' + BOT_USERNAME + '?start=m' + code;
}

function touchUser(from) {
    const id = String(from.id);
    let u = db.users[id];
    if (!u) {
        u = db.users[id] = newUser(from.first_name || '');
        statInc('newUsers');
        saveNow();
    } else {
        const name = from.first_name || '';
        if (name && u.name !== name) { u.name = name; scheduleSave(); }
        if (u.blocked) { u.blocked = false; scheduleSave(); }
    }
    return u;
}

function limited(userId) {
    if (isAdmin(userId)) return false;
    const now = Date.now();
    const arr = (hits.get(userId) || []).filter((t) => now - t < 10000);
    arr.push(now);
    hits.set(userId, arr);
    return arr.length > RATE_MAX;
}

setInterval(() => {
    const now = Date.now();
    hits.forEach((arr, id) => { if (!arr.length || now - arr[arr.length - 1] > 10000) hits.delete(id); });
    subCache.forEach((t, id) => { if (now - t > SUB_CACHE_MS) subCache.delete(id); });
}, 60 * 1000).unref();

/* ---------------------------- OBUNA TEKSHIRUVI ---------------------- */

async function missingChannels(userId) {
    if (isAdmin(userId) || !db.channels.length) return [];
    const cached = subCache.get(userId);
    if (cached && Date.now() - cached < SUB_CACHE_MS) return [];
    const missing = [];
    for (let i = 0; i < db.channels.length; i++) {
        const ch = db.channels[i];
        try {
            const m = await bot.getChatMember(ch, userId);
            const ok = ['member', 'administrator', 'creator'].indexOf(m.status) !== -1 ||
                (m.status === 'restricted' && m.is_member);
            if (!ok) missing.push(ch);
        } catch (e) {
            // Bot kanalda admin emas / kanal topilmadi: hamma bloklanib qolmasligi uchun o'tkazib yuboramiz
            log('error', 'getChatMember xato (' + ch + '):', e && e.message);
            if (!warnedChannels.has(ch)) {
                warnedChannels.add(ch);
                send(OWNER_ID, '⚠️ <b>' + escapeHTML(ch) + "</b> kanalida obunani tekshirib bo'lmadi. Bot shu kanalda <b>administrator</b> ekanini tekshiring.\nXato: <code>" + escapeHTML(e && e.message) + '</code>', { parse_mode: 'HTML' });
            }
        }
    }
    if (!missing.length) subCache.set(userId, Date.now());
    return missing;
}

function promptSubscribe(chatId, lang, missing, payload) {
    const rows = missing.map((ch) => [{ text: '📢 ' + ch, url: 'https://t.me/' + ch.replace('@', '') }]);
    rows.push([{ text: tr(lang, 'sub_check'), callback_data: 'check_sub' + (payload ? ':' + payload : '') }]);
    return send(chatId, tr(lang, 'sub_needed'), { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
}

async function gate(chatId, userId, user, payload) {
    const missing = await missingChannels(userId);
    if (!missing.length) return true;
    await promptSubscribe(chatId, user.lang, missing, payload);
    return false;
}

/* ------------------------------ QIDIRUV ----------------------------- */

function norm(s) {
    return String(s || '').toLowerCase()
        .replace(/[ʻʼ’'`´‘]/g, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ').trim();
}

function editDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = [];
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[b.length];
}

function similarity(a, b) {
    const longer = a.length >= b.length ? a : b;
    if (!longer.length) return 1;
    return (longer.length - editDistance(a, b)) / longer.length;
}

function scoreMovie(q, qWords, m) {
    const title = norm(m.title);
    const extra = norm((m.tags || []).join(' ') + ' ' + (m.category || ''));
    if (title === q) return 100;
    if (title.indexOf(q) !== -1) return 80 + 10 * (q.length / title.length);
    const tWords = title.split(' ');
    let sum = 0;
    qWords.forEach((w) => {
        if (title.indexOf(w) !== -1) { sum += 1; return; }
        if (extra.indexOf(w) !== -1) { sum += 0.8; return; }
        if (w.length >= 4) {
            let best = 0;
            tWords.forEach((tw) => { const s = similarity(w, tw); if (s > best) best = s; });
            if (best >= 0.75) sum += 0.7;
        }
    });
    const ratio = sum / qWords.length;
    if (ratio >= 0.5) return 30 + 40 * ratio;
    const sim = similarity(q, title);
    return sim >= 0.65 ? sim * 50 : 0;
}

function searchMovies(text) {
    const q = norm(text);
    if (!q) return [];
    const qWords = q.split(' ');
    const res = [];
    Object.keys(db.movies).forEach((code) => {
        const s = scoreMovie(q, qWords, db.movies[code]);
        if (s >= 30) res.push({ code: code, score: s });
    });
    res.sort((a, b) => b.score - a.score);
    return res;
}

/* ---------------------------- MULTFILM YUBORISH --------------------- */

function movieCaption(lang, code, m) {
    let c = '🎬 <b>' + escapeHTML(m.title) + '</b>\n🔑 ' + tr(lang, 'code') + ': <code>' + code + '</code>';
    if (m.category) c += '\n📂 ' + escapeHTML(m.category);
    if (m.tags && m.tags.length) c += '\n🏷 ' + escapeHTML(m.tags.join(', '));
    c += '\n👁 ' + m.views;
    if (db.channels.length) c += '\n\n📌 ' + tr(lang, 'channel') + ': ' + escapeHTML(db.channels[0]);
    return c;
}

function movieKeyboard(lang, code, m, idx, user) {
    const rows = [];
    if (m.parts.length > 1) {
        const nav = [];
        if (idx > 0) nav.push({ text: '◀️', callback_data: 'p:' + code + ':' + (idx - 1) });
        nav.push({ text: (idx + 1) + '/' + m.parts.length, callback_data: 'noop' });
        if (idx < m.parts.length - 1) nav.push({ text: '▶️', callback_data: 'p:' + code + ':' + (idx + 1) });
        rows.push(nav);
    }
    const fav = user && user.favs.indexOf(code) !== -1;
    rows.push([
        { text: fav ? '⭐✓' : '⭐', callback_data: 'f:' + code + ':' + idx },
        { text: '👍 ' + m.likes.length, callback_data: 'r:' + code + ':u:' + idx },
        { text: '👎 ' + m.dislikes.length, callback_data: 'r:' + code + ':d:' + idx }
    ]);
    rows.push([{ text: tr(lang, 'report_btn'), callback_data: 'x:' + code }]);
    return { inline_keyboard: rows };
}

function sendPart(chatId, part, opts) {
    if (part.type === 'animation') return bot.sendAnimation(chatId, part.id, opts);
    if (part.type === 'document') return bot.sendDocument(chatId, part.id, opts);
    return bot.sendVideo(chatId, part.id, opts);
}

async function sendMovie(chatId, userId, user, code, idx) {
    const lang = user.lang;
    const m = getMovie(code);
    if (!m) return send(chatId, tr(lang, 'not_found'), { parse_mode: 'HTML' });
    idx = Math.max(0, Math.min(Number(idx) || 0, m.parts.length - 1));
    const opts = {
        caption: movieCaption(lang, code, m),
        parse_mode: 'HTML',
        reply_markup: movieKeyboard(lang, code, m, idx, user)
    };
    if (db.settings.protect) opts.protect_content = true;
    try {
        await sendPart(chatId, m.parts[idx], opts);
        if (idx === 0) { m.views++; statInc('views'); }
    } catch (e) {
        log('error', 'Video yuborishda xato (kod ' + code + '):', e && e.message);
        send(chatId, tr(lang, 'video_error'));
        notifyAdmins('⚠️ Multfilm <code>' + code + '</code> (' + escapeHTML(m.title) + ") yuborilmadi: <code>" + escapeHTML(e && e.message) + '</code>\nfileId yaroqsiz bo\'lishi mumkin. /delete ' + code, { parse_mode: 'HTML' });
    }
}

/* ------------------------------- RO'YXATLAR ------------------------- */

function listCodes(type, arg, user) {
    const codes = Object.keys(db.movies);
    if (type === 'top') {
        return codes.filter((c) => db.movies[c].views > 0)
            .sort((a, b) => db.movies[b].views - db.movies[a].views).slice(0, 50);
    }
    if (type === 'new') return codes.sort(byNewest).slice(0, 30);
    if (type === 'cat') {
        const name = db.categories[Number(arg)];
        return codes.filter((c) => db.movies[c].category === name).sort(byNewest);
    }
    if (type === 'fav') return user.favs.filter((c) => getMovie(c));
    return codes.sort((a, b) => db.movies[a].title.localeCompare(db.movies[b].title));
}

async function showList(chatId, user, type, arg, page, editMsgId) {
    const lang = user.lang;
    const codes = listCodes(type, arg, user);
    let title;
    if (type === 'top') title = tr(lang, 'list_top');
    else if (type === 'new') title = tr(lang, 'list_new');
    else if (type === 'fav') title = tr(lang, 'list_fav');
    else if (type === 'cat') title = tr(lang, 'list_cat', escapeHTML(db.categories[Number(arg)] || '?'));
    else title = tr(lang, 'list_all');

    if (!codes.length) {
        return send(chatId, title + '\n\n' + tr(lang, 'empty_list'), { parse_mode: 'HTML' });
    }
    const pages = Math.ceil(codes.length / PAGE_SIZE);
    page = Math.max(0, Math.min(Number(page) || 0, pages - 1));
    const rows = codes.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((c) => [{
        text: db.movies[c].title.slice(0, 50), callback_data: 'm:' + c
    }]);
    if (pages > 1) {
        const nav = [];
        if (page > 0) nav.push({ text: '◀️', callback_data: 'l:' + type + ':' + arg + ':' + (page - 1) });
        nav.push({ text: tr(lang, 'page', page + 1, pages), callback_data: 'noop' });
        if (page < pages - 1) nav.push({ text: '▶️', callback_data: 'l:' + type + ':' + arg + ':' + (page + 1) });
        rows.push(nav);
    }
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
    if (editMsgId) {
        return bot.editMessageText(title, Object.assign({ chat_id: chatId, message_id: editMsgId }, opts))
            .catch(() => null);
    }
    return send(chatId, title, opts);
}

function showCategories(chatId, user) {
    const lang = user.lang;
    const rows = [];
    db.categories.forEach((name, i) => {
        const n = Object.keys(db.movies).filter((c) => db.movies[c].category === name).length;
        if (n > 0) rows.push([{ text: name + ' (' + n + ')', callback_data: 'l:cat:' + i + ':0' }]);
    });
    if (Object.keys(db.movies).length) rows.push([{ text: tr(lang, 'all_btn'), callback_data: 'l:all:0:0' }]);
    if (!rows.length) return send(chatId, tr(lang, 'cats_none'));
    return send(chatId, tr(lang, 'cats_title'), { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
}

/* ------------------------------- MENYU ------------------------------ */

function sendMainMenu(chatId, userId, user) {
    const L = user.lang;
    const keyboard = [
        [{ text: tr(L, 'btn_random') }, { text: tr(L, 'btn_cats') }],
        [{ text: tr(L, 'btn_top') }, { text: tr(L, 'btn_new') }],
        [{ text: tr(L, 'btn_fav') }, { text: tr(L, 'btn_order') }],
        [{ text: tr(L, 'btn_lang') }]
    ];
    if (isAdmin(userId)) keyboard.push([{ text: ADMIN_BTN }]);
    return send(chatId, tr(L, 'welcome', escapeHTML(user.name || '')), {
        parse_mode: 'HTML',
        reply_markup: { keyboard: keyboard, resize_keyboard: true }
    });
}

async function handlePayload(chatId, userId, user, payload) {
    const m = /^m(\d+)$/.exec(payload || '');
    if (m) await sendMovie(chatId, userId, user, m[1], 0);
}

async function handleMenu(action, chatId, userId, user) {
    const L = user.lang;
    states.delete('u:' + userId);
    if (action === 'random') {
        const keys = Object.keys(db.movies);
        if (!keys.length) return send(chatId, tr(L, 'empty_db'));
        return sendMovie(chatId, userId, user, keys[Math.floor(Math.random() * keys.length)], 0);
    }
    if (action === 'cats') return showCategories(chatId, user);
    if (action === 'top') return showList(chatId, user, 'top', 0, 0);
    if (action === 'new') return showList(chatId, user, 'new', 0, 0);
    if (action === 'fav') return showList(chatId, user, 'fav', 0, 0);
    if (action === 'order') {
        states.set('u:' + userId, { step: 'REQUEST' });
        return send(chatId, tr(L, 'ask_request'));
    }
    if (action === 'lang') {
        return send(chatId, tr(L, 'lang_pick'), {
            reply_markup: { inline_keyboard: [[{ text: "🇺🇿 O'zbekcha", callback_data: 'lg:uz' }, { text: '🇷🇺 Русский', callback_data: 'lg:ru' }]] }
        });
    }
}

/* ------------------------------ BUYURTMALAR ------------------------- */

function addRequest(chatId, userId, user, text) {
    const L = user.lang;
    const pending = db.requests.filter((r) => String(r.userId) === String(userId) && !r.done).length;
    if (pending >= 5) return send(chatId, tr(L, 'request_limit'));
    const req = {
        id: ++db.lastRequestId, userId: userId, name: user.name || '',
        text: text.slice(0, 300), date: new Date().toISOString(), done: false
    };
    db.requests.push(req);
    saveNow();
    notifyAdmins('📥 <b>Yangi buyurtma #' + req.id + '</b>\n\n👤 <a href="tg://user?id=' + userId + '">' + escapeHTML(user.name || userId) + '</a> (<code>' + userId + '</code>)\n📝 ' + escapeHTML(req.text) + '\n\nJavob: <code>/done ' + req.id + ' Matn</code>', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '✅ Bajarildi', callback_data: 'rq:' + req.id }]] }
    });
    return send(chatId, tr(L, 'request_sent'));
}

async function completeRequest(id, note) {
    const r = db.requests.find((x) => x.id === Number(id));
    if (!r) return null;
    r.done = true;
    saveNow();
    const u = db.users[String(r.userId)];
    const L = u ? u.lang : 'uz';
    const base = L === 'ru'
        ? '✅ Ваш заказ «' + escapeHTML(r.text) + '» выполнен!'
        : '✅ Buyurtmangiz «' + escapeHTML(r.text) + '» bajarildi!';
    await send(r.userId, base + (note ? '\n\n' + escapeHTML(note) : ''), { parse_mode: 'HTML' });
    return r;
}

/* ============================ ADMIN: QO'SHISH ===================== */

function extractMedia(msg) {
    if (msg.video) return { id: msg.video.file_id, type: 'video' };
    if (msg.animation) return { id: msg.animation.file_id, type: 'animation' };
    if (msg.document && msg.document.mime_type && msg.document.mime_type.indexOf('video/') === 0) {
        return { id: msg.document.file_id, type: 'document' };
    }
    return null;
}

function askCategory(chatId) {
    const rows = [];
    for (let i = 0; i < db.categories.length; i += 2) {
        const row = [{ text: db.categories[i], callback_data: 'ac:' + i }];
        if (db.categories[i + 1]) row.push({ text: db.categories[i + 1], callback_data: 'ac:' + (i + 1) });
        rows.push(row);
    }
    rows.push([{ text: '➕ Yangi kategoriya', callback_data: 'ac:new' }, { text: '➖ Kategoriyasiz', callback_data: 'ac:none' }]);
    return send(chatId, '📂 <b>Kategoriyani tanlang:</b>', { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
}

function askTags(chatId) {
    return send(chatId, "🏷 Teglarni vergul bilan yozing (masalan: <i>anime, jangari</i>) yoki <code>-</code> yuboring.", { parse_mode: 'HTML' });
}

function hashtag(t) {
    return '#' + String(t).trim().replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '');
}

function postText(code, m) {
    const lines = ['🎬 <b>' + escapeHTML(m.title) + '</b>', ''];
    if (m.category) lines.push('📂 Janr: <b>' + escapeHTML(m.category) + '</b>');
    if (m.parts.length > 1) lines.push('🎞 Qismlar soni: <b>' + m.parts.length + '</b>');
    lines.push('🔑 Kod: <code>' + code + '</code>');
    const tags = (m.tags || []).map(hashtag).filter((t) => t.length > 1);
    if (tags.length) lines.push('', escapeHTML(tags.join(' ')));
    lines.push('', "🍿 To'liq ko'rish uchun 👇 tugmani bosing yoki botga kodni yozing:", '🤖 @' + BOT_USERNAME);
    const text = lines.join('\n');
    return text.length > 1000 ? text.slice(0, 1000) : text;
}

async function postToChannel(code) {
    const m = getMovie(code);
    const ch = db.channels[0];
    if (!m) return { ok: false, text: 'Multfilm topilmadi.' };
    if (!ch) return { ok: false, text: 'Kanal ulanmagan (/addchannel).' };
    const markup = { inline_keyboard: [[{ text: '▶️ Tomosha qilish', url: deepLink(code) }]] };
    const base = { parse_mode: 'HTML', reply_markup: markup };
    try {
        const caption = postText(code, m);
        if (m.poster) {
            await bot.sendPhoto(ch, m.poster, Object.assign({ caption: caption }, base));
            if (m.trailer) {
                await sendPart(ch, m.trailer, Object.assign({ caption: '🎞 <b>Treyler</b> — ' + escapeHTML(m.title) }, base));
            }
        } else if (m.trailer) {
            await sendPart(ch, m.trailer, Object.assign({ caption: caption }, base));
        } else {
            await bot.sendMessage(ch, caption, base);
        }
        return { ok: true, text: '📣 Post ' + escapeHTML(ch) + ' kanaliga yuborildi.' };
    } catch (e) {
        log('error', 'Kanalga post yuborilmadi:', e && e.message);
        return { ok: false, text: "⚠️ Kanalga post yuborilmadi (bot kanalda admin bo'lishi kerak): " + escapeHTML(e && e.message) };
    }
}

function askPoster(chatId) {
    return send(chatId, '🖼 <b>Poster</b> (rasm) yuboring — kanal posti uchun.', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: "⏭ O'tkazib yuborish", callback_data: 'sk:poster' }]] }
    });
}

function askTrailer(chatId) {
    return send(chatId, '🎞 <b>Treyler</b> videosini yuboring — kanal posti uchun.', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: "⏭ O'tkazib yuborish", callback_data: 'sk:trailer' }]] }
    });
}

async function finalizeMovie(chatId, adminId, st) {
    const code = String(++db.lastCode);
    db.movies[code] = {
        title: st.title, category: st.category || '', tags: st.tags || [],
        poster: st.poster || '', trailer: st.trailer || null,
        parts: [st.media], views: 0, likes: [], dislikes: [], added: new Date().toISOString()
    };
    saveNow();
    states.delete('a:' + adminId);
    let msg = '✅ <b>Multfilm saqlandi!</b>\n\n🔑 Kod: <code>' + code + '</code>\n🎬 ' + escapeHTML(st.title) +
        (st.category ? '\n📂 ' + escapeHTML(st.category) : '') +
        '\n\nQism qo\'shish: <code>/addpart ' + code + '</code>';
    if (db.settings.autopost) {
        const r = await postToChannel(code);
        msg += '\n\n' + r.text;
    }
    return send(chatId, msg, { parse_mode: 'HTML' });
}

async function adminMedia(msg) {
    const adminId = msg.from.id;
    const media = extractMedia(msg);
    const key = 'a:' + adminId;
    const st = states.get(key);
    if (st && st.step === 'POSTER') return send(msg.chat.id, '🖼 Hozir <b>poster (rasm)</b> kerak. Rasm yuboring yoki «O\'tkazib yuborish» ni bosing.', H);
    if (st && st.step === 'TRAILER') {
        if (st.code) {
            const mv = getMovie(st.code);
            states.delete(key);
            if (!mv) return send(msg.chat.id, 'Multfilm topilmadi.');
            mv.trailer = media;
            saveNow();
            return send(msg.chat.id, '✅ Treyler saqlandi. Kanalga qayta joylash: <code>/post ' + st.code + '</code>', H);
        }
        st.trailer = media;
        return finalizeMovie(msg.chat.id, adminId, st);
    }
    if (st && st.step === 'PART') {
        const m = getMovie(st.code);
        if (!m) { states.delete(key); return send(msg.chat.id, 'Multfilm topilmadi.'); }
        m.parts.push(media);
        saveNow();
        return send(msg.chat.id, '✅ <b>' + m.parts.length + "-qism</b> qo'shildi (kod <code>" + st.code + "</code>).\nYana video yuboring yoki tugatish uchun /cancel.", { parse_mode: 'HTML' });
    }
    const replaced = st && st.step !== 'PART';
    states.set(key, { step: 'TITLE', media: media });
    return send(msg.chat.id, (replaced ? "♻️ Oldingi tugallanmagan video bekor qilindi.\n\n" : '') +
        '📹 <b>Video qabul qilindi!</b>\n\nMultfilm <b>nomini</b> kiriting:', { parse_mode: 'HTML' });
}

async function adminStep(msg, st) {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;
    const text = msg.text.trim();
    if (st.step === 'TITLE') {
        if (!text || text.length > 200) return send(chatId, "Nom 1–200 belgidan iborat bo'lishi kerak.");
        st.title = text;
        st.step = 'CATEGORY';
        return askCategory(chatId);
    }
    if (st.step === 'CATEGORY') {
        return send(chatId, '👆 Kategoriyani yuqoridagi tugmalardan tanlang (yoki /cancel).');
    }
    if (st.step === 'CATNEW') {
        const name = text.slice(0, 40);
        if (db.categories.indexOf(name) === -1) db.categories.push(name);
        saveNow();
        st.category = name;
        st.step = 'TAGS';
        return askTags(chatId);
    }
    if (st.step === 'TAGS') {
        st.tags = text === '-' ? [] : text.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 15);
        st.step = 'POSTER';
        return askPoster(chatId);
    }
    if (st.step === 'POSTER') return send(chatId, '🖼 Rasm (poster) yuboring yoki «O\'tkazib yuborish» ni bosing. Bekor qilish: /cancel');
    if (st.step === 'TRAILER') return send(chatId, '🎞 Treyler videosini yuboring yoki «O\'tkazib yuborish» ni bosing. Bekor qilish: /cancel');
    if (st.step === 'PART') {
        return send(chatId, 'Qism qo\'shish rejimidasiz: video yuboring yoki /cancel.');
    }
}

/* =========================== XABARLARNI QAYTA ISHLASH ============= */

bot.on('message', (msg) => {
    onMessage(msg).catch((e) => log('error', 'onMessage:', e));
});

async function onMessage(msg) {
    if (!msg.from || msg.chat.type !== 'private') return;
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const user = touchUser(msg.from);
    if (user.banned && !isAdmin(userId)) return;
    if (limited(userId)) return;
    const admin = isAdmin(userId);

    if (admin && extractMedia(msg)) return adminMedia(msg);
    if (admin && msg.photo && msg.photo.length) {
        const pst = states.get('a:' + userId);
        if (pst && pst.step === 'POSTER') {
            const fid = msg.photo[msg.photo.length - 1].file_id; // eng katta o'lcham
            if (pst.code) {
                const mv = getMovie(pst.code);
                states.delete('a:' + userId);
                if (!mv) return send(chatId, 'Multfilm topilmadi.');
                mv.poster = fid;
                saveNow();
                return send(chatId, '✅ Poster saqlandi. Kanalga qayta joylash: <code>/post ' + pst.code + '</code>', H);
            }
            pst.poster = fid;
            pst.step = 'TRAILER';
            return askTrailer(chatId);
        }
        return;
    }

    const text = msg.text ? msg.text.trim() : '';
    if (!text || text.charAt(0) === '/') return;

    const action = menuAction(text);
    const ast = admin ? states.get('a:' + userId) : null;
    if (ast && !action) return adminStep(msg, ast);

    if (action === 'admin') {
        if (admin) return showAdminPanel(chatId);
        return;
    }

    if (!(await gate(chatId, userId, user))) return;
    if (action) return handleMenu(action, chatId, userId, user);

    const ust = states.get('u:' + userId);
    if (ust && ust.step === 'REQUEST') {
        states.delete('u:' + userId);
        return addRequest(chatId, userId, user, text);
    }

    // Kod bo'yicha
    if (/^\d{1,9}$/.test(text)) {
        if (getMovie(text)) return sendMovie(chatId, userId, user, text, 0);
    }

    // Nom bo'yicha qidiruv
    statInc('searches');
    const results = searchMovies(text);
    const q = norm(text).slice(0, 40);
    if (!results.length) {
        if (q) bumpCounter(db.missed, q);
        scheduleSave();
        return send(chatId, tr(user.lang, 'not_found'), {
            reply_markup: { inline_keyboard: [[{ text: tr(user.lang, 'order_btn'), callback_data: 'order' }]] }
        });
    }
    if (q) bumpCounter(db.queries, q);
    scheduleSave();
    if (results.length === 1 || results[0].score >= 100) {
        return sendMovie(chatId, userId, user, results[0].code, 0);
    }
    const rows = results.slice(0, 10).map((r) => [{ text: db.movies[r.code].title.slice(0, 50), callback_data: 'm:' + r.code }]);
    return send(chatId, tr(user.lang, 'results'), { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
}

/* ------------------------------ /start ------------------------------ */

bot.onText(/^\/start(?:@\w+)?(?:\s+(\S+))?/, (msg, match) => {
    (async () => {
        if (!msg.from || msg.chat.type !== 'private') return;
        const userId = msg.from.id;
        const user = touchUser(msg.from);
        if (user.banned && !isAdmin(userId)) return;
        if (limited(userId)) return;
        states.delete('u:' + userId);
        const payload = match[1] || '';
        if (!(await gate(msg.chat.id, userId, user, payload))) return;
        await sendMainMenu(msg.chat.id, userId, user);
        await handlePayload(msg.chat.id, userId, user, payload);
    })().catch((e) => log('error', '/start:', e));
});

bot.onText(/^\/id(?:@\w+)?$/, (msg) => {
    if (msg.chat.type === 'private') send(msg.chat.id, 'Sizning ID: <code>' + msg.from.id + '</code>', { parse_mode: 'HTML' });
});

/* ============================ CALLBACK'LAR ======================== */

bot.on('callback_query', (q) => {
    onCallback(q).catch((e) => {
        log('error', 'onCallback:', e);
        bot.answerCallbackQuery(q.id).catch(() => {});
    });
});

async function onCallback(q) {
    let answered = false;
    const answer = (text, alert) => {
        answered = true;
        return bot.answerCallbackQuery(q.id, text ? { text: text, show_alert: !!alert } : {}).catch(() => {});
    };
    const userId = q.from.id;
    const chatId = q.message ? q.message.chat.id : userId;
    const msgId = q.message ? q.message.message_id : null;
    const user = touchUser(q.from);
    const L = user.lang;
    const data = String(q.data || '');
    const p = data.split(':');

    if (user.banned && !isAdmin(userId)) return answer();
    if (limited(userId)) return answer();
    if (data === 'noop') return answer();

    /* ---- adminga tegishli ---- */
    if (p[0] === 'ac' || p[0] === 'dl' || p[0] === 'rq' || p[0] === 'sk') {
        if (!isAdmin(userId)) return answer();
        if (p[0] === 'sk') {
            const sst = states.get('a:' + userId);
            await answer();
            if (!sst) return send(chatId, tr(L, 'expired'));
            if (p[1] === 'poster' && sst.step === 'POSTER') {
                if (sst.code) { states.delete('a:' + userId); return send(chatId, 'Bekor qilindi.'); }
                sst.step = 'TRAILER';
                return askTrailer(chatId);
            }
            if (p[1] === 'trailer' && sst.step === 'TRAILER') {
                if (sst.code) { states.delete('a:' + userId); return send(chatId, 'Bekor qilindi.'); }
                return finalizeMovie(chatId, userId, sst);
            }
            return;
        }
        if (p[0] === 'ac') {
            const st = states.get('a:' + userId);
            if (!st || st.step !== 'CATEGORY') return answer(tr(L, 'expired'), true);
            await answer();
            if (p[1] === 'new') {
                st.step = 'CATNEW';
                return send(chatId, '✍️ Yangi kategoriya nomini yozing:');
            }
            st.category = p[1] === 'none' ? '' : (db.categories[Number(p[1])] || '');
            st.step = 'TAGS';
            return askTags(chatId);
        }
        if (p[0] === 'dl') {
            if (p[2] === 'y') {
                const m = getMovie(p[1]);
                if (m) { delete db.movies[p[1]]; saveNow(); }
                await answer(m ? "O'chirildi" : 'Topilmadi');
                if (msgId) bot.editMessageText(m ? "🗑 O'chirildi: " + escapeHTML(m.title) : 'Topilmadi', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }).catch(() => {});
            } else {
                await answer('Bekor qilindi');
                if (msgId) bot.deleteMessage(chatId, msgId).catch(() => {});
            }
            return;
        }
        if (p[0] === 'rq') {
            const r = await completeRequest(p[1], '');
            await answer(r ? 'Bajarildi deb belgilandi' : 'Topilmadi');
            if (r && msgId) bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
            return;
        }
    }

    /* ---- til ---- */
    if (p[0] === 'lg') {
        user.lang = p[1] === 'ru' ? 'ru' : 'uz';
        saveNow();
        await answer(tr(user.lang, 'lang_set'));
        if (msgId) bot.deleteMessage(chatId, msgId).catch(() => {});
        return sendMainMenu(chatId, userId, user);
    }

    /* ---- obuna tekshiruvi ---- */
    if (p[0] === 'check_sub') {
        subCache.delete(userId);
        const missing = await missingChannels(userId);
        if (missing.length) return answer(tr(L, 'sub_alert'), true);
        await answer();
        if (msgId) bot.deleteMessage(chatId, msgId).catch(() => {});
        await sendMainMenu(chatId, userId, user);
        return handlePayload(chatId, userId, user, p[1]);
    }

    /* ---- qolgan hammasi obunani talab qiladi ---- */
    await answer();
    if (!(await gate(chatId, userId, user))) return;

    if (data === 'order') {
        states.set('u:' + userId, { step: 'REQUEST' });
        return send(chatId, tr(L, 'ask_request'));
    }
    if (p[0] === 'm') return sendMovie(chatId, userId, user, p[1], 0);
    if (p[0] === 'p') return sendMovie(chatId, userId, user, p[1], p[2]);
    if (p[0] === 'l') return showList(chatId, user, p[1], p[2], p[3], msgId);

    if (p[0] === 'f' || p[0] === 'r' || p[0] === 'x') {
        const code = p[1];
        const m = getMovie(code);
        if (!m) return;
        const idx = Number(p[0] === 'r' ? p[3] : p[2]) || 0;
        const refresh = () => {
            if (!msgId) return;
            bot.editMessageReplyMarkup(movieKeyboard(L, code, m, idx, user), { chat_id: chatId, message_id: msgId }).catch(() => {});
        };
        if (p[0] === 'f') {
            const i = user.favs.indexOf(code);
            if (i === -1) user.favs.push(code); else user.favs.splice(i, 1);
            saveNow();
            refresh();
            return bot.answerCallbackQuery(q.id, { text: i === -1 ? tr(L, 'fav_add') : tr(L, 'fav_del') }).catch(() => {});
        }
        if (p[0] === 'r') {
            const mine = p[2] === 'u' ? m.likes : m.dislikes;
            const other = p[2] === 'u' ? m.dislikes : m.likes;
            const oi = other.indexOf(userId);
            if (oi !== -1) other.splice(oi, 1);
            const mi = mine.indexOf(userId);
            let msgText;
            if (mi !== -1) { mine.splice(mi, 1); msgText = tr(L, 'rate_removed'); } else { mine.push(userId); msgText = tr(L, 'rated'); }
            saveNow();
            refresh();
            return bot.answerCallbackQuery(q.id, { text: msgText }).catch(() => {});
        }
        if (p[0] === 'x') {
            const key = userId + ':' + code;
            if (reportedSet.has(key)) return bot.answerCallbackQuery(q.id, { text: tr(L, 'reported_already'), show_alert: true }).catch(() => {});
            reportedSet.add(key);
            notifyAdmins('🚩 <b>Shikoyat</b>\n\n🎬 ' + escapeHTML(m.title) + ' (kod <code>' + code + '</code>)\n👤 <a href="tg://user?id=' + userId + '">' + escapeHTML(user.name || userId) + '</a>\n\nO\'chirish: <code>/delete ' + code + '</code>', { parse_mode: 'HTML' });
            return bot.answerCallbackQuery(q.id, { text: tr(L, 'reported'), show_alert: true }).catch(() => {});
        }
    }
}

/* ============================ INLINE REJIM ======================== */
// BotFather -> /setinline orqali yoqiladi

bot.on('inline_query', (q) => {
    (async () => {
        const user = touchUser(q.from);
        if (user.banned && !isAdmin(q.from.id)) return bot.answerInlineQuery(q.id, [], { cache_time: 5 });
        let codes;
        if (q.query && q.query.trim()) codes = searchMovies(q.query).map((r) => r.code);
        else codes = Object.keys(db.movies).sort(byNewest);
        const results = codes.slice(0, 20).map((code) => {
            const m = db.movies[code];
            return {
                type: 'article', id: String(code), title: m.title,
                description: (m.category ? m.category + ' • ' : '') + 'Kod: ' + code,
                input_message_content: {
                    message_text: '🎬 <b>' + escapeHTML(m.title) + '</b>\n🔑 Kod: <code>' + code + '</code>',
                    parse_mode: 'HTML'
                },
                reply_markup: { inline_keyboard: [[{ text: tr(user.lang, 'watch'), url: deepLink(code) }]] }
            };
        });
        return bot.answerInlineQuery(q.id, results, { cache_time: 20, is_personal: false });
    })().catch((e) => log('error', 'inline_query:', e));
});

/* ============================== ADMIN BUYRUQLARI ================== */

function adminCmd(name, handler, ownerOnly) {
    const re = new RegExp('^\\/' + name + '(?:@\\w+)?(?:\\s+([\\s\\S]*))?$');
    bot.onText(re, (msg, match) => {
        if (!msg.from || msg.chat.type !== 'private') return;
        if (ownerOnly ? !isOwner(msg.from.id) : !isAdmin(msg.from.id)) return;
        Promise.resolve()
            .then(() => handler(msg, (match[1] || '').trim()))
            .catch((e) => { log('error', '/' + name + ':', e); send(msg.chat.id, '❌ Xatolik: ' + escapeHTML(e && e.message)); });
    });
}

const H = { parse_mode: 'HTML' };

function statsText() {
    const users = Object.keys(db.users);
    const blocked = users.filter((id) => db.users[id].blocked).length;
    const daily = db.stats.daily;
    const today = daily[todayKey()] || { newUsers: 0, views: 0, searches: 0 };
    const week = { newUsers: 0, views: 0, searches: 0 };
    for (let i = 0; i < 7; i++) {
        const k = new Date(Date.now() + 5 * 3600 * 1000 - i * 86400000).toISOString().slice(0, 10);
        const d = daily[k];
        if (d) { week.newUsers += d.newUsers || 0; week.views += d.views || 0; week.searches += d.searches || 0; }
    }
    const topMovies = Object.keys(db.movies).sort((a, b) => db.movies[b].views - db.movies[a].views).slice(0, 5)
        .filter((c) => db.movies[c].views > 0)
        .map((c) => '  • ' + escapeHTML(db.movies[c].title) + ' — ' + db.movies[c].views);
    const topQ = topOf(db.queries, 5).map((k) => '  • ' + escapeHTML(k) + ' — ' + db.queries[k]);
    const topMiss = topOf(db.missed, 8).map((k) => '  • ' + escapeHTML(k) + ' — ' + db.missed[k]);
    const pending = db.requests.filter((r) => !r.done).length;
    return '📊 <b>Statistika</b>\n\n' +
        '👥 Foydalanuvchilar: <b>' + users.length + '</b> (bloklagan: ' + blocked + ')\n' +
        '🎬 Multfilmlar: <b>' + Object.keys(db.movies).length + '</b>\n' +
        '📥 Kutilayotgan buyurtmalar: <b>' + pending + '</b>\n\n' +
        '📅 <b>Bugun:</b> +' + today.newUsers + ' foydalanuvchi, ' + today.views + " ko'rish, " + today.searches + ' qidiruv\n' +
        '🗓 <b>7 kun:</b> +' + week.newUsers + ' foydalanuvchi, ' + week.views + " ko'rish, " + week.searches + ' qidiruv\n\n' +
        "🔥 <b>Eng ko'p ko'rilgan:</b>\n" + (topMovies.join('\n') || '  —') + '\n\n' +
        "🔎 <b>Eng ko'p qidirilgan:</b>\n" + (topQ.join('\n') || '  —') + '\n\n' +
        '❓ <b>Topilmagan so\'rovlar</b> (nima qo\'shish kerak):\n' + (topMiss.join('\n') || '  —');
}

function showAdminPanel(chatId) {
    return send(chatId, statsText() + '\n\nBarcha buyruqlar: /help', H);
}

const HELP = '⚙️ <b>Admin buyruqlari</b>\n\n' +
    "<b>Multfilm</b>\n📹 Video yuboring — yangi multfilm (nom → kategoriya → teglar → poster → treyler)\n" +
    '/addpart &lt;kod&gt; — mavjud multfilmga qism (seriya) qo\'shish\n' +
    '/list [sahifa] — barcha multfilmlar\n' +
    '/edit &lt;kod&gt; &lt;yangi nom&gt;\n/setcat &lt;kod&gt; &lt;kategoriya | -&gt;\n/settags &lt;kod&gt; &lt;teg1, teg2 | -&gt;\n' +
    '/delete &lt;kod&gt;\n/setposter &lt;kod&gt; — poster (rasm) qo\'shish/almashtirish\n/settrailer &lt;kod&gt; — treyler video qo\'shish/almashtirish\n/post &lt;kod&gt; — kanalga qayta post\n\n' +
    '<b>Kategoriyalar</b>\n/cats, /addcat &lt;nom&gt;, /delcat &lt;nom&gt;\n\n' +
    '<b>Kanallar (majburiy obuna)</b>\n/channels, /addchannel @kanal, /delchannel @kanal\n<i>Birinchi kanalga avtomatik postlar chiqadi.</i>\n\n' +
    '<b>Xabar yuborish</b>\n/broadcast &lt;matn&gt; — hammaga\nYoki istalgan xabarga (rasm/video ham) <b>reply</b> qilib /broadcast yozing.\nTugma qo\'shish: oxirgi qatorga <code>btn: Nomi | https://link</code>\n/reply &lt;user_id&gt; &lt;matn&gt;\n\n' +
    '<b>Buyurtmalar</b>\n/requests — ro\'yxat\n/done &lt;id&gt; [izoh] — bajarildi + foydalanuvchiga xabar\n\n' +
    '<b>Foydalanuvchilar</b>\n/ban &lt;id&gt;, /unban &lt;id&gt;\n\n' +
    '<b>Tizim</b>\n/stats — statistika\n/backup — bazani hozir yuborish\n/protect on|off — forward/saqlashni taqiqlash\n/autopost on|off — avtomatik post\n/cancel — joriy amalni bekor qilish\n' +
    '/addadmin &lt;id&gt;, /deladmin &lt;id&gt;, /admins — faqat asosiy admin';

adminCmd('admin', (msg) => showAdminPanel(msg.chat.id));
adminCmd('stats', (msg) => send(msg.chat.id, statsText(), H));
adminCmd('help', (msg) => send(msg.chat.id, HELP, H));

adminCmd('cancel', (msg) => {
    states.delete('a:' + msg.from.id);
    return send(msg.chat.id, '❎ Bekor qilindi.');
});

adminCmd('list', (msg, arg) => {
    const codes = Object.keys(db.movies).sort((a, b) => Number(a) - Number(b));
    if (!codes.length) return send(msg.chat.id, 'Baza bo\'sh.');
    const per = 40;
    const pages = Math.ceil(codes.length / per);
    const page = Math.max(1, Math.min(Number(arg) || 1, pages));
    const lines = codes.slice((page - 1) * per, page * per).map((c) => {
        const m = db.movies[c];
        return '<code>' + c + '</code> — ' + escapeHTML(m.title) + (m.category ? ' [' + escapeHTML(m.category) + ']' : '') +
            (m.parts.length > 1 ? ' 🎞' + m.parts.length : '') + ' 👁' + m.views;
    });
    return send(msg.chat.id, '📚 <b>Multfilmlar</b> (' + page + '/' + pages + ')\n\n' + lines.join('\n') + (page < pages ? '\n\n/list ' + (page + 1) : ''), H);
});

adminCmd('delete', (msg, arg) => {
    const m = getMovie(arg);
    if (!m) return send(msg.chat.id, 'Bunday kodli multfilm yo\'q.');
    return send(msg.chat.id, '🗑 O\'chirilsinmi?\n\n<b>' + escapeHTML(m.title) + '</b> (kod ' + arg + ')', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '✅ Ha', callback_data: 'dl:' + arg + ':y' }, { text: '❌ Yo\'q', callback_data: 'dl:' + arg + ':n' }]] }
    });
});

adminCmd('edit', (msg, arg) => {
    const mt = /^(\d+)\s+([\s\S]+)$/.exec(arg);
    if (!mt) return send(msg.chat.id, 'Format: /edit &lt;kod&gt; &lt;yangi nom&gt;', H);
    const m = getMovie(mt[1]);
    if (!m) return send(msg.chat.id, 'Bunday kodli multfilm yo\'q.');
    m.title = mt[2].trim().slice(0, 200);
    saveNow();
    return send(msg.chat.id, '✅ Nom o\'zgartirildi: <b>' + escapeHTML(m.title) + '</b>', H);
});

adminCmd('setcat', (msg, arg) => {
    const mt = /^(\d+)\s+([\s\S]+)$/.exec(arg);
    if (!mt) return send(msg.chat.id, 'Format: /setcat &lt;kod&gt; &lt;kategoriya | -&gt;', H);
    const m = getMovie(mt[1]);
    if (!m) return send(msg.chat.id, 'Bunday kodli multfilm yo\'q.');
    const name = mt[2].trim().slice(0, 40);
    if (name === '-') m.category = '';
    else { m.category = name; if (db.categories.indexOf(name) === -1) db.categories.push(name); }
    saveNow();
    return send(msg.chat.id, '✅ Kategoriya: <b>' + escapeHTML(m.category || 'yo\'q') + '</b>', H);
});

adminCmd('settags', (msg, arg) => {
    const mt = /^(\d+)\s+([\s\S]+)$/.exec(arg);
    if (!mt) return send(msg.chat.id, 'Format: /settags &lt;kod&gt; &lt;teg1, teg2 | -&gt;', H);
    const m = getMovie(mt[1]);
    if (!m) return send(msg.chat.id, 'Bunday kodli multfilm yo\'q.');
    m.tags = mt[2].trim() === '-' ? [] : mt[2].split(',').map((s) => s.trim()).filter(Boolean).slice(0, 15);
    saveNow();
    return send(msg.chat.id, '✅ Teglar: ' + escapeHTML(m.tags.join(', ') || 'yo\'q'), H);
});

adminCmd('addpart', (msg, arg) => {
    const m = getMovie(arg);
    if (!m) return send(msg.chat.id, 'Format: /addpart &lt;kod&gt;\nBunday kodli multfilm yo\'q.', H);
    states.set('a:' + msg.from.id, { step: 'PART', code: String(arg) });
    return send(msg.chat.id, '🎞 <b>' + escapeHTML(m.title) + '</b> uchun keyingi qism(lar)ni yuboring (hozir ' + m.parts.length + ' ta qism). Tugatish: /cancel', H);
});

adminCmd('setposter', (msg, arg) => {
    const m = getMovie(arg);
    if (!m) return send(msg.chat.id, 'Format: /setposter &lt;kod&gt;\nBunday kodli multfilm yo\'q.', H);
    states.set('a:' + msg.from.id, { step: 'POSTER', code: String(arg) });
    return send(msg.chat.id, '🖼 <b>' + escapeHTML(m.title) + '</b> uchun yangi poster (rasm) yuboring. Bekor qilish: /cancel', H);
});

adminCmd('settrailer', (msg, arg) => {
    const m = getMovie(arg);
    if (!m) return send(msg.chat.id, 'Format: /settrailer &lt;kod&gt;\nBunday kodli multfilm yo\'q.', H);
    states.set('a:' + msg.from.id, { step: 'TRAILER', code: String(arg) });
    return send(msg.chat.id, '🎞 <b>' + escapeHTML(m.title) + '</b> uchun treyler videosini yuboring. Bekor qilish: /cancel', H);
});

adminCmd('post', async (msg, arg) => {
    const r = await postToChannel(arg);
    return send(msg.chat.id, r.text, H);
});

adminCmd('cats', (msg) => {
    if (!db.categories.length) return send(msg.chat.id, 'Kategoriyalar yo\'q. /addcat &lt;nom&gt;', H);
    return send(msg.chat.id, '📂 <b>Kategoriyalar:</b>\n' + db.categories.map((c, i) => (i + 1) + '. ' + escapeHTML(c)).join('\n'), H);
});

adminCmd('addcat', (msg, arg) => {
    if (!arg) return send(msg.chat.id, 'Format: /addcat &lt;nom&gt;', H);
    const name = arg.slice(0, 40);
    if (db.categories.indexOf(name) !== -1) return send(msg.chat.id, 'Bu kategoriya allaqachon bor.');
    db.categories.push(name);
    saveNow();
    return send(msg.chat.id, '✅ Qo\'shildi: <b>' + escapeHTML(name) + '</b>', H);
});

adminCmd('delcat', (msg, arg) => {
    const i = db.categories.indexOf(arg);
    if (i === -1) return send(msg.chat.id, 'Bunday kategoriya yo\'q.');
    db.categories.splice(i, 1);
    Object.keys(db.movies).forEach((c) => { if (db.movies[c].category === arg) db.movies[c].category = ''; });
    saveNow();
    return send(msg.chat.id, '🗑 O\'chirildi. Multfilmlar kategoriyasiz qoldi.');
});

adminCmd('channels', (msg) => {
    if (!db.channels.length) return send(msg.chat.id, 'Majburiy kanal yo\'q. /addchannel @kanal');
    return send(msg.chat.id, '📢 <b>Kanallar:</b>\n' + db.channels.map((c, i) => (i + 1) + '. ' + escapeHTML(c) + (i === 0 ? ' (postlar shu yerga)' : '')).join('\n'), H);
});

adminCmd('addchannel', async (msg, arg) => {
    let ch = arg.trim();
    if (!ch) return send(msg.chat.id, 'Format: /addchannel @kanal');
    if (ch.charAt(0) !== '@') ch = '@' + ch;
    if (!/^@[A-Za-z0-9_]{4,}$/.test(ch)) return send(msg.chat.id, 'Kanal username noto\'g\'ri.');
    if (db.channels.indexOf(ch) !== -1) return send(msg.chat.id, 'Bu kanal allaqachon qo\'shilgan.');
    let warn = '';
    try {
        const me = await bot.getChatMember(ch, BOT_ID);
        if (['administrator', 'creator'].indexOf(me.status) === -1) warn = '\n⚠️ Bot bu kanalda administrator emas — obunani tekshira olmaydi.';
    } catch (e) {
        warn = '\n⚠️ Kanal tekshirilmadi: ' + escapeHTML(e && e.message) + '\nBotni kanalga administrator qilib qo\'shing.';
    }
    db.channels.push(ch);
    saveNow();
    return send(msg.chat.id, '✅ Qo\'shildi: ' + escapeHTML(ch) + warn, H);
});

adminCmd('delchannel', (msg, arg) => {
    let ch = arg.trim();
    if (ch && ch.charAt(0) !== '@') ch = '@' + ch;
    const i = db.channels.indexOf(ch);
    if (i === -1) return send(msg.chat.id, 'Bunday kanal yo\'q.');
    db.channels.splice(i, 1);
    saveNow();
    return send(msg.chat.id, '🗑 O\'chirildi: ' + escapeHTML(ch), H);
});

adminCmd('reply', (msg, arg) => {
    const mt = /^(\d+)\s+([\s\S]+)$/.exec(arg);
    if (!mt) return send(msg.chat.id, 'Format: /reply &lt;user_id&gt; &lt;matn&gt;', H);
    return bot.sendMessage(mt[1], '👨‍💻 <b>Admin javobi:</b>\n\n' + escapeHTML(mt[2]), H)
        .then(() => send(msg.chat.id, '✅ Javob yetkazildi.'))
        .catch(() => send(msg.chat.id, '❌ Xabar yuborishda xatolik.'));
});

adminCmd('requests', (msg) => {
    const pending = db.requests.filter((r) => !r.done);
    if (!pending.length) return send(msg.chat.id, '📭 Kutilayotgan buyurtmalar yo\'q.');
    const lines = pending.slice(-25).map((r) => '#' + r.id + ' • <code>' + r.userId + '</code> ' + escapeHTML(r.name) + ': ' + escapeHTML(r.text));
    return send(msg.chat.id, '📥 <b>Kutilayotgan buyurtmalar</b> (' + pending.length + ')\n\n' + lines.join('\n') + '\n\n/done &lt;id&gt; [izoh]', H);
});

adminCmd('done', async (msg, arg) => {
    const mt = /^(\d+)(?:\s+([\s\S]+))?$/.exec(arg);
    if (!mt) return send(msg.chat.id, 'Format: /done &lt;id&gt; [izoh]', H);
    const r = await completeRequest(mt[1], mt[2] || '');
    return send(msg.chat.id, r ? '✅ #' + r.id + ' bajarildi, foydalanuvchiga xabar yuborildi.' : 'Bunday buyurtma yo\'q.');
});

adminCmd('ban', (msg, arg) => {
    const u = db.users[String(Number(arg))];
    if (!u) return send(msg.chat.id, 'Bunday foydalanuvchi yo\'q.');
    if (isAdmin(Number(arg))) return send(msg.chat.id, 'Adminni bloklab bo\'lmaydi.');
    u.banned = true;
    saveNow();
    return send(msg.chat.id, '🚫 Bloklandi: <code>' + Number(arg) + '</code>', H);
});

adminCmd('unban', (msg, arg) => {
    const u = db.users[String(Number(arg))];
    if (!u) return send(msg.chat.id, 'Bunday foydalanuvchi yo\'q.');
    u.banned = false;
    saveNow();
    return send(msg.chat.id, '✅ Blokdan chiqarildi: <code>' + Number(arg) + '</code>', H);
});

adminCmd('protect', (msg, arg) => {
    if (arg !== 'on' && arg !== 'off') return send(msg.chat.id, 'Hozir: <b>' + (db.settings.protect ? 'yoqilgan' : 'o\'chiq') + '</b>\n/protect on | off', H);
    db.settings.protect = arg === 'on';
    saveNow();
    return send(msg.chat.id, '✅ Forward/saqlash taqiqi: <b>' + (db.settings.protect ? 'yoqildi' : 'o\'chirildi') + '</b>', H);
});

adminCmd('autopost', (msg, arg) => {
    if (arg !== 'on' && arg !== 'off') return send(msg.chat.id, 'Hozir: <b>' + (db.settings.autopost ? 'yoqilgan' : 'o\'chiq') + '</b>\n/autopost on | off', H);
    db.settings.autopost = arg === 'on';
    saveNow();
    return send(msg.chat.id, '✅ Avtomatik post: <b>' + (db.settings.autopost ? 'yoqildi' : 'o\'chirildi') + '</b>', H);
});

adminCmd('addadmin', (msg, arg) => {
    const id = Number(arg);
    if (!id || id < 1) return send(msg.chat.id, 'Format: /addadmin &lt;user_id&gt;', H);
    if (isAdmin(id)) return send(msg.chat.id, 'Bu foydalanuvchi allaqachon admin.');
    db.admins.push(id);
    saveNow();
    return send(msg.chat.id, '✅ Admin qo\'shildi: <code>' + id + '</code>', H);
}, true);

adminCmd('deladmin', (msg, arg) => {
    const id = Number(arg);
    const i = db.admins.indexOf(id);
    if (i === -1) return send(msg.chat.id, 'Bunday qo\'shimcha admin yo\'q (.env dagi adminlarni faqat .env dan o\'chirasiz).');
    db.admins.splice(i, 1);
    saveNow();
    return send(msg.chat.id, '🗑 Admin o\'chirildi: <code>' + id + '</code>', H);
}, true);

adminCmd('admins', (msg) => send(msg.chat.id, '👮 <b>Adminlar:</b>\n' + allAdmins().map((a) => '<code>' + a + '</code>' + (a === OWNER_ID ? ' (asosiy)' : '')).join('\n'), H), true);

adminCmd('backup', async (msg) => {
    await sendBackup(msg.chat.id);
});

/* ---------------------------- BROADCAST ----------------------------- */

adminCmd('broadcast', async (msg, arg) => {
    const chatId = msg.chat.id;
    const replied = msg.reply_to_message;
    if (!arg && !replied) {
        return send(chatId, 'Format: /broadcast &lt;matn&gt;\nYoki xabarga reply qilib /broadcast yozing.\nTugma: oxirgi qatorga <code>btn: Nomi | https://link</code>', H);
    }
    if (broadcastRunning) return send(chatId, '⏳ Oldingi xabar yuborish hali tugamadi.');

    let text = arg;
    let markup;
    const bm = /(?:^|\n)btn:\s*(.+?)\s*\|\s*(https?:\/\/\S+)\s*$/i.exec(text);
    if (bm) {
        markup = { inline_keyboard: [[{ text: bm[1], url: bm[2] }]] };
        text = text.slice(0, bm.index).trim();
    }
    if (!replied && !text) return send(chatId, 'Xabar matni bo\'sh.');

    const ids = Object.keys(db.users).filter((id) => !db.users[id].blocked && !db.users[id].banned);
    broadcastRunning = true;
    await send(chatId, '📢 Yuborish boshlandi: ' + ids.length + ' ta foydalanuvchi...');

    let ok = 0; let blocked = 0; let failed = 0;
    const sendOne = (id) => {
        if (replied) {
            const o = markup ? { reply_markup: markup } : {};
            if (typeof bot.copyMessage === 'function') return bot.copyMessage(id, chatId, replied.message_id, o);
            return bot.forwardMessage(id, chatId, replied.message_id);
        }
        return bot.sendMessage(id, escapeHTML(text), { parse_mode: 'HTML', reply_markup: markup });
    };
    try {
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            try {
                await sendOne(id);
                ok++;
            } catch (e) {
                const body = e && e.response && e.response.body;
                const code = body && body.error_code;
                if (code === 429) {
                    const wait = ((body.parameters && body.parameters.retry_after) || 5) + 1;
                    await sleep(wait * 1000);
                    try { await sendOne(id); ok++; } catch (e2) { failed++; }
                } else if (code === 403 || code === 400) {
                    blocked++;
                    if (code === 403 && db.users[id]) db.users[id].blocked = true;
                } else {
                    failed++;
                }
            }
            await sleep(BROADCAST_DELAY_MS);
        }
    } finally {
        broadcastRunning = false;
        saveNow();
    }
    return send(chatId, '✅ <b>Yuborish tugadi</b>\n\n📨 Yetkazildi: <b>' + ok + '</b>\n🚫 Botni bloklagan: <b>' + blocked + '</b>\n⚠️ Xato: <b>' + failed + '</b>', H);
});

/* ------------------------------ ZAXIRA ------------------------------ */

function backupLocal() {
    saveNow();
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
    const file = path.join(BACKUP_DIR, 'database-' + todayKey() + '.json');
    fs.copyFileSync(DB_FILE, file);
    const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^database-.*\.json$/.test(f)).sort();
    while (old.length > 7) fs.unlinkSync(path.join(BACKUP_DIR, old.shift()));
    return file;
}

async function sendBackup(chatId) {
    try {
        const file = backupLocal();
        await bot.sendDocument(chatId, fs.createReadStream(file), { caption: '💾 Baza zaxirasi ' + todayKey() });
    } catch (e) {
        log('error', 'Zaxira yuborilmadi:', e && e.message);
        send(chatId, '⚠️ Zaxira yuborilmadi: ' + escapeHTML(e && e.message), H);
    }
}

/* ============================ ISHGA TUSHIRISH ===================== */

let lastPollErr = '';
let lastPollErrAt = 0;
bot.on('polling_error', (err) => {
    const m = (err && (err.code + ' ' + err.message)) || String(err);
    if (/401|Unauthorized/i.test(m)) {
        log('error', "❌ BOT_TOKEN noto'g'ri (401). Tokenni tekshiring.");
        process.exit(1);
    }
    const now = Date.now();
    if (m !== lastPollErr || now - lastPollErrAt > 60000) {
        log('error', 'polling_error:', m);
        lastPollErr = m; lastPollErrAt = now;
    }
});

process.on('unhandledRejection', (r) => log('error', 'unhandledRejection:', r));
process.on('uncaughtException', (e) => {
    log('error', 'uncaughtException:', e);
    saveNow();
    process.exit(1); // PM2 / start skripti qayta ishga tushiradi
});
['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, async () => {
    try { await bot.stopPolling(); } catch (e) { /* ignore */ }
    saveNow();
    process.exit(0);
}));

/* ===== Render/Railway kabi hostinglar uchun: ochiq port + o'zini uyg'oq ushlash ===== */
function startHealthServer() {
    const port = Number(process.env.PORT);
    if (!port) return; // lokal ishga tushirishda kerak emas
    const http = require('node:http');
    http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('OK');
    }).listen(port, '0.0.0.0', () => log('info', 'Health server port ' + port + ' da ishlayapti'));

    const selfUrl = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
    if (selfUrl) {
        setInterval(() => {
            fetch(selfUrl).catch((e) => log('warn', 'Self-ping xato:', e && e.message));
        }, 10 * 60 * 1000).unref();
    }
}

(async function main() {
    db = loadDB();
    if (!db.channels.length && ENV_CHANNELS.length) db.channels = ENV_CHANNELS.slice();
    pruneStats();
    saveNow();
    try { backupLocal(); } catch (e) { log('warn', 'Lokal zaxira:', e.message); }

    let me;
    try {
        me = await bot.getMe();
    } catch (e) {
        log('error', "❌ Telegramga ulanib bo'lmadi yoki token noto'g'ri:", e && e.message);
        process.exit(1);
    }
    BOT_USERNAME = me.username;
    BOT_ID = me.id;
    try { await bot.deleteWebHook(); } catch (e) { /* ignore */ }

    setInterval(() => { sendBackup(OWNER_ID); pruneStats(); }, BACKUP_EVERY_MS);

    startHealthServer();
    bot.startPolling();
    log('info', '🚀 @' + BOT_USERNAME + ' ishga tushdi. Multfilmlar: ' + Object.keys(db.movies).length +
        ', foydalanuvchilar: ' + Object.keys(db.users).length + ', kanallar: ' + (db.channels.join(', ') || "yo'q"));
})();
