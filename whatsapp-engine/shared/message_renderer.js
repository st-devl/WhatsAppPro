(function messageRendererFactory(root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.WhasAppCMessageRenderer = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createMessageRenderer() {
    const PLACEHOLDERS = {
        ad: contact => contact.name,
        soyad: contact => contact.surname,
        soyadi: contact => contact.surname
    };

    // {{Ad}}, {{SOYADI}} ve {{soyadı}} da aynı değişkene çıkar.
    function placeholderKey(token) {
        return String(token || '').trim().replace(/ı/g, 'i').replace(/I/g, 'i').toLowerCase();
    }

    class TemplateRenderError extends Error {
        constructor(message, details = []) {
            super(message);
            this.name = 'TemplateRenderError';
            this.code = 'TEMPLATE_SYNTAX_INVALID';
            this.details = details;
            this.status = 400;
        }
    }

    function cleanContact(contact = {}) {
        const name = String(contact.name || '').trim();
        return {
            name: name === 'Bilinmeyen' ? '' : name,
            surname: String(contact.surname || '').trim()
        };
    }

    function createIssue(code, message, token = '') {
        return { code, message, token };
    }

    function validateTemplate(template) {
        const source = String(template || '');
        const issues = [];
        if (!source.trim()) {
            issues.push(createIssue('TEMPLATE_EMPTY', 'Mesaj içeriği zorunlu'));
            return { valid: false, issues };
        }

        let scrubbed = source;
        const placeholderMatches = source.matchAll(/{{\s*([^{}]+?)\s*}}/g);
        for (const match of placeholderMatches) {
            const token = String(match[1] || '').trim();
            if (!Object.prototype.hasOwnProperty.call(PLACEHOLDERS, placeholderKey(token))) {
                issues.push(createIssue('UNKNOWN_PLACEHOLDER', `Bilinmeyen placeholder: {{${token}}}`, token));
            }
            scrubbed = scrubbed.replace(match[0], '');
        }

        const choiceMatches = source.matchAll(/\{([^{}|]*(?:\|[^{}|]*)+)\}/g);
        for (const match of choiceMatches) {
            const options = match[1].split('|').map(item => item.trim());
            if (options.some(option => option.length === 0)) {
                issues.push(createIssue('EMPTY_CHOICE_OPTION', `Boş varyasyon kullanılamaz: ${match[0]}`, match[0]));
            }
            scrubbed = scrubbed.replace(match[0], '');
        }

        if (scrubbed.includes('{{') || scrubbed.includes('}}')) {
            issues.push(createIssue('MALFORMED_PLACEHOLDER', 'Placeholder biçimi hatalı. Örnek: {{ad}}'));
        }
        if (scrubbed.includes('{') || scrubbed.includes('}')) {
            issues.push(createIssue('MALFORMED_CHOICE', 'Varyasyon biçimi hatalı. Örnek: {Merhaba|Selam}'));
        }

        return {
            valid: issues.length === 0,
            issues
        };
    }

    function chooseOption(options, mode = 'random', randomFn = Math.random) {
        if (mode === 'first') return options[0];
        const index = Math.floor(randomFn() * options.length);
        return options[Math.max(0, Math.min(options.length - 1, index))];
    }

    // Kişide değeri olmayan değişkenler, şablonda yazıldığı haliyle ({{Ad}} → 'Ad').
    function missingPlaceholders(template, contact = {}) {
        const normalizedContact = cleanContact(contact);
        const missing = [];
        for (const match of String(template || '').matchAll(/{{\s*([^{}]+?)\s*}}/g)) {
            const token = String(match[1] || '').trim();
            const renderer = PLACEHOLDERS[placeholderKey(token)];
            if (renderer && !renderer(normalizedContact) && !missing.includes(token)) missing.push(token);
        }
        return missing;
    }

    function placeholderLabel(token) {
        return placeholderKey(token) === 'ad' ? 'Ad' : 'Soyad';
    }

    function contactsMissingPlaceholders(template, contacts = []) {
        if (!Array.isArray(contacts)) return [];

        return contacts.reduce((missingContacts, contact) => {
            const labels = [...new Set(missingPlaceholders(template, contact).map(placeholderLabel))];
            if (labels.length > 0) missingContacts.push({ contact, labels });
            return missingContacts;
        }, []);
    }

    function renderTemplate(template, contact = {}, options = {}) {
        const validation = validateTemplate(template);
        if (!validation.valid) {
            throw new TemplateRenderError('Mesaj şablonu geçersiz', validation.issues);
        }

        const normalizedContact = cleanContact(contact);
        const choiceMode = options.choiceMode || 'random';
        const randomFn = typeof options.randomFn === 'function' ? options.randomFn : Math.random;

        let output = String(template || '');
        // Boş soyad "Sayın Ayşe , ..." gibi çift boşluk bırakmasın diye önündeki boşluğu da alır.
        output = output.replace(/( ?){{\s*([^{}]+?)\s*}}/g, (match, space, token) => {
            const renderer = PLACEHOLDERS[placeholderKey(token)];
            if (!renderer) return match;
            const value = renderer(normalizedContact);
            return value ? space + value : '';
        });
        output = output.replace(/\{([^{}|]*(?:\|[^{}|]*)+)\}/g, (match, body) => {
            const choices = body.split('|').map(item => item.trim());
            return chooseOption(choices, choiceMode, randomFn);
        });

        return {
            text: output.trim(),
            validation
        };
    }

    return {
        TemplateRenderError,
        validateTemplate,
        missingPlaceholders,
        contactsMissingPlaceholders,
        renderTemplate,
        placeholders: Object.keys(PLACEHOLDERS)
    };
});
