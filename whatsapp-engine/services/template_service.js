const { v4: uuidv4 } = require('uuid');
const {
    requireObject,
    requiredString
} = require('../lib/validation');
const { validateTemplate } = require('../shared/message_renderer');
const { badRequest } = require('../lib/api_errors');

function createTemplateService(db) {
    const tenantId = (context = {}) => context.tenantId;

    return {
        listTemplates(context = {}) {
            return db.getTemplates(tenantId(context));
        },

        createTemplate(input, context = {}) {
            const body = requireObject(input);
            const name = requiredString(body.name, 'Şablon adı gerekli', 'TEMPLATE_NAME_REQUIRED');
            const text = requiredString(body.text, 'Şablon içeriği gerekli', 'TEMPLATE_TEXT_REQUIRED');
            const validation = validateTemplate(text);
            if (!validation.valid) {
                throw badRequest('Şablon söz dizimi geçersiz', 'TEMPLATE_SYNTAX_INVALID', validation.issues);
            }
            return db.createTemplate(uuidv4(), name, text, tenantId(context));
        }
    };
}

module.exports = { createTemplateService };
