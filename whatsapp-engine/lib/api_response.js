function sendSuccess(res, data = null, code = 'OK', options = {}) {
    const body = {
        data,
        error: null,
        code
    };

    if (options.meta) body.meta = options.meta;
    res.status(options.status || 200).json(body);
}

function sendCreated(res, data = null, code = 'CREATED', options = {}) {
    sendSuccess(res, data, code, { ...options, status: 201 });
}

module.exports = {
    sendSuccess,
    sendCreated
};
