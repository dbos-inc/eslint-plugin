import { TypeChecker } from "typescript";
import * as tslintPlugin from "@typescript-eslint/eslint-plugin";
import { ESLintUtils, TSESLint, TSESTree, ParserServicesWithTypeInformation } from "@typescript-eslint/utils";

import {
  createWrappedNode, Node, FunctionDeclaration,
  CallExpression, ConstructorDeclaration, ClassDeclaration,
  MethodDeclaration
} from "ts-morph";

// Should I find TypeScript variants of these?
const secPlugin = require("eslint-plugin-security");
const noSecrets = require("eslint-plugin-no-secrets");

type EslintNode = TSESTree.Node;
type EslintContext = TSESLint.RuleContext<string, unknown[]>;

//////////////////////////////////////////////////////////////////////////////////////////////////// Here is my `ts-morph` linting code:

////////// These are some shared types and values used throughout the code

// TODO: support `FunctionExpression` and `ArrowFunction` too
type FunctionOrMethod = FunctionDeclaration | MethodDeclaration | ConstructorDeclaration;

// This returns `undefined` if there is no error message to emit; otherwise, it returns a key to the `ERROR_MESSAGES` map
type DetChecker = (node: Node, fn: FunctionOrMethod, isLocal: (name: string) => boolean) => string | undefined;

type GlobalTools = {eslintContext: EslintContext, parserServices: ParserServicesWithTypeInformation, typeChecker: TypeChecker};
let GLOBAL_TOOLS: GlobalTools | undefined = undefined;

// These included `Transaction` and `TransactionContext` respectively before!
const DETERMINISTIC_DECORATORS = new Set(["Workflow"]);
const TYPES_YOU_CAN_AWAIT_UPON_IN_DETERERMINISTIC_FUNCTIONS = new Set(["WorkflowContext"]);
const ERROR_MESSAGES = makeErrorMessageSet();

////////// This is the set of error messages that can be emitted

function makeErrorMessageSet(): Map<string, string> {
  const makeDateMessage = (bannedCall: string) => `Calling ${bannedCall} is banned \
(consider using \`@dbos-inc/communicator-datetime\` for consistency and testability)`;

  const bcryptMessage = "Avoid using `bcrypt`, which contains native code. Instead, use `bcryptjs`. \
Also, some `bcrypt` functions generate random data and should only be called from communicators";

  const validTypeSetString = [...TYPES_YOU_CAN_AWAIT_UPON_IN_DETERERMINISTIC_FUNCTIONS].map((name) => `\`${name}\``).join(", ");

  // The keys are the ids, and the values are the messages themselves
  return new Map([
    ["globalModification", "This is a global modification relative to the workflow declaration"],
    ["awaitingOnNotAllowedType", `This function (expected to be deterministic) should not await with a leftmost value of this type (allowed set: \{${validTypeSetString}\})`],
    ["Date", makeDateMessage("`Date()` or `new Date()`")],
    ["Date.now", makeDateMessage("`Date.now()`")],
    ["Math.random", "Avoid calling `Math.random()` directly; it can lead to non-reproducible behavior. See `@dbos-inc/communicator-random`"],
    ["setTimeout", "Avoid calling `setTimeout()` directly; it can lead to undesired behavior when debugging"],
    ["bcrypt.hash", bcryptMessage],
    ["bcrypt.compare", bcryptMessage]
  ]);
}

//////////

/* Typically, awaiting on something in a workflow function is not allowed,
since awaiting usually indicates IO, which may be nondeterministic. The only exception
is awaiting on a call hinging on a `WorkflowContext`, e.g. for some code like this
(where `ctxt` is a `WorkflowContext` object):

`const user = await ctxt.client<User>('users').select("password").where({ username }).first();`

But there's a common pattern of awaiting upon a function that doesn't have a leftmost `ctxt` there,
but rather upon a function where you just pass that context in as a parameter. Some hypothetical code
for that would look like this:

`const user = await getUser(ctxt, username);`

While this seems nondeterministic, it's likely to be deterministic, since the `getUser` function
probably just does the snippet above, but in an abstracted manner (so `getUser` would be a helper function).
So, setting this flag means that determinism warnings will be disabled for awaits in this situation. */
const ignoreAwaitsForCallsWithAContextParam = true;

/*
TODO (Harry's request):
Peter asked me to add a config setting for @StoredProcedure methods to enable them to run locally.
How hard is it to add a linter rule to always warn the user of this config setting is enabled?`
*/

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
function makeTsMorphNode(eslintNode: EslintNode): Node {
  const compilerNode = GLOBAL_TOOLS!.parserServices.esTreeNodeToTSNodeMap.get(eslintNode);
  return createWrappedNode(compilerNode);
}

function makeEslintNode(tsMorphNode: Node): EslintNode {
  const compilerNode = tsMorphNode.compilerNode;
  return GLOBAL_TOOLS!.parserServices.tsNodeToESTreeNodeMap.get(compilerNode);
}

// If the returned name is undefined, then there is no associated type (e.g. a never-defined but used variable)
function getTypeNameForTsMorphNode(tsMorphNode: Node): string | undefined {
  /* We need to use the typechecker to check the type, instead of `expr.getType()`,
  since type information is lost when creating `ts-morph` nodes from TypeScript compiler
  nodes, which in turn come from ESTree nodes (which are the nodes that ESLint uses
  for its AST). */

  return GLOBAL_TOOLS!.typeChecker.getTypeAtLocation(tsMorphNode.compilerNode).getSymbol()?.getName();
}

////////// These functions are the determinism heuristics that I've written

