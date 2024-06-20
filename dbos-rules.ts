import { TypeChecker } from "typescript";
import * as tslintPlugin from "@typescript-eslint/eslint-plugin";
import { ESLintUtils, ParserServicesWithTypeInformation } from "@typescript-eslint/utils";

import {
  createWrappedNode, Node, FunctionDeclaration,
  ConstructorDeclaration, ClassDeclaration, MethodDeclaration
} from "ts-morph";

const secPlugin = require("eslint-plugin-security");
const noSecrets = require("eslint-plugin-no-secrets");

//////////////////////////////////////////////////////////////////////////////////////////////////// Here is my `ts-morph` linting code:

////////// These are some shared types and values used throughout the code

// TODO: support `FunctionExpression` and `ArrowFunction` too
type FunctionOrMethod = FunctionDeclaration | MethodDeclaration | ConstructorDeclaration;

// This returns `undefined` if there is no error message to emit
type DetChecker = (node: Node, fn: FunctionOrMethod, isLocal: (name: string) => boolean) => string | undefined;

// TODO: stop this globalness (make some class, perhaps, and include some methods with these as internal fields?)
let globalEslintContext: any | undefined = undefined;
let globalParserServices: ParserServicesWithTypeInformation | undefined = undefined;
let globalTypeChecker: TypeChecker | undefined = undefined;

// These included `Transaction` and `TransactionContext` respectively before!
const DETERMINISTIC_DECORATORS = new Set(["Workflow"]);
const TYPES_YOU_CAN_AWAIT_UPON_IN_DETERERMINISTIC_FUNCTIONS = new Set(["WorkflowContext"]);

////////// These are some utility functions

// This reduces `f.x.y.z` or `f.y().z.w()` into `f` (the leftmost child). This term need not be an identifier.
function reduceNodeToLeftmostLeaf(node: Node): Node {
 while (true) {
    let value = node.getFirstChild();

    if (value === undefined) {
      return node;
    }

    node = value;
  }
}

function evaluateClassForDeterminism(theClass: ClassDeclaration) {
  theClass.getConstructors().forEach(evaluateFunctionForDeterminism);
  theClass.getMethods().forEach(evaluateFunctionForDeterminism);
}

function functionShouldBeDeterministic(fnDecl: FunctionOrMethod): boolean {
  return fnDecl.getModifiers().some((modifier) =>
    Node.isDecorator(modifier) && DETERMINISTIC_DECORATORS.has(modifier.getName())
  );
}

// Bijectivity is preseved for TSMorph <-> TSC <-> ESTree, as far as I can tell!
function makeTsMorphNode(eslintNode: any): Node {
  const compilerNode = globalParserServices!.esTreeNodeToTSNodeMap.get(eslintNode);

  const options = { // TODO: should I pass some compiler options in too, and if so, how?
    compilerOptions: undefined, sourceFile: compilerNode.getSourceFile(), typeChecker: globalTypeChecker
  };

  return createWrappedNode(compilerNode, options);
}

function makeEslintNode(tsMorphNode: Node): any {
  const compilerNode = tsMorphNode.compilerNode;
  return globalParserServices!.tsNodeToESTreeNodeMap.get(compilerNode);
}

// If the returned name is undefined, then there is no associated type (e.g. a never-defined but used variable)
function getTypeNameForTsMorphNode(tsMorphNode: Node): string | undefined {
  /* We need to use the typechecker to check the type, instead of `expr.getType()`,
  since type information is lost when creating `ts-morph` nodes from Typescript compiler
  nodes, which in turn come from ESTree nodes (which are the nodes that ESLint uses
  for its AST). */

  const type = globalTypeChecker!.getTypeAtLocation(tsMorphNode.compilerNode);
  return type.getSymbol()?.getName();
}

////////// These functions are the determinism heuristics that I've written

const mutatesGlobalVariable: DetChecker = (node, _fn, isLocal) => {
  if (Node.isExpressionStatement(node)) {
    const subexpr = node.getExpression();

    if (Node.isBinaryExpression(subexpr)) {
      const lhs = reduceNodeToLeftmostLeaf(subexpr.getLeft());

      if (Node.isIdentifier(lhs) && !isLocal(lhs.getText())) {
        return "This is a global modification relative to the workflow/transaction declaration.";
      }

      /* TODO: warn about these types of assignment too: `[a, b] = [b, a]`, and `b = [a, a = b][0]`.
      Could I solve that by checking for equals signs, and then a variable, or array with variables in it,
      on the lefthand side? */
    }
  }
}

