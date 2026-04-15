const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { getSocketConfig } = require('./lib/connection');
const { sendBulkWithProgress, stopCampaign, getCampaignStatus } = require('./lib/messenger');
const multer = require('multer');
const xlsx = require('xlsx');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('./lib/db');
const fs = require('fs-extra');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const session = require('express-session');

app.set('trust proxy', 1);

const secureCookies = process.env.COOKIE_SECURE === 'true';

app.use(session({
    name: 'whasappc.sid',
    secret: process.env.SESSION_SECRET || 'fallback-dev-secret',
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: { 
        secure: secureCookies,
        sameSite: secureCookies ? 'none' : 'lax',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 
    }
}));

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASS_HASH = process.env.ADMIN_PASS_HASH;

const requireAuth = (req, res, next) => {
    if (req.session && req.session.user) {
        next();
    } else {
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ error: 'Yetkisiz erişim' });
        }
        res.redirect('/login.html');
    }
};

fs.ensureDirSync(path.join(__dirname, 'uploads'));

// Güvenli Yükleme (RCE Koruması)
const storage = multer.diskStorage({
    destination: 'uploads/',
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, uuidv4() + ext);
    }
});

const upload = multer({ 
    storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
    fileFilter: (req, file, cb) => {
        const allowedMimeTypes = [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
            'application/vnd.ms-excel', // xls
            'image/jpeg', 'image/png', 'image/webp',
            'video/mp4', 'video/mpeg', 'video/webm', 'video/quicktime'
        ];
        if (file.mimetype.startsWith('video/') || allowedMimeTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Güvenlik ihlali: Bu dosya türü yüklenemez.'));
        }
    }
});

app.use(express.json({ limit: '10mb' })); // Payload Limit 

