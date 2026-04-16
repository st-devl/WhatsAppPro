const ExcelJS = require('exceljs');

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
    createSampleWorkbookBuffer
};

