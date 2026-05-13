const { spawnSync } = require('child_process');

const omitValues = String(process.env.npm_config_omit || '')
    .split(/[,\s]+/)
    .filter(Boolean);

const installMode = String(process.env.WHASAPPC_ENGINE_INSTALL_MODE || '').trim().toLowerCase();
const productionInstall = installMode === 'production'
    || process.env.NODE_ENV === 'production'
    || process.env.npm_config_production === 'true'
    || omitValues.includes('dev');

const args = ['--prefix', 'whatsapp-engine', productionInstall ? 'ci' : 'install'];
if (productionInstall) args.push('--omit=dev');

const result = spawnSync('npm', args, {
    stdio: 'inherit',
    shell: process.platform === 'win32'
});

if (result.error) throw result.error;
process.exit(result.status === null ? 1 : result.status);
