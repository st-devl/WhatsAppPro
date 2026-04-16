const { v4: uuidv4 } = require('uuid');
const {
    requireObject,
    requiredString
} = require('../lib/validation');

function createTemplateService(db) {
    return {
        listTemplates() {
            return db.getTemplates();
        },

        createTemplate(input) {
            const body = requireObject(input);
            const name = requiredString(body.name, 'Şablon adı gerekli', 'TEMPLATE_NAME_REQUIRED');
            const text = requiredString(body.text, 'Şablon içeriği gerekli', 'TEMPLATE_TEXT_REQUIRED');
            return db.createTemplate(uuidv4(), name, text);
        }
    };
}

module.exports = { createTemplateService };
