const express = require('express');
const { asyncHandler } = require('../lib/api_errors');
const { sendCreated, sendSuccess } = require('../lib/api_response');
const { createContactService } = require('../services/contact_service');

function createContactRouter(db) {
    const router = express.Router();
    const contactService = createContactService(db);
    const context = (req) => ({
        tenantId: req.session?.user?.tenant_id || 'default',
        userEmail: req.session?.user?.email || null
    });

    router.get('/suppressed-recipients', asyncHandler(async (req, res) => {
        const recipients = await contactService.listSuppressedRecipients({
            limit: Number.parseInt(req.query.limit, 10) || 200,
            offset: Number.parseInt(req.query.offset, 10) || 0,
            active: req.query.active || undefined
        }, context(req));
        sendSuccess(res, { recipients }, 'SUPPRESSED_RECIPIENTS_LISTED');
    }));

    router.post('/suppressed-recipients', asyncHandler(async (req, res) => {
        const result = await contactService.suppressRecipients(req.body, context(req));
        sendCreated(res, result, 'SUPPRESSED_RECIPIENTS_CREATED');
    }));

    router.post('/suppressed-recipients/remove', asyncHandler(async (req, res) => {
        const result = await contactService.unsuppressRecipients(req.body, context(req));
        sendSuccess(res, result, 'SUPPRESSED_RECIPIENTS_REMOVED');
    }));

    router.delete('/suppressed-recipients/:phone', asyncHandler(async (req, res) => {
        const result = await contactService.unsuppressRecipients([req.params.phone], context(req));
        sendSuccess(res, result, 'SUPPRESSED_RECIPIENTS_REMOVED');
    }));

    router.get('/contacts/export', asyncHandler(async (req, res) => {
        const result = await contactService.exportContactsWorkbook(context(req));
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=guncel_rehber.xlsx');
        res.setHeader('X-Exported-Contact-Count', String(result.count));
        res.send(result.buffer);
    }));

    router.get('/groups/:groupId/contacts', asyncHandler(async (req, res) => {
        const result = await contactService.listContactsPage(req.params.groupId, req.query, context(req));
        sendSuccess(res, result.contacts, 'CONTACTS_LISTED', {
            meta: {
                pagination: result.pagination,
                sort: result.sort,
                search: result.search
            }
        });
    }));

    router.post('/groups/:groupId/contacts', asyncHandler(async (req, res) => {
        const contact = await contactService.createContact(req.params.groupId, req.body, context(req));
        sendCreated(res, contact, 'CONTACT_CREATED');
    }));

    router.patch('/groups/:groupId/contacts/:contactId', asyncHandler(async (req, res) => {
        sendSuccess(res, await contactService.updateContact(req.params.groupId, req.params.contactId, req.body, context(req)), 'CONTACT_UPDATED');
    }));

    router.delete('/groups/:groupId/contacts/:contactId', asyncHandler(async (req, res) => {
        sendSuccess(res, await contactService.deleteContact(req.params.groupId, req.params.contactId, context(req)), 'CONTACT_DELETED');
    }));

    return router;
}

module.exports = { createContactRouter };
