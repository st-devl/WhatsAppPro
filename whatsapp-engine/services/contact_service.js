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
    return {
        listContacts(groupId) {
            return db.getGroupContacts(groupId);
        },

        listContactsPage(groupId, query = {}) {
            return db.getGroupContactsPage(groupId, query);
        },

        createContact(groupId, input) {
            return db.createContact(groupId, normalizeContactInput(input));
        },

        updateContact(groupId, contactId, input) {
            requireAnyField(input, ['phone', 'name', 'surname'], 'Güncellenecek kişi alanı gerekli', 'CONTACT_UPDATE_EMPTY');
            return db.updateContact(groupId, contactId, normalizeContactInput(input));
        },

        deleteContact(groupId, contactId) {
            return db.deleteContact(groupId, contactId);
        }
    };
}

module.exports = { createContactService };
