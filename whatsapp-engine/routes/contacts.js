const express = require('express');
const { asyncHandler } = require('../lib/api_errors');
const { sendCreated, sendSuccess } = require('../lib/api_response');
const { createContactService } = require('../services/contact_service');

function createContactRouter(db) {
    const router = express.Router();
    const contactService = createContactService(db);

    router.get('/groups/:groupId/contacts', asyncHandler(async (req, res) => {
        const result = await contactService.listContactsPage(req.params.groupId, req.query);
        sendSuccess(res, result.contacts, 'CONTACTS_LISTED', {
            meta: {
                pagination: result.pagination,
                sort: result.sort,
                search: result.search
            }
        });
    }));

    router.post('/groups/:groupId/contacts', asyncHandler(async (req, res) => {
        const contact = await contactService.createContact(req.params.groupId, req.body);
        sendCreated(res, contact, 'CONTACT_CREATED');
    }));

    router.patch('/groups/:groupId/contacts/:contactId', asyncHandler(async (req, res) => {
        sendSuccess(res, await contactService.updateContact(req.params.groupId, req.params.contactId, req.body), 'CONTACT_UPDATED');
    }));

    router.delete('/groups/:groupId/contacts/:contactId', asyncHandler(async (req, res) => {
        sendSuccess(res, await contactService.deleteContact(req.params.groupId, req.params.contactId), 'CONTACT_DELETED');
    }));

    return router;
}

module.exports = { createContactRouter };
