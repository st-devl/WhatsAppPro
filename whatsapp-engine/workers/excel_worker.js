const { parentPort, workerData } = require('worker_threads');
const { readWorkbookObjects } = require('../lib/excel_import');

(async () => {
    try {
        const result = await readWorkbookObjects(workerData.filePath);
        parentPort.postMessage({ ok: true, result });
    } catch (err) {
        parentPort.postMessage({
            ok: false,
            error: {
                message: err.message,
                name: err.name,
                stack: err.stack
            }
        });
    }
})();
