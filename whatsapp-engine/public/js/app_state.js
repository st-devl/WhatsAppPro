(function stateBootstrap(window) {
    const state = {
        activeCampaignId: null,
        currentContacts: [],
        visibleContacts: [],
        templates: [],
        mediaFiles: [],
        groups: [],
        activeGroupId: null,
        selectedCampaignGroupIds: new Set(),
        contactFilterQuery: ''
    };

    function get(key) {
        return state[key];
    }

    function set(key, value) {
        state[key] = value;
        return value;
    }

    function patch(values = {}) {
        Object.assign(state, values);
        return { ...state };
    }

    function snapshot() {
        return { ...state };
    }

    function expose(keys = [], target = window) {
        keys.forEach(key => {
            if (!Object.prototype.hasOwnProperty.call(state, key)) return;
            Object.defineProperty(target, key, {
                configurable: true,
                get() {
                    return state[key];
                },
                set(value) {
                    state[key] = value;
                }
            });
        });
    }

    window.WhasAppCState = {
        get,
        set,
        patch,
        snapshot,
        expose
    };
})(window);