/* TODO: should I ban IO functions, like `fetch`, `console.log`,
and mutating global arrays via functions like `push`, etc.? */
const callsBannedFunction: DetChecker = (node, _fn, _isLocal) => {
  const makeDateMessage = (variantEnd: string) => `Calling \`Date${variantEnd}()\` is banned (consider using \`@dbos-inc/communicator-datetime\` for consistency and testability)`;

  const bcryptMessage = "Avoid using `bcrypt`, which contains native code. Instead, use `bcryptjs`. \
Also, some `bcrypt` functions generate random data and should only be called from communicators"

  const bannedFunctionsWithValidArgCountsAndMessages: Map<string, [Set<number>, string]> = new Map([
    ["Date",           [new Set([0]),    makeDateMessage("")]], // This covers `new Date()` as well
    ["Date.now",       [new Set([0]),    makeDateMessage(".now")]],
    ["Math.random",    [new Set([0]),    "Avoid calling Math.random() directly; it can lead to non-reproducible behavior. See `@dbos-inc/communicator-random`"]],
    ["setTimeout",     [new Set([1, 2]), "Avoid calling `setTimeout()` directly; it can lead to undesired behavior when debugging"]],
    ["bcrypt.hash",    [new Set([3]),    bcryptMessage]],
    ["bcrypt.compare", [new Set([3]),    bcryptMessage]]
  ]);

  //////////

  if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
    const text = node.getExpression().getText(); // TODO: make this work for cases like `Math. random()`!
    const validArgCountsAndMessage = bannedFunctionsWithValidArgCountsAndMessages.get(text);

    if (validArgCountsAndMessage !== undefined) {
      const [validArgCounts, customMessage] = validArgCountsAndMessage;
      const argCount = node.getArguments().length;

      if (validArgCounts.has(argCount)) {
        return customMessage;
      }
    }
  }
}

const awaitsOnAllowedType: DetChecker = (node, _fn, _isLocal) => {
  // TODO: match against `.then` as well (with a promise object preceding it)
  if (Node.isAwaitExpression(node)) {
    let expr = reduceNodeToLeftmostLeaf(node.getExpression());

    // In this case, we are awaiting on a literal value, which doesn't make a ton of sense
    if (!Node.isIdentifier(expr)) {
      if (Node.isLiteralExpression(expr)) {
        return; // Don't check literals (that's invalid code, and that will be handled by something else)
      }
      else if (!Node.isThisExpression(expr)) { // Don't fail on `this` (since it may have a type too)
        throw new Error(`Hm, what could this expression be? (${expr.getKindName()}, ${expr.print()})`);
      }
    }

    /* If the typename is undefined, there's no associated typename (so possibly a
    variable is being used that was never defined; that error will be handled elsewhere). */
    const typeName = getTypeNameForTsMorphNode(expr);
    if (typeName === undefined) return;

    const validSet = TYPES_YOU_CAN_AWAIT_UPON_IN_DETERERMINISTIC_FUNCTIONS;

    if (!validSet.has(typeName)) {
      const allowedAsString = [...validSet].map((name) => `\`${name}\``).join(", ");
      return `This function should not await with a leftmost value of type \`${typeName}\` (name = \`${expr.print()}\`, allowed types = {${allowedAsString}})`;
    }
  }
}

////////// This is the main function that recurs on the `ts-morph` AST

