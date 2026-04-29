const path = require('path');
const fs = require('fs-extra');

async function readReleaseManifest(baseDir) {
    const pkg = await fs.readJson(path.join(baseDir, 'package.json')).catch(() => ({ version: '0.0.0' }));
    const manifest = await fs.readJson(path.join(baseDir, 'public', 'release.json')).catch(() => ({}));
    const version = manifest.version || pkg.version || '0.0.0';
    const commit = manifest.commit || process.env.RELEASE_COMMIT || 'unknown';
    const frontendRevision = manifest.frontend_revision || manifest.frontendRevision || `${version}-${commit}`;

    return {
        version,
        commit,
        build_time: manifest.build_time || manifest.buildTime || null,
        frontend_revision: frontendRevision,
        environment: manifest.environment || process.env.NODE_ENV || 'development'
    };
}

module.exports = { readReleaseManifest };
