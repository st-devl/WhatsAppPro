const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const targets = [
    'index.js',
    'lib',
    'middleware',
    'routes',
    'services',
    'socket',
    'shared',
    'workers',
    'scripts',
    'tests',
    'public/js'
];

function collectJsFiles(targetPath, files = []) {
    const absolutePath = path.join(root, targetPath);
    if (!fs.existsSync(absolutePath)) return files;
    const stat = fs.statSync(absolutePath);
    if (stat.isFile()) {
        if (absolutePath.endsWith('.js')) files.push(absolutePath);
        return files;
    }

    for (const entry of fs.readdirSync(absolutePath)) {
        if (entry === 'node_modules') continue;
        collectJsFiles(path.join(targetPath, entry), files);
    }
    return files;
}

const files = targets.flatMap(target => collectJsFiles(target));
let failed = false;

for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], {
        cwd: root,
        stdio: 'inherit'
    });
    if (result.status !== 0) failed = true;
}

if (failed) process.exit(1);
console.log(JSON.stringify({ ok: true, checked_files: files.length }, null, 2));