app.post('/api/login', async (req, res) => {
    try {
        const email = String(req.body?.email || '').trim();
        const password = String(req.body?.password || '');
        if (!ADMIN_EMAIL || !ADMIN_PASS_HASH) {
            return res.status(500).json({ error: 'Sunucu giriş yapılandırması eksik.' });
        }

        if (email !== ADMIN_EMAIL) {
            return res.status(401).json({ error: 'Geçersiz e-posta veya şifre' });
        }

        const match = await bcrypt.compare(password, ADMIN_PASS_HASH);
        if (!match) {
            return res.status(401).json({ error: 'Geçersiz e-posta veya şifre' });
        }

        req.session.regenerate((regenErr) => {
            if (regenErr) {
                console.error('Session regenerate hatası:', regenErr);
                return res.status(500).json({ error: 'Oturum başlatılamadı.' });
            }

            req.session.user = { email };
            req.session.save((saveErr) => {
                if (saveErr) {
                    console.error('Session save hatası:', saveErr);
                    return res.status(500).json({ error: 'Oturum kaydedilemedi.' });
                }
                res.json({ success: true });
            });
        });
    } catch (err) {
        console.error('Login endpoint hatası:', err);
        res.status(500).json({ error: 'Giriş sırasında beklenmeyen bir hata oluştu.' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/check-auth', (req, res) => {
    res.json({ authenticated: !!(req.session && req.session.user) });
});

app.get('/healthz', (req, res) => {
    res.json({
        ok: runtimeStatus.http === 'listening',
        status: runtimeStatus
    });
});

app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public/login.html')));
app.use(requireAuth, express.static('public'));
app.use('/uploads', requireAuth, express.static('uploads'));

let sock = null;
let isConnected = false;
let currentMedia = [];
let lastQR = null;
let initLock = false; // Multiple init WhatsApp Shield
let reconnectTimer = null;
let whatsappRetryCount = 0;
const maxWhatsAppAutoRetries = Number.parseInt(process.env.WHATSAPP_MAX_AUTO_RETRIES || '3', 10);
const runtimeStatus = {
    startedAt: new Date().toISOString(),
    http: 'starting',
    whatsapp: 'idle',
    lastError: null
};

const normalizePhone = (value) => String(value || '').replace(/[^\d]/g, '');

const normalizeContacts = (list) => {
    if (!Array.isArray(list)) return [];
    const seenPhones = new Set();
    const normalized = [];

    for (const item of list) {
        const phone = normalizePhone(item?.phone);
        if (phone.length < 5 || seenPhones.has(phone)) continue;
        seenPhones.add(phone);
        normalized.push({
            name: String(item?.name || '').trim(),
            surname: String(item?.surname || '').trim(),
            phone
        });
    }

    return normalized;
};

app.get('/api/version', async (req, res) => {
    try {
        const pkg = await fs.readJson(path.join(__dirname, 'package.json'));
        res.json({ version: pkg.version });
    } catch (e) {
        res.json({ version: '1.0.0' });
    }
});

app.get('/api/runtime-status', (req, res) => {
    res.json(runtimeStatus);
});

// --- VERİTABANI API (SQLite) ---

app.get('/api/templates', async (req, res) => {
    try {
        const data = await db.getTemplates();
        res.json(data);
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/templates', async (req, res) => {
    try {
        const id = uuidv4();
        if(!req.body.name || !req.body.text) return res.status(400).json({error: 'Bos isim veya içerik'});
        const newTpl = await db.createTemplate(id, req.body.name, req.body.text);
        res.json({ success: true, template: newTpl });
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/groups', async (req, res) => {
    try {
        const data = await db.getGroups();
        res.json(data);
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/groups', async (req, res) => {
    try {
        const groupName = String(req.body?.name || '').trim();
        if (!groupName) return res.status(400).json({error: 'İsim gerekli'});
        const id = uuidv4();
        const newGroup = await db.createGroup(id, groupName);
        res.json(newGroup);
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.put('/api/groups/:id', async (req, res) => {
    try {
        if (!Array.isArray(req.body?.contacts)) return res.status(400).json({error: 'Contacts gerekli'});
        const contacts = normalizeContacts(req.body.contacts);
        await db.updateGroupContacts(req.params.id, contacts);
        res.json({ success: true });
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/groups/:id', async (req, res) => {
    try {
        await db.deleteGroup(req.params.id);
        res.json({ success: true });
    } catch(e) { res.status(500).json({error: e.message}); }
});

// --- DOSYA API ---

app.post('/api/upload-media', (req, res) => {
    upload.array('media')(req, res, function (err) {
        if (err) return res.status(400).json({ error: err.message });
        currentMedia = req.files.map(f => ({ path: f.path, mimetype: f.mimetype, name: f.originalname }));
        res.json(currentMedia);
    });
});

app.delete('/api/upload-media/:index', async (req, res) => {
    try {
        const index = Number.parseInt(req.params.index, 10);
        if (!Number.isInteger(index) || index < 0 || index >= currentMedia.length) {
            return res.status(400).json({ error: 'Geçersiz medya seçimi' });
        }

        const [removed] = currentMedia.splice(index, 1);
        if (removed?.path) {
            const uploadsDir = path.resolve(__dirname, 'uploads');
            const mediaPath = path.resolve(__dirname, removed.path);
            if (mediaPath.startsWith(uploadsDir + path.sep)) {
                await fs.remove(mediaPath);
            }
        }

        res.json(currentMedia);
    } catch (err) {
        res.status(500).json({ error: 'Medya silinemedi: ' + err.message });
    }
});

app.post('/api/upload-excel', (req, res) => {
    upload.single('excel')(req, res, function (err) {
        if (err) return res.status(400).json({ error: err.message });
        try {
            const workbook = xlsx.readFile(req.file.path);
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const rawData = xlsx.utils.sheet_to_json(sheet);

            if (!rawData || rawData.length === 0) {
                return res.status(400).json({ error: 'Excel dosyası boş veya okunamadı.' });
            }

            // Case-insensitive ve çoklu alias destekli sütun eşleştirme
            const findColumn = (row, aliases) => {
                const keys = Object.keys(row);
                for (const alias of aliases) {
                    const found = keys.find(k => k.trim().toLowerCase() === alias.toLowerCase());
                    if (found && row[found] !== undefined && row[found] !== null) {
                        return String(row[found]).trim();
                    }
                }
                return '';
            };

            const phoneAliases = ['Numara', 'numara', 'phone', 'Phone', 'telefon', 'Telefon', 'tel', 'Tel', 'cep', 'Cep', 'mobile', 'Mobile', 'no', 'No', 'number', 'Number', 'PhoneNumber', 'phone_number', 'telefon_no'];
            const nameAliases = ['İsim', 'isim', 'name', 'Name', 'ad', 'Ad', 'AD', 'İSİM', 'first_name', 'firstName', 'Ad Soyad', 'ad soyad', 'adsoyad', 'AdSoyad', 'isim soyisim', 'İsim Soyisim'];
            const surnameAliases = ['Soyisim', 'soyisim', 'SOYİSİM', 'surname', 'Surname', 'soyad', 'Soyad', 'last_name', 'lastName'];

            const data = normalizeContacts(rawData.map(row => ({
                phone: normalizePhone(findColumn(row, phoneAliases)),
                name: findColumn(row, nameAliases),
                surname: findColumn(row, surnameAliases)
            })));

            console.log(`📊 Excel yüklendi: ${rawData.length} satır okundu, ${data.length} geçerli kişi bulundu. Sütunlar: ${Object.keys(rawData[0] || {}).join(', ')}`);

            if (data.length === 0) {
                return res.status(400).json({ 
                    error: `Excel'de geçerli kişi bulunamadı. Algılanan sütunlar: [${Object.keys(rawData[0] || {}).join(', ')}]. Beklenen: Numara, İsim, Soyisim` 
                });
            }

            res.json(data);
        } catch (e) { 
            console.error('Excel parse hatası:', e);
            res.status(500).json({ error: 'Excel okuma hatası: ' + e.message }); 
        }
    });
});

app.get('/api/download-sample', (req, res) => {
    const wb = xlsx.utils.book_new();
    const ws_data = [["Numara", "İsim", "Soyisim"], ["905320000000", "Ahmet", "Yılmaz"]];
    const ws = xlsx.utils.aoa_to_sheet(ws_data);
    xlsx.utils.book_append_sheet(wb, ws, "Rehber");
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=ornek_rehber.xlsx');
    res.send(buf);
});

// Campaign State Recovery
app.get('/api/campaign-status', (req, res) => {
    const status = getCampaignStatus('main_campaign');
    res.json({ campaign: status });
});

app.post('/api/reset-session', async (req, res) => {
    try {
        console.log('🔄 Oturum sıfırlama isteği alındı...');
        isConnected = false;
        lastQR = null;
        if (sock) { 
            sock.ev.removeAllListeners();
            sock.end(); 
            sock = null;
        }
        const sessionPath = path.join(__dirname, 'auth/session');
        if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath);
        res.json({ success: true, message: 'Oturum temizlendi.' });
        whatsappRetryCount = 0;
        scheduleWhatsAppInit(1000);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    console.log('🔌 Tarayıcı bağlandı:', socket.id);
    socket.emit('status', isConnected ? 'connected' : 'disconnected');
    if (!isConnected && lastQR) socket.emit('qr', lastQR);
    
    socket.on('stop-bulk', () => {
        stopCampaign('main_campaign');
        socket.emit('log', { type: 'error', message: '🛑 İşlem durduruldu.' });
    });

    socket.on('start-bulk', async (data) => {
        const { contacts, message, delayRange, dailyLimit } = data;
        if (!isConnected || !sock) return socket.emit('log', { type: 'error', message: 'Bağlı değil!' });
        socket.emit('log', { type: 'info', message: '🚀 Gönderim kuyruğu başladı.' });
        try {
            await sendBulkWithProgress(sock, contacts, message, socket, delayRange, currentMedia, 'main_campaign', { dailyLimit });
            currentMedia = [];
        } catch (err) { }
    });
});

async function initWhatsApp() {
    if(initLock) return;
    initLock = true;
    reconnectTimer = null;
    runtimeStatus.whatsapp = 'starting';
    runtimeStatus.lastError = null;
    console.log('🚀 WhatsApp motoru başlatılıyor...');
    
    // Clean old sock to prevent memory leaks
    if(sock) {
        try { sock.ev.removeAllListeners(); sock.end(); } catch(e){}
    }
    
    try {
        const config = await getSocketConfig();
        sock = config.sock;
        config.ev.on('creds.update', config.saveCreds);
        config.ev.on('connection.update', (update) => {
            const { connection, qr, lastDisconnect } = update;
            
            if (qr) {
                runtimeStatus.whatsapp = 'qr';
                lastQR = qr;
                io.emit('qr', qr);
            }
            
            if (connection === 'open') { 
                console.log('✅ Bağlantı BAŞARILI!');
                whatsappRetryCount = 0;
                const initialWait = Math.floor(Math.random() * 5000) + 2000;
                setTimeout(() => {
                    isConnected = true; 
                    runtimeStatus.whatsapp = 'connected';
                    lastQR = null;
                    io.emit('status', 'connected'); 
                }, initialWait);
            }
            
            if (connection === 'close') { 
                const reason = lastDisconnect?.error?.output?.statusCode;
                console.log('❌ Bağlantı Kesildi. Kod:', reason);
                isConnected = false; 
                runtimeStatus.whatsapp = 'disconnected';
                runtimeStatus.lastError = reason ? `WhatsApp bağlantısı kapandı. Kod: ${reason}` : 'WhatsApp bağlantısı kapandı.';
                io.emit('status', 'disconnected');
                
                initLock = false; // Release lock for reconnect
                
                if (reason === 401 || reason === 440) {
                    console.log('⚠️ Oturum bozulmuş. Otomatik temizleniyor...');
                    const sessionPath = path.join(__dirname, 'auth/session');
                    if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath);
                    scheduleWhatsAppInit(5000);
                } else if(reason !== 428) {
                    scheduleWhatsAppReconnect();
                }
            }
        });
    } catch (err) {
        console.log('🚨 Başlatma hatası:', err.message);
        runtimeStatus.whatsapp = 'error';
        runtimeStatus.lastError = err.message;
        initLock = false;
        scheduleWhatsAppReconnect();
    }
}

function scheduleWhatsAppInit(delayMs = 1500) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    runtimeStatus.whatsapp = 'scheduled';
    reconnectTimer = setTimeout(() => {
        initWhatsApp().catch((err) => {
            runtimeStatus.whatsapp = 'error';
            runtimeStatus.lastError = err.message;
            console.error('WhatsApp init beklenmeyen hata:', err);
        });
    }, delayMs);
}

function scheduleWhatsAppReconnect() {
    if (whatsappRetryCount >= maxWhatsAppAutoRetries) {
        runtimeStatus.whatsapp = 'paused';
        runtimeStatus.lastError = `WhatsApp bağlantısı kurulamadı. Otomatik deneme ${maxWhatsAppAutoRetries} denemeden sonra durduruldu.`;
        console.log(`⏸️ ${runtimeStatus.lastError}`);
        return;
    }

    whatsappRetryCount++;
    const reconnectDelay = Math.min(60000, 10000 * whatsappRetryCount);
    console.log(`⏳ ${reconnectDelay / 1000}sn sonra yeniden bağlanılacak... (${whatsappRetryCount}/${maxWhatsAppAutoRetries})`);
    scheduleWhatsAppInit(reconnectDelay);
}

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ [CRITICAL] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('⚠️ [CRITICAL] Uncaught Exception:', err);
});

const PORT = process.env.PORT || 3005;
const HOST = process.env.HOST || '0.0.0.0';

server.on('error', (err) => {
    runtimeStatus.http = 'error';
    runtimeStatus.lastError = err.message;
    console.error('🚨 HTTP sunucu başlatılamadı:', err);
    process.exit(1);
});

server.listen(PORT, HOST, () => {
    runtimeStatus.http = 'listening';
    console.log(`\n================================================`);
    console.log(`🌍 WhasAppC Pro Enterprise Aktif: http://${HOST}:${PORT}`);
    console.log(`================================================\n`);
    scheduleWhatsAppInit();
});
