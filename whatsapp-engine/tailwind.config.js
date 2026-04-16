const forms = require('@tailwindcss/forms');
const containerQueries = require('@tailwindcss/container-queries');
const tokens = require('./design-tokens.json');

module.exports = {
    content: [
        './public/**/*.html',
        './public/**/*.js'
    ],
    darkMode: 'class',
    theme: {
        extend: {
            colors: tokens.colors,
            borderRadius: tokens.borderRadius,
            fontFamily: tokens.fontFamily
        }
    },
    plugins: [
        forms,
        containerQueries
    ]
};
