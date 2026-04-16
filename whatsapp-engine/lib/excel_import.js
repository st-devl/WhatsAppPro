const ExcelJS = require('exceljs');
const path = require('path');
const { Worker } = require('worker_threads');

function excelCellToString(value) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value !== 'object') return String(value).trim();
    if (value.text !== undefined) return String(value.text).trim();
    if (value.result !== undefined) return excelCellToString(value.result);
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text || '').join('').trim();
    return String(value).trim();
}

function worksheetToObjects(worksheet) {
    if (!worksheet) return { rows: [], columns: [] };

    const headerRow = worksheet.getRow(1);
    const headers = new Map();
    headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const header = excelCellToString(cell.value);
        if (header) headers.set(colNumber, header);
    });

    const rows = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        const item = {};
        for (const [colNumber, header] of headers.entries()) {
            item[header] = excelCellToString(row.getCell(colNumber).value);
        }
        if (Object.values(item).some(value => value !== '')) rows.push(item);
    });

    return { rows, columns: [...headers.values()] };
}

async function readWorkbookObjects(filePath) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const worksheet = workbook.worksheets[0];
    return worksheetToObjects(worksheet);
}

function readWorkbookObjectsInWorker(filePath, options = {}) {
    const timeoutMs = Number.parseInt(options.timeoutMs || process.env.EXCEL_IMPORT_TIMEOUT_MS || '30000', 10);
    const workerPath = path.join(__dirname, '../workers/excel_worker.js');

    return new Promise((resolve, reject) => {
        const worker = new Worker(workerPath, { workerData: { filePath } });
        const timeout = setTimeout(() => {
            worker.terminate().catch(() => {});
            reject(new Error('Excel import zaman aşımına uğradı.'));
        }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000);

        worker.once('message', (message) => {
            clearTimeout(timeout);
            worker.terminate().catch(() => {});
            if (message?.ok) {
                resolve(message.result);
                return;
            }

            const err = new Error(message?.error?.message || 'Excel import worker hatası');
            err.name = message?.error?.name || 'ExcelImportWorkerError';
            reject(err);
        });

        worker.once('error', (err) => {
            clearTimeout(timeout);
            worker.terminate().catch(() => {});
            reject(err);
        });

        worker.once('exit', (code) => {
            if (code === 0) return;
            clearTimeout(timeout);
            reject(new Error(`Excel import worker beklenmeyen şekilde kapandı. Kod: ${code}`));
        });
    });
}

async function createSampleWorkbookBuffer() {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Rehber');
    worksheet.addRow(['Numara', 'İsim', 'Soyisim']);
    worksheet.addRow(['905320000000', 'Ahmet', 'Yılmaz']);
    worksheet.columns.forEach(column => { column.width = 18; });
    const buf = await workbook.xlsx.writeBuffer();
    return Buffer.from(buf);
}

module.exports = {
    excelCellToString,
    worksheetToObjects,
    readWorkbookObjects,
    readWorkbookObjectsInWorker,
    createSampleWorkbookBuffer
};
