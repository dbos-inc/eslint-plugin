const tslintPlugin = require("@typescript-eslint/eslint-plugin");
const secPlugin = require("eslint-plugin-security");
const noSecrets = require("eslint-plugin-no-secrets");

const baseConfig =
{
  plugins: [
    "@typescript-eslint",
    "security",
    "no-secrets",
  ],
  env: {
    "node" : true
  },
  rules: {
    "no-eval": "error",
    "@typescript-eslint/no-implied-eval": "error",
    "no-console": "error",
    "security/detect-unsafe-regex": "error",
    "no-secrets/no-secrets": "error",
    "@dbos-inc/detect-nondeterministic-calls": "error",
    "@dbos-inc/detect-new-date": "error",
    "@dbos-inc/detect-native-code": "error",
  },
  "extends": [
  ],
};

const recConfig =
{
  ...baseConfig,
  "extends" : [
    ...baseConfig.extends,
    "plugin:@typescript-eslint/recommended-requiring-type-checking",
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  rules: {
    ...baseConfig.rules,
    "@typescript-eslint/no-unnecessary-type-assertion": "off",
    "semi": ["error"],
    "no-empty": "off",
    "no-constant-condition": "off",
    "@typescript-eslint/no-misused-promises": "error",
    "@typescript-eslint/no-floating-promises": "error",
    "eqeqeq": ["error", "always"],
    "@typescript-eslint/no-for-in-array": "error",

    "@typescript-eslint/no-unused-vars": [
      "error",
      { "argsIgnorePattern": "^_",
        "varsIgnorePattern": "^_" }
    ],
  },
}

const extConfig =
{
  ...recConfig,
  "extends" : [
    ...recConfig.extends,
  ],
  rules: {
    ...recConfig.rules,
    "@typescript-eslint/no-shadow": "error",
  },
}


module.exports = {
  meta: {
    "name": "@dbos-inc/eslint-plugin",
    "version": "0.0.6",
  },
  rules: {
    'detect-native-code': {
      // Rule configuration for detection of libraries based on native code
      meta: {
        type: 'suggestion',
        docs: {
          description: 'Detect calls to libraries with native functions like bcrypt, which should be replaced with native JS',
        },
        schema: [],
      },
      create: function (context) {
        return {
          CallExpression(node) {
            //console.log(node.callee.type+JSON.stringify(node));
            if (node.callee.type === 'MemberExpression' &&
                node.callee.object.name === 'bcrypt' &&
                (node.callee.property.name === 'compare' || node.callee.property.name === 'hash'))
	    {
              context.report({
                node: node,
                message: "Avoid using the 'bcrypt' library, which contains native code.  Instead, use 'bcryptjs'.  Also, note that some bcrypt functions generate random data and should only be called from DBOS communicators, such as `@dbos-inc/communicator-bcrypt`.",
              });
            }
          },
        };
      },
    },
    'detect-nondeterministic-calls': {
      // Rule configuration for Math.random() detection
      meta: {
        type: 'suggestion',
        docs: {
          description: 'Detect calls to nondeterministic functions like Math.random(), which should be called via DBOS rather than directly',
        },
        schema: [],
      },
      create: function (context) {
        return {
          CallExpression(node) {
            //console.log(node.callee.type+JSON.stringify(node));
            if (node.callee.type === 'MemberExpression' &&
                node.callee.object.name === 'Math' &&
                node.callee.property.name === 'random')
	    {
              context.report({
                node: node,
                message: 'Avoid calling Math.random() directly; it can lead to non-reproducible behavior.  See `@dbos-inc/communicator-random`'
              });
            }
            if (node.callee.type === 'Identifier' &&
                node.callee.name === 'setTimeout')
            {
              context.report({
                node: node,
                message: 'Avoid calling setTimeout() directly; it can lead to undesired behavior when debugging.',
              });
            }
          },
        };
      },
    },
    'detect-new-date': {
      // Rule configuration for new Date() detection
      meta: {
        type: 'suggestion',
        docs: {
          description: 'Detect calls to new Date(), which should be called via DBOS rather than directly',
        },
        schema: [],
      },
      create: function (context) {
        return {
          NewExpression(node) {
            if (node.callee.name === 'Date') {
              context.report({
                node: node,
                message: 'Avoid using new Date(); consider using the DBOS SDK functions or `@dbos-inc/communicator-datetime` for consistency and testability.',
              });
            }
          },
        };
      },
    },
  },
  plugins: {
    "@typescript-eslint" : tslintPlugin,
    "security" : secPlugin,
    "no-secrets" : noSecrets,
  },
  configs: {
    dbosBaseConfig: baseConfig,
    dbosRecommendedConfig: recConfig,
    dbosExtendedConfig: extConfig,
  }
};

