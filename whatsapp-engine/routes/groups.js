const express = require('express');
const { asyncHandler } = require('../lib/api_errors');
const { sendCreated, sendSuccess } = require('../lib/api_response');
const { createGroupService } = require('../services/group_service');

function createGroupRouter(db) {
    const router = express.Router();
    const groupService = createGroupService(db);

    router.get('/groups', asyncHandler(async (req, res) => {
        sendSuccess(res, await groupService.listGroups(req.query), 'GROUPS_LISTED');
    }));

    router.post('/groups', asyncHandler(async (req, res) => {
        sendCreated(res, await groupService.createGroup(req.body), 'GROUP_CREATED');
    }));

    router.put('/groups/:id', asyncHandler(async (req, res) => {
        sendSuccess(res, await groupService.replaceContacts(req.params.id, req.body), 'GROUP_CONTACTS_REPLACED');
    }));

    router.delete('/groups/:id', asyncHandler(async (req, res) => {
        sendSuccess(res, await groupService.deleteGroup(req.params.id), 'GROUP_DELETED');
    }));

    return router;
}

module.exports = { createGroupRouter };
