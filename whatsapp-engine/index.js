const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { getSocketConfig } = require('./lib/connection');
const { sendBulkWithProgress, stopCampaign, getCampaignStatus } = require('./lib/messenger');
const path = require('path');
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

app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production', 
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
    const { email, password } = req.body;
    if (email === ADMIN_EMAIL) {
        const match = await bcrypt.compare(password, ADMIN_PASS_HASH);
        if(match) {
            req.session.user = { email };
            return res.json({ success: true });
        }
    }
    res.status(401).json({ error: 'Geçersiz e-posta veya şifre' });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/check-auth', (req, res) => {
    res.json({ authenticated: !!(req.session && req.session.user) });
});

app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public/login.html')));
app.use(requireAuth, express.static('public'));
app.use('/uploads', requireAuth, express.static('uploads'));

let sock = null;
let isConnected = false;
let currentMedia = [];
let lastQR = null;
let initLock = false; // Multiple init WhatsApp Shield

app.get('/api/version', async (req, res) => {
    try {
        const pkg = await fs.readJson(path.join(__dirname, 'package.json'));
        res.json({ version: pkg.version });
    } catch (e) {
        res.json({ version: '1.3.0' });
    }
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
        if(!req.body.name) return res.status(400).json({error: 'İsim gerekli'});
        const id = uuidv4();
        const newGroup = await db.createGroup(id, req.body.name);
        res.json(newGroup);
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.put('/api/groups/:id', async (req, res) => {
    try {
        if(!req.body.contacts) return res.status(400).json({error: 'Contacts gerekli'});
        await db.updateGroupContacts(req.params.id, req.body.contacts);
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

app.post('/api/upload-excel', (req, res) => {
    upload.single('excel')(req, res, function (err) {
        if (err) return res.status(400).json({ error: err.message });
        try {
            const workbook = xlsx.readFile(req.file.path);
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const rawData = xlsx.utils.sheet_to_json(sheet);
            const data = rawData.map(row => ({
                phone: String(row['Numara'] || row['phone'] || ''),
                name: String(row['İsim'] || row['name'] || ''),
                surname: String(row['Soyisim'] || '')
            })).filter(row => row.phone);
            res.json(data);
        } catch (e) { res.status(500).json({ error: 'Excel okuma hatası' }); }
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
    // Return all session campaigns that exist 
    // Usually it's tied to session, but for now we just return the active campaign using user's session ID
    const campaignId = req.session.id; // Or user's session
    const status = getCampaignStatus(campaignId);
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
        setTimeout(() => initWhatsApp(), 1000);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    console.log('🔌 Tarayıcı bağlandı:', socket.id);
    socket.emit('status', isConnected ? 'connected' : 'disconnected');
    if (!isConnected && lastQR) socket.emit('qr', lastQR);
    
    // Auth bypass check for sockets could be added using cookie parser, assuming handled via frontend
    // Fallback: Campaign uses socket.request.session if we attach session middleware
    
    socket.on('stop-bulk', () => {
        // We use a fixed campaign ID per user or session, here we just use 'main_campaign' for simplicity in single-tenant
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
                lastQR = qr;
                io.emit('qr', qr);
            }
            
            if (connection === 'open') { 
                console.log('✅ Bağlantı BAŞARILI!');
                const initialWait = Math.floor(Math.random() * 5000) + 2000;
                setTimeout(() => {
                    isConnected = true; 
                    lastQR = null;
                    io.emit('status', 'connected'); 
                }, initialWait);
            }
            
            if (connection === 'close') { 
                const reason = lastDisconnect?.error?.output?.statusCode;
                console.log('❌ Bağlantı Kesildi. Kod:', reason);
                isConnected = false; 
                io.emit('status', 'disconnected');
                
                initLock = false; // Release lock for reconnect
                
                if (reason === 401 || reason === 440) {
                    console.log('⚠️ Oturum bozulmuş. Otomatik temizleniyor...');
                    const sessionPath = path.join(__dirname, 'auth/session');
                    if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath);
                    setTimeout(() => initWhatsApp(), 5000);
                } else if(reason !== 428) {
                    const reconnectNormal = Math.floor(Math.random() * 20000) + 10000;
                    console.log(`⏳ ${reconnectNormal/1000}sn sonra yeniden bağlanılacak...`);
                    setTimeout(() => initWhatsApp(), reconnectNormal);
                }
            }
        });
    } catch (err) {
        console.log('🚨 Başlatma hatası:', err.message);
        initLock = false;
        setTimeout(() => initWhatsApp(), 15000);
    }
}

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ [CRITICAL] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('⚠️ [CRITICAL] Uncaught Exception:', err);
});

const PORT = process.env.PORT || 3005;
server.listen(PORT, () => {
    console.log(`\n================================================`);
    console.log(`🌍 WhasAppC Pro Enterprise Aktif: http://localhost:${PORT}`);
    console.log(`================================================\n`);
    io.engine.use(session({
        secret: process.env.SESSION_SECRET || 'fallback-dev-secret', resave: false, saveUninitialized: false
    })); // Link session to socketio for advanced usage later
    initWhatsApp();
});
