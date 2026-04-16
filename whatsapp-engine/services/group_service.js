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
    const tenantId = (context = {}) => context.tenantId;

    return {
        async listGroups(query = {}, context = {}) {
            const options = parseListOptions(query);
            if (!options.includeContacts) {
                return db.getGroups(tenantId(context));
            }

            const groups = await db.getGroups(tenantId(context));
            await Promise.all(groups.map(async (group) => {
                group.contacts = await db.getGroupContacts(group.id, tenantId(context));
                group.contact_count = group.contacts.length;
            }));
            return groups;
        },

        listGroupSummaries(context = {}) {
            return db.getGroups(tenantId(context));
        },

        createGroup(input, context = {}) {
            const body = requireObject(input);
            const name = requiredString(body.name, 'İsim gerekli', 'GROUP_NAME_REQUIRED');
            return db.createGroup(uuidv4(), name, tenantId(context));
        },

        replaceContacts(groupId, input, context = {}) {
            const body = requireObject(input);
            const contacts = requiredArray(body.contacts, 'Contacts gerekli', 'CONTACTS_REQUIRED');
            return db.updateGroupContacts(groupId, contacts, tenantId(context));
        },

        deleteGroup(groupId, context = {}) {
            return db.deleteGroup(groupId, tenantId(context));
        }
    };
}

module.exports = { createGroupService };
