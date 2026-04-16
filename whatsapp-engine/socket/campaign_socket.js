function registerCampaignSocket(io, options = {}) {
    const { runtime, campaignService } = options;

    io.use((socket, next) => {
        if (socket.request.session?.user) return next();
        next(new Error('Yetkisiz socket bağlantısı'));
    });

    io.on('connection', (socket) => {
        console.log('🔌 Yetkili tarayıcı bağlandı:', socket.id);
        socket.emit('status', runtime.connected() ? 'connected' : 'disconnected');
        if (!runtime.connected() && runtime.getLastQR()) socket.emit('qr', runtime.getLastQR());

        socket.on('stop-bulk', async () => {
            await campaignService.stopActive();
            socket.emit('log', { type: 'error', message: '🛑 İşlem durduruldu.' });
        });

        socket.on('start-bulk', async (data) => {
            try {
                await campaignService.start(data, socket);
            } catch (err) {
                socket.emit('log', { type: 'error', message: `Gönderim hatası: ${err.message}` });
            }
        });
    });
}

module.exports = { registerCampaignSocket };
