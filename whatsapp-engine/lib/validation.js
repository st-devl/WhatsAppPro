const { badRequest } = require('./api_errors');

function requireObject(value, message = 'Geçerli JSON body gerekli.', code = 'INVALID_BODY') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw badRequest(message, code);
    }
    return value;
}

function requiredString(value, message, code = 'REQUIRED_STRING') {
    const text = String(value ?? '').trim();
    if (!text) throw badRequest(message, code);
    return text;
}

function optionalString(value) {
    if (value === undefined || value === null) return undefined;
    return String(value).trim();
}

function requiredArray(value, message, code = 'REQUIRED_ARRAY') {
    if (!Array.isArray(value)) throw badRequest(message, code);
    return value;
}

function requireAnyField(input, fields, message, code = 'EMPTY_UPDATE') {
    const body = requireObject(input);
    const hasAny = fields.some(field => body[field] !== undefined);
    if (!hasAny) throw badRequest(message, code);
    return body;
}

function requiredUploadFile(file, message = 'Dosya gerekli.', code = 'UPLOAD_FILE_REQUIRED') {
    if (!file) throw badRequest(message, code);
    return file;
}

module.exports = {
    requireObject,
    requiredString,
    optionalString,
    requiredArray,
    requireAnyField,
    requiredUploadFile
};
