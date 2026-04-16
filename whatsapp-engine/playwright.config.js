module.exports = {
    testDir: './tests/e2e',
    testMatch: '**/*.e2e.js',
    timeout: 30_000,
    fullyParallel: false,
    workers: 1,
    use: {
        browserName: 'chromium',
        headless: true,
        actionTimeout: 10_000,
        navigationTimeout: 15_000
    }
};
