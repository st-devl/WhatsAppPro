const {
    optionalString,
    requireAnyField,
    requiredArray,
    requireObject
} = require('../lib/validation');
const { createContactsWorkbookBuffer } = require('../lib/excel_import');

function normalizeContactInput(input) {
    const body = requireObject(input);
    return {
        phone: optionalString(body.phone),
        name: optionalString(body.name),
        surname: optionalString(body.surname)
    };
}

function normalizeSuppressionInput(input) {
    const body = requireObject(input);
    let contacts = [];
    if (Array.isArray(body.contacts)) {
        contacts = body.contacts;
    } else if (Array.isArray(body.phones)) {
        contacts = body.phones.map(phone => ({ phone }));
    }

    if (contacts.length === 0) requiredArray(body.contacts, 'Gönderim dışı bırakılacak kişi listesi gerekli', 'SUPPRESSED_RECIPIENTS_REQUIRED');

    return {
        contacts,
        reason: optionalString(body.reason)
    };
}

function normalizeSuppressionRemovalInput(input) {
    const body = requireObject(input);
    return {
        phones: requiredArray(body.phones, 'Gönderime geri alınacak telefon listesi gerekli', 'SUPPRESSED_RECIPIENTS_REQUIRED')
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

        async exportContactsWorkbook(context = {}) {
            const contacts = await db.getExportableContacts(tenantId(context));
            const buffer = await createContactsWorkbookBuffer(contacts);
            return { buffer, count: contacts.length };
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
        },

        listSuppressedRecipients(query = {}, context = {}) {
            return db.getSuppressedRecipients(tenantId(context), query);
        },

        suppressRecipients(input, context = {}) {
            const normalized = normalizeSuppressionInput(input);
            return db.suppressRecipients(normalized.contacts, tenantId(context), {
                reason: normalized.reason || 'Manuel olarak gönderim dışı bırakıldı',
                source: 'manual',
                userEmail: context.userEmail || null
            });
        },

        unsuppressRecipients(input, context = {}) {
            const normalized = Array.isArray(input)
                ? { phones: input }
                : normalizeSuppressionRemovalInput(input);
            return db.unsuppressRecipients(normalized.phones, tenantId(context));
        }
    };
}

module.exports = { createContactService };
