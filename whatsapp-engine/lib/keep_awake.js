const { spawn } = require('child_process');
const { componentLogger } = require('./logger');

const keepAwakeLogger = componentLogger('keep_awake');

class KeepAwake {
    constructor(options = {}) {
        this.enabled = String(options.enabled ?? process.env.KEEP_AWAKE_DURING_CAMPAIGN ?? 'true') === 'true';
        this.process = null;
        this.activeKeys = new Set();
    }

    start(key = 'default') {
        this.activeKeys.add(key);
        if (!this.enabled || this.process) return;

        if (process.platform !== 'darwin') {
            keepAwakeLogger.info({ platform: process.platform }, 'keep_awake_not_supported');
            return;
        }

        this.process = spawn('caffeinate', ['-dimsu'], {
            stdio: 'ignore',
            detached: false
        });
        this.process.once('error', (err) => {
            keepAwakeLogger.warn({ err }, 'keep_awake_start_failed');
            this.process = null;
        });
        this.process.once('exit', (code, signal) => {
            keepAwakeLogger.info({ code, signal }, 'keep_awake_process_exited');
            this.process = null;
        });
        keepAwakeLogger.info('keep_awake_started');
    }

    stop(key = 'default') {
        this.activeKeys.delete(key);
        if (this.activeKeys.size > 0 || !this.process) return;

        const child = this.process;
        this.process = null;
        child.kill('SIGTERM');
        keepAwakeLogger.info('keep_awake_stopped');
    }
}

module.exports = { KeepAwake };
