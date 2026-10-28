const { componentLogger } = require('../lib/logger');

const socketLogger = componentLogger('campaign_socket');

function registerCampaignSocket(io, options = {}) {
    const { runtime, campaignService } = options;

    io.use((socket, next) => {
        if (socket.request.session?.user) return next();
        next(new Error('Yetkisiz socket bağlantısı'));
    });

    io.on('connection', (socket) => {
        const ownerEmail = socket.request.session.user.email;
        const tenantId = socket.request.session.user.tenant_id || 'default';
        const userId = socket.request.session.user.user_id;
        socket.join(runtime.tenantRoom(tenantId));
        socketLogger.info({ socketId: socket.id, tenantId, userId }, 'authenticated_socket_connected');
        socket.emit('status', runtime.connected(tenantId) ? 'connected' : 'disconnected');
        if (!runtime.connected(tenantId) && runtime.getLastQR(tenantId) && runtime.isTenantSupported(tenantId)) socket.emit('qr', runtime.getLastQR(tenantId));

        socket.on('stop-bulk', async (data = {}) => {
            try {
                await campaignService.stopActive(ownerEmail, data?.campaignId || null, tenantId);
                socket.emit('log', { type: 'error', message: '🛑 İşlem durduruldu.' });
            } catch (err) {
                socket.emit('log', { type: 'error', message: `Durdurma hatası: ${err.message}` });
            }
        });

        socket.on('finish-bulk', async (data = {}) => {
            try {
                const status = await campaignService.finish(data?.campaignId, ownerEmail, tenantId);
                socket.emit('campaign-progress', { ...(status || {}), status: 'finished', phase: 'finished' });
                socket.emit('log', { type: 'error', message: '🛑 Kampanya bitirildi. Bu kampanyadan tekrar mesaj gönderilmeyecek.' });
            } catch (err) {
                socket.emit('log', { type: 'error', message: `Kampanya bitirme hatası: ${err.message}` });
            }
        });

        socket.on('start-bulk', async (data) => {
            try {
                await campaignService.start(data, socket);
            } catch (err) {
                socket.emit('log', { type: 'error', message: `Gönderim hatası: ${err.message}` });
            }
        });

        socket.on('resume-bulk', async (data = {}) => {
            try {
                await campaignService.resume(data?.campaignId, ownerEmail, socket, { tenantId });
            } catch (err) {
                socket.emit('log', { type: 'error', message: `Devam ettirme hatası: ${err.message}` });
            }
        });

        socket.on('retry-bulk', async (data = {}) => {
            try {
                await campaignService.retry(data?.campaignId, ownerEmail, socket, { tenantId });
            } catch (err) {
                socket.emit('log', { type: 'error', message: `Gönderilmeyenleri tekrar gönderme hatası: ${err.message}` });
            }
        });

        socket.on('retry-skipped-bulk', async (data = {}) => {
            try {
                await campaignService.retrySkipped(data?.campaignId, ownerEmail, socket, { tenantId });
            } catch (err) {
                socket.emit('log', { type: 'error', message: `Atlananları tekrar deneme hatası: ${err.message}` });
            }
        });
    });
}

module.exports = { registerCampaignSocket };