const mutatesGlobalVariable: DetChecker = (node, _fn, isLocal) => {
  if (Node.isExpressionStatement(node)) {
    const subexpr = node.getExpression();

    if (Node.isBinaryExpression(subexpr)) {
      const lhs = reduceNodeToLeftmostLeaf(subexpr.getLeft());

      if (Node.isIdentifier(lhs) && !isLocal(lhs.getText())) {
        return "globalModification";
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
  // All of these function names are also keys in `ERROR_MESSAGES` above
  const bannedFunctionsWithValidArgCounts: Map<string, Set<number>> = new Map([
    ["Date",           new Set([0])],
    ["Date.now",       new Set([0])],
    ["Math.random",    new Set([0])],
    ["setTimeout",     new Set([1, 2])],
    ["bcrypt.hash",    new Set([3])],
    ["bcrypt.compare", new Set([3])]
  ]);

  //////////

  if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
    /* Doing this to make syntax like `Math. random` be reduced to `Math.random`
    (although this might not work for more complicated function call layouts) */
    const expr = node.getExpression();
    const kids = expr.getChildren();
    const text = (kids.length === 0) ? expr.getText() : kids.map((node) => node.getText()).join("");

    const validArgCounts = bannedFunctionsWithValidArgCounts.get(text);

    if (validArgCounts !== undefined) {
      const argCount = node.getArguments().length;

      if (validArgCounts.has(argCount)) {
        return text; // Returning the function name key
      }
    }
  }
}
const awaitsOnNotAllowedType: DetChecker = (node, _fn, _isLocal) => {
  // TODO: match against `.then` as well (with a promise object preceding it)

  ////////// This is a little utility function used below

  // If the valid type set and arg type set intersect, then there's a valid type in the args
  function validTypeExistsInFunctionCallParams(functionCall: CallExpression, validTypes: Set<string>): boolean {
    // I'd like to use `isDisjointFrom` here, but it doesn't seem to be available, for some reason
    const argTypes = functionCall.getArguments().map(getTypeNameForTsMorphNode);
    return argTypes.some((argType) => argType !== undefined && validTypes.has(argType));
  }

  //////////

  if (Node.isAwaitExpression(node)) {
    const functionCall = node.getExpression();
    if (!Node.isCallExpression(functionCall)) return; // Wouldn't make sense otherwise

    let lhs = reduceNodeToLeftmostLeaf(functionCall);

    if (!Node.isIdentifier(lhs) && !Node.isThisExpression(lhs)) { // `this` may have a type too
      if (Node.isLiteralExpression(lhs)) {
        return; // Doesn't make sense to await on literals (that will be reported by something else)
      }
      else { // Throwing an error here, since I want to catch what this could be, and maybe revise the code below
        throw new Error(`Hm, what could this expression be? Examine... (${lhs.getKindName()}, ${lhs.print()})`);
      }
    }

    /* If the typename is undefined, there's no associated typename
    (so possibly a variable is being used that was never defined;
    that error will be handled elsewhere). */
    const typeName = getTypeNameForTsMorphNode(lhs);

    if (typeName === undefined) {
      return;
    }

    const validSet = TYPES_YOU_CAN_AWAIT_UPON_IN_DETERERMINISTIC_FUNCTIONS;
    const awaitingOnAllowedType = validSet.has(typeName);

    if (!awaitingOnAllowedType) {
      /* We should be allowed to await if we call a function that passes
      an allowed type, since that probably means that that function is
      a helper function which is deterministic and uses our allowed type. */
      if (ignoreAwaitsForCallsWithAContextParam && validTypeExistsInFunctionCallParams(functionCall, validSet)) {
       return;
      }

    return "awaitingOnNotAllowedType";
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

  const detCheckers: DetChecker[] = [mutatesGlobalVariable, callsBannedFunction, awaitsOnNotAllowedType];

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
    // Note: parameters are not considered to be locals here (modifying them is not allowed, currently!)
    else if (Node.isVariableDeclaration(node)) {
      locals.add(node.getName());
    }
    else if (functionShouldBeDeterministic(fn)) {

      detCheckers.forEach((detChecker) => {
        const messageKey = detChecker(node, fn, isLocal);

        if (messageKey !== undefined) {
          const correspondingEslintNode = makeEslintNode!(node);
          GLOBAL_TOOLS!.eslintContext.report({ node: correspondingEslintNode, messageId: messageKey });
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

function analyzeRootNodeForDeterminism(eslintNode: EslintNode, eslintContext: EslintContext) {
  const parserServices = ESLintUtils.getParserServices(eslintContext);

  GLOBAL_TOOLS = {
    eslintContext: eslintContext,
    parserServices: parserServices,
    typeChecker: parserServices.program.getTypeChecker()
  };

  const tsMorphNode = makeTsMorphNode(eslintNode);

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
    // Not keeping the tools around after failure
    GLOBAL_TOOLS = undefined;
  }
}

/* Take a look at these functions later on:
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
    "@dbos-inc/detect-nondeterministic-calls": "error"
  },

  extends: []
};

const recConfig = {
  ...baseConfig,

  extends: [
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

  extends: [...recConfig.extends],

  rules: {
    ...recConfig.rules,
    "@typescript-eslint/no-shadow": "error"
  },
};

module.exports = {
  meta: {
    name: "@dbos-inc/eslint-plugin",
    version: "1.0.0"
  },

  rules: {
    "detect-nondeterministic-calls": {
      meta: {
        type: "suggestion",
        docs: { description: "Detect nondeterminism in cases where functions should act deterministically" },
        messages: Object.fromEntries(ERROR_MESSAGES)
      },

      create: (context: EslintContext) => {
        return {
          /* Note: I am working with ts-morph because it has
          stronger typing, and it's easier to work with the AST
          than ESTree's limited tree navigation. */
          Program(node: EslintNode) {
            analyzeRootNodeForDeterminism(node, context);
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

export const dbosRulesPerName: any = module.exports.rules;
