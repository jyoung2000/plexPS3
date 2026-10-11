// ESLint flat config: the plugin must stay strict ES5 because Movian embeds
// Duktape 1.5 (upstream) / 1.8 (M7 7.0.273). See docs/movian-api.md.
'use strict';

module.exports = [
  {
    files: ['plugin/**/*.js'],
    languageOptions: {
      ecmaVersion: 5,
      sourceType: 'script',
      globals: {
        // Movian globals (src/ecmascript/ecmascript.c)
        Plugin: 'readonly',
        Core: 'readonly',
        Duktape: 'readonly',
        require: 'readonly',
        exports: 'writable',
        module: 'writable',
        console: 'readonly',
        print: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        JSON: 'readonly',
        Math: 'readonly',
        Date: 'readonly',
        encodeURIComponent: 'readonly',
        decodeURIComponent: 'readonly',
        parseInt: 'readonly',
        parseFloat: 'readonly',
        isNaN: 'readonly',
        String: 'readonly',
        Number: 'readonly',
        Object: 'readonly',
        Array: 'readonly',
        Error: 'readonly',
        RegExp: 'readonly',
        isFinite: 'readonly'
      }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: 'ArrowFunctionExpression', message: 'ES5 only (Duktape)' },
        { selector: 'TemplateLiteral', message: 'ES5 only (Duktape)' },
        { selector: 'ClassDeclaration', message: 'ES5 only (Duktape)' },
        { selector: 'ForOfStatement', message: 'ES5 only (Duktape)' },
        { selector: 'VariableDeclaration[kind!="var"]', message: 'ES5 only (Duktape): use var' },
        { selector: 'SpreadElement', message: 'ES5 only (Duktape)' },
        { selector: 'RestElement', message: 'ES5 only (Duktape)' },
        { selector: 'ObjectPattern', message: 'ES5 only (Duktape)' },
        { selector: 'ArrayPattern', message: 'ES5 only (Duktape)' },
        { selector: 'AssignmentPattern', message: 'ES5 only (Duktape)' },
        { selector: 'Property[shorthand=true]', message: 'ES5 only (Duktape)' },
        { selector: 'Property[method=true]', message: 'ES5 only (Duktape)' },
        { selector: 'CallExpression[callee.property.name=/^(includes|startsWith|endsWith|find|findIndex|padStart|padEnd|assign|from|of|entries|values|repeat|trimStart|trimEnd|flat|flatMap)$/]', message: 'Not available in Duktape 1.x; use an ES5 equivalent from lib/util.js' }
      ]
    }
  }
];