function evaluateFunctionForDeterminism(fn: FunctionOrMethod) {
  const body = fn.getBody();

  if (body === undefined) {
    throw new Error("When would a function not have a body?");
  }

  const stack: Set<string>[] = [new Set()];
  const getCurrentFrame = () => stack[stack.length - 1];
  const pushFrame = () => stack.push(new Set());
  const popFrame = () => stack.pop();
  const isLocal = (name: string) => stack.some((frame) => frame.has(name));

  const detCheckers: DetChecker[] = [mutatesGlobalVariable, callsBannedFunction, awaitsOnAllowedType];

  function checkNodeForGlobalVarUsage(node: Node) {
    const locals = getCurrentFrame();

    if (Node.isClassDeclaration(node)) {
      evaluateClassForDeterminism(node);
      return;
    }
    else if (Node.isFunctionDeclaration(node)) { // || Node.isArrowFunction(node)) {
      /* Not checking if this function should be deterministic
      strictly, since it might have nondeterministic subfunctions */
      evaluateFunctionForDeterminism(node);
      return;
    }
    else if (Node.isBlock(node)) {
      pushFrame();
      node.forEachChild(checkNodeForGlobalVarUsage);
      popFrame();
      return;
    }
    else if (Node.isVariableDeclaration(node)) {
      locals.add(node.getName());
    }
    else if (functionShouldBeDeterministic(fn)) {

      detCheckers.forEach((detChecker) => {
        const maybe_error_string = detChecker(node, fn, isLocal);

        if (maybe_error_string !== undefined) {
          const correspondingEslintNode = makeEslintNode!(node);
          globalEslintContext.report({node: correspondingEslintNode, message: maybe_error_string});
        }
      });

      // console.log(`Not accounted for (det function, ${node.getKindName()})... (${node.print()})`);
    }
    else {
      // console.log("Not accounted for (nondet function)...");
    }

    node.forEachChild(checkNodeForGlobalVarUsage);
  }

  body.forEachChild(checkNodeForGlobalVarUsage);
}

////////// This is the entrypoint for running the determinism analysis with `ts-morph`

export function analyzeEstreeNodeForDeterminism(estreeNode: any, eslintContextParam: any) {
  // TODO: should I really do this global setting? It's pretty nasty...
  globalEslintContext = eslintContextParam;
  globalParserServices = ESLintUtils.getParserServices(globalEslintContext);
  globalTypeChecker = globalParserServices.program.getTypeChecker();

  const tsMorphNode = makeTsMorphNode(estreeNode);

  try {
    if (Node.isSourceFile(tsMorphNode)) {
      tsMorphNode.getFunctions().forEach(evaluateFunctionForDeterminism);
      tsMorphNode.getClasses().forEach(evaluateClassForDeterminism);
    }
    else {
      throw new Error("Was expecting a source file to be passed to `analyzeSourceNodeForDeterminism`!");
    }
  }
  finally {
    // Not keeping these globals around after failure
    globalEslintContext = undefined;
    globalParserServices = undefined;
    globalTypeChecker = undefined;
  }
}

/* Other TODO:
- Take a look at these functions:
isArrowFunction, isFunctionExpression, isObjectBindingPattern, isPropertyAssignment, isQualifiedName
- Check function expressions and arrow functions for mutation (and interfaces?)
- Check for recursive global mutation for expected-to-be-deterministic functions
*/

//////////////////////////////////////////////////////////////////////////////////////////////////// Here is the ESLint plugin code (mostly boilerplate):

const baseConfig = {
  plugins: [
    "@typescript-eslint",
    "security",
    "no-secrets"
  ],

  env: { "node" : true },

  rules: {
    "no-eval": "error",
    "@typescript-eslint/no-implied-eval": "error",
    "no-console": "error",
    "security/detect-unsafe-regex": "error",
    "no-secrets/no-secrets": "error",
    "@dbos-inc/unexpected-nondeterminism": "error"
  },

  "extends": []
};

const recConfig = {
  ...baseConfig,

  "extends": [
    ...baseConfig.extends,
    "plugin:@typescript-eslint/recommended-requiring-type-checking",
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended"
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
    "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }]
  }
};

const extConfig = {
  ...recConfig,

  "extends" : [...recConfig.extends],

  rules: {
    ...recConfig.rules,
    "@typescript-eslint/no-shadow": "error"
  },
};

module.exports = {
  meta: {
    "name": "@dbos-inc/eslint-plugin",
    "version": "0.0.7",
  },

  rules: {
    "unexpected-nondeterminism": {
      meta: {
        type: "suggestion",
        docs: { description: "Detect nondeterminism in cases where functions should act deterministically" },
        schema: []
      },

      create: function (context: any) {
        return {
          /* Note: I am working with ts-morph because it has
          stronger typing, and it's easier to work with the AST
          than ESTree's limited tree navigation. */
          Program(node: any) {
            analyzeEstreeNodeForDeterminism(node, context);
          }
        }
      }
    }
  },

  plugins: {
    "@typescript-eslint": tslintPlugin,
    "security": secPlugin,
    "no-secrets": noSecrets
  },

  configs: {
    dbosBaseConfig: baseConfig,
    dbosRecommendedConfig: recConfig,
    dbosExtendedConfig: extConfig
  }
};
