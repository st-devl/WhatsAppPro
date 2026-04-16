const {
    optionalString,
    requireAnyField,
    requireObject
} = require('../lib/validation');

function normalizeContactInput(input) {
    const body = requireObject(input);
    return {
        phone: optionalString(body.phone),
        name: optionalString(body.name),
        surname: optionalString(body.surname)
    };
}

function createContactService(db) {
    const tenantId = (context = {}) => context.tenantId;

    return {
        listContacts(groupId, context = {}) {
            return db.getGroupContacts(groupId, tenantId(context));
        },

        listContactsPage(groupId, query = {}, context = {}) {
            return db.getGroupContactsPage(groupId, query, tenantId(context));
        },

        createContact(groupId, input, context = {}) {
            return db.createContact(groupId, normalizeContactInput(input), tenantId(context));
        },

        updateContact(groupId, contactId, input, context = {}) {
            requireAnyField(input, ['phone', 'name', 'surname'], 'Güncellenecek kişi alanı gerekli', 'CONTACT_UPDATE_EMPTY');
            return db.updateContact(groupId, contactId, normalizeContactInput(input), tenantId(context));
        },

        deleteContact(groupId, contactId, context = {}) {
            return db.deleteContact(groupId, contactId, tenantId(context));
        }
    };
}

module.exports = { createContactService };
