const fs = require('fs/promises');
const path = require('path');
const { execFileSync } = require('child_process');

const baseDir = path.join(__dirname, '..');
const publicDir = path.join(baseDir, 'public');
const outputPath = path.join(publicDir, 'release.json');

function argValue(name, fallback = '') {
    const prefix = `${name}=`;
    const exactIndex = process.argv.indexOf(name);
    if (exactIndex >= 0 && process.argv[exactIndex + 1]) return process.argv[exactIndex + 1];
    const inline = process.argv.find(arg => arg.startsWith(prefix));
    return inline ? inline.slice(prefix.length) : fallback;
}

function git(args, fallback = 'unknown') {
    try {
        return execFileSync('git', args, {
            cwd: path.join(baseDir, '..'),
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim() || fallback;
    } catch (_) {
        return fallback;
    }
}

async function main() {
    const pkg = JSON.parse(await fs.readFile(path.join(baseDir, 'package.json'), 'utf8'));
    const commit = argValue('--commit', git(['rev-parse', 'HEAD']));
    const shortCommit = commit === 'unknown' ? 'unknown' : commit.slice(0, 12);
    const environment = argValue('--environment', process.env.RELEASE_ENV || process.env.NODE_ENV || 'development');
    const buildTime = new Date().toISOString();
    const manifest = {
        version: pkg.version,
        commit,
        short_commit: shortCommit,
        build_time: buildTime,
        frontend_revision: `${pkg.version}-${shortCommit}`,
        environment
    };

    await fs.mkdir(publicDir, { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(JSON.stringify(manifest, null, 2));
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
