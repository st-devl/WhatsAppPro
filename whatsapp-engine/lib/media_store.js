class MediaStore {
    constructor() {
        this.files = [];
    }

    list() {
        return [...this.files];
    }

    replace(files) {
        this.files = [...files];
        return this.list();
    }

    remove(mediaPath) {
        this.files = this.files.filter(item => item.path !== mediaPath);
        return this.list();
    }

    clear() {
        this.files = [];
    }
}

module.exports = { MediaStore };

