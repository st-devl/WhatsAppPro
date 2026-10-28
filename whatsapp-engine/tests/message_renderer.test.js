const test = require('node:test');
const assert = require('node:assert/strict');

const {
    TemplateRenderError,
    renderTemplate,
    validateTemplate
} = require('../shared/message_renderer');

test('renders supported placeholders and first preview choice', () => {
    const result = renderTemplate('Merhaba {{ad}} {{soyadi}}, {nasilsiniz|iyi gunler}', {
        name: 'Ayse',
        surname: 'Demir'
    }, { choiceMode: 'first' });

    assert.equal(result.text, 'Merhaba Ayse Demir, nasilsiniz');
});

test('renders deterministic random choice when random function is injected', () => {
    const result = renderTemplate('{A|B|C}', {}, {
        choiceMode: 'random',
        randomFn: () => 0.7
    });

    assert.equal(result.text, 'C');
});

test('rejects unknown placeholders', () => {
    const validation = validateTemplate('Merhaba {{telefon}}');
    assert.equal(validation.valid, false);
    assert.equal(validation.issues[0].code, 'UNKNOWN_PLACEHOLDER');

    assert.throws(
        () => renderTemplate('Merhaba {{telefon}}'),
        err => err instanceof TemplateRenderError && err.code === 'TEMPLATE_SYNTAX_INVALID'
    );
});

test('rejects malformed choice syntax', () => {
    const validation = validateTemplate('Merhaba {A|}');
    assert.equal(validation.valid, false);
    assert.equal(validation.issues[0].code, 'EMPTY_CHOICE_OPTION');
});

test('accepts {{soyad}} and placeholder names regardless of case', () => {
    const contact = { name: 'Ahmet', surname: 'Yılmaz' };
    for (const template of ['Sayın {{ad}} {{soyad}}', 'Sayın {{Ad}} {{SOYADI}}', 'Sayın {{ ad }} {{soyadı}}']) {
        assert.equal(validateTemplate(template).valid, true, template);
        assert.equal(renderTemplate(template, contact).text, 'Sayın Ahmet Yılmaz', template);
    }
});

test('drops the space before an empty surname', () => {
    const result = renderTemplate('Sayın {{ad}} {{soyad}}, {Merhaba|Selam}!', { name: 'Ayşe', surname: '' }, { choiceMode: 'first' });
    assert.equal(result.text, 'Sayın Ayşe, Merhaba!');
});

test('renders nothing for a missing or unknown name', () => {
    assert.equal(renderTemplate('Sayın {{ad}} {{soyad}}, Merhaba!', {}).text, 'Sayın, Merhaba!');
    assert.equal(renderTemplate('Sayın {{ad}}', { name: 'Bilinmeyen' }).text, 'Sayın');
});
