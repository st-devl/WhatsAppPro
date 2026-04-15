const path = require('path');

// Hosting paneli root'tan başlatsa da uygulamayı kendi dizininde çalıştır.
process.chdir(path.join(__dirname, 'whatsapp-engine'));
require('./whatsapp-engine/index.js');
