const { v4: uuidv4 } = require('uuid');
const {
    requireObject,
    requiredArray,
    requiredString
} = require('../lib/validation');

function parseListOptions(query = {}) {
    return {
        includeContacts: String(query.include_contacts || '').toLowerCase() === 'true'
    };
}

function createGroupService(db) {
    return {
        async listGroups(query = {}) {
            const options = parseListOptions(query);
            if (!options.includeContacts) {
                return db.getGroups();
            }

            const groups = await db.getGroups();
            await Promise.all(groups.map(async (group) => {
                group.contacts = await db.getGroupContacts(group.id);
                group.contact_count = group.contacts.length;
            }));
            return groups;
        },

        listGroupSummaries() {
            return db.getGroups();
        },

        createGroup(input) {
            const body = requireObject(input);
            const name = requiredString(body.name, 'İsim gerekli', 'GROUP_NAME_REQUIRED');
            return db.createGroup(uuidv4(), name);
        },

        replaceContacts(groupId, input) {
            const body = requireObject(input);
            const contacts = requiredArray(body.contacts, 'Contacts gerekli', 'CONTACTS_REQUIRED');
            return db.updateGroupContacts(groupId, contacts);
        },

        deleteGroup(groupId) {
            return db.deleteGroup(groupId);
        }
    };
}

module.exports = { createGroupService };
