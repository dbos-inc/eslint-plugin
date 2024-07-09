import * as tslintPlugin from "@typescript-eslint/eslint-plugin";
import { ESLintUtils, TSESLint, TSESTree, ParserServicesWithTypeInformation } from "@typescript-eslint/utils";

import {
  ts, createWrappedNode, Node, FunctionDeclaration,
  CallExpression, ConstructorDeclaration, ClassDeclaration,
  MethodDeclaration, SyntaxKind, Project, Expression,
  VariableDeclaration, Identifier
} from "ts-morph";

// Should I find TypeScript variants of these?
const secPlugin = require("eslint-plugin-security");
const noSecrets = require("eslint-plugin-no-secrets");

type EslintNode = TSESTree.Node;
type EslintContext = TSESLint.RuleContext<string, unknown[]>;

/*
Note for upgrading `ts-morph` and `typescript` in `package.json`:
1. Make sure that the supported TypeScript version for `ts-morph` is the one installed here.
2. Make sure that the installed TypeScript version works with `dbos-demo-apps` (TypeScript 5.5 + ts-morph 23.0 caused some breakage there).
*/

//////////////////////////////////////////////////////////////////////////////////////////////////// Here is my `ts-morph` linting code:

////////// These are some shared types and values used throughout the code

// TODO: support `FunctionExpression` and `ArrowFunction` too
type FunctionOrMethod = FunctionDeclaration | MethodDeclaration | ConstructorDeclaration;

// This returns the initializer for a local variable if it exists
type LocalGetter = (name: string) => Expression | undefined;

// This returns `undefined` if there is no error message to emit; otherwise, it returns a key to the `ERROR_MESSAGES` map
type ErrorChecker = (node: Node, fn: FunctionOrMethod, getLocal: LocalGetter) => string | undefined;

type GlobalTools = {eslintContext: EslintContext, parserServices: ParserServicesWithTypeInformation, typeChecker: ts.TypeChecker};
let GLOBAL_TOOLS: GlobalTools | undefined = undefined;

// These included `Transaction` and `TransactionContext` respectively before!
const deterministicDecorators = new Set(["Workflow"]);
const awaitableTypes = new Set(["WorkflowContext"]); // Awaitable in deterministic functions, to be specific
const errorMessages = makeErrorMessageSet();
const checkSqlInjectionDecorators = new Set(["Transaction"]);
const validOrmClientNames = new Set(["PoolClient", "PrismaClient", "TypeORMEntityManager", "Knex"]);

////////// This is the set of error messages that can be emitted

function makeErrorMessageSet(): Map<string, string> {
  const makeDateMessage = (bannedCall: string) => `Calling ${bannedCall} is banned \
(consider using \`@dbos-inc/communicator-datetime\` for consistency and testability)`;

  // TODO: update this message if more types are added in the future to `deterministicDecorators` or `awaitableTypes`
  const awaitMessage = `The enclosing workflow makes an asynchronous call to a non-DBOS function. \
Please verify that this call is deterministic or it may lead to non-reproducible behavior`;

  const bcryptMessage = "Avoid using `bcrypt`, which contains native code. Instead, use `bcryptjs`. \
Also, some `bcrypt` functions generate random data and should only be called from communicators";

  // The keys are the ids, and the values are the messages themselves
  return new Map([
    ["sqlInjection", "Possible SQL injection detected! Use prepared statements instead"],
    ["globalModification", "Deterministic DBOS operations (e.g. workflow code) should not mutate global variables; it can lead to non-reproducible behavior"],
    ["awaitingOnNotAllowedType", awaitMessage],
    ["Date", makeDateMessage("`Date()` or `new Date()`")],
    ["Date.now", makeDateMessage("`Date.now()`")],
    ["Math.random", "Avoid calling `Math.random()` directly; it can lead to non-reproducible behavior. See `@dbos-inc/communicator-random`"],
    ["console.log", "Avoid calling `console.log` directly; the DBOS logger, `ctxt.logger.info`, is recommended."],
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
    if (value === undefined) return node;
    node = value;
  }
}

function analyzeClass(theClass: ClassDeclaration) {
  theClass.getConstructors().forEach(analyzeFunction);
  theClass.getMethods().forEach(analyzeFunction);
}

function functionHasDecoratorInSet(fnDecl: FunctionOrMethod, decoratorSet: Set<string>): boolean {
  return fnDecl.getModifiers().some((modifier) =>
    Node.isDecorator(modifier) && decoratorSet.has(modifier.getName())
  );
}

////////// These functions are the determinism heuristics that I've written

// TODO: use this in more places
function getIdentifierIfVariableModification(node: Node): Identifier | undefined {
  if (Node.isExpressionStatement(node)) {
    const subexpr = node.getExpression();

    if (Node.isBinaryExpression(subexpr)) {
      const lhs = reduceNodeToLeftmostLeaf(subexpr.getLeft());
      if (Node.isIdentifier(lhs)) return lhs;

      /* TODO: catch these types of assignment too: `[a, b] = [b, a]`, and `b = [a, a = b][0]`.
      Could I solve that by checking for equals signs, and then a variable, or array with variables in it,
      on the lefthand side? */
    }
  }
}

const mutatesGlobalVariable: ErrorChecker = (node, _fn, getLocal) => {
  const maybeIdentifier = getIdentifierIfVariableModification(node);

  if (maybeIdentifier !== undefined && getLocal(maybeIdentifier.getText()) === undefined) {
    return "globalModification";
  }
}

/* TODO: should I ban more IO functions, like `fetch`,
and mutating global arrays via functions like `push`, etc.? */
const callsBannedFunction: ErrorChecker = (node, _fn, _getLocal) => {
  // All of these function names are also keys in `ERROR_MESSAGES` above

  const AS_MANY_ARGS_AS_YOU_WANT = 99999;
  type ArgCountRange = {min: number, max: number}; // This range is inclusive

  const bannedFunctionsWithArgCountRanges: Map<string, ArgCountRange> = new Map([
    ["Date",           {min: 0, max: 0}],
    ["Date.now",       {min: 0, max: 0}],
    ["Math.random",    {min: 0, max: 0}],
    ["console.log",    {min: 0, max: AS_MANY_ARGS_AS_YOU_WANT}],
    ["setTimeout",     {min: 1, max: AS_MANY_ARGS_AS_YOU_WANT}],
    ["bcrypt.hash",    {min: 3, max: 3}],
    ["bcrypt.compare", {min: 3, max: 3}]
  ]);

  //////////

  if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
    /* Doing this to make syntax like `Math. random` be reduced to `Math.random`
    (although this might not work for more complicated function call layouts) */
    const expr = node.getExpression();
    const kids = expr.getChildren();
    const text = (kids.length === 0) ? expr.getText() : kids.map((node) => node.getText()).join("");

    const argCountRange = bannedFunctionsWithArgCountRanges.get(text);

    if (argCountRange !== undefined) {
      const argCount = node.getArguments().length;

      if (argCount >= argCountRange.min && argCount <= argCountRange.max) {
        return text; // Returning the function name key
      }
    }
  }
}

const awaitsOnNotAllowedType: ErrorChecker = (node, _fn, _getLocal) => {
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

      // Doesn't make sense to await on literals (that will be reported by something else)
      if (Node.isLiteralExpression(lhs)) return;

      // Throwing an error here, since I want to catch what this could be, and maybe revise the code below
      else throw new Error(`Hm, what could this expression be? Examine... (${lhs.getKindName()}, ${lhs.print()})`);
    }

    /* If the typename is undefined, there's no associated typename
    (so possibly a variable is being used that was never defined;
    that error will be handled elsewhere). TODO: figure out what's
    happening when the Typescript compiler can't get type info out
    of the LHS (that happens in some very rare cases). */
    const typeName = getTypeNameForTsMorphNode(lhs);
    if (typeName === undefined) return;

    const awaitingOnAllowedType = awaitableTypes.has(typeName);

    if (!awaitingOnAllowedType) {
      /* We should be allowed to await if we call a function that passes
      an allowed type, since that probably means that that function is
      a helper function which is deterministic and uses our allowed type. */
      if (ignoreAwaitsForCallsWithAContextParam && validTypeExistsInFunctionCallParams(functionCall, awaitableTypes)) {
        return;
      }

      return "awaitingOnNotAllowedType";
    }
  }
}

////////// This code is for detecting SQL injections

/*
for `ctxt.client.raw(x)`,
- `clientName` is the type of `client`
- `callName` is `raw`
- `sqlParamIndex` is the index of the SQL string to check
- `identifiers` is `[ctxt, client, raw]`
- `typeNames` is the types of the identifiers
- `callArgs` is the arg nodes (here, just `x`)
*/
function checkCallForInjection(callName: string, sqlParamIndex: number,
  identifiers: Node[], callArgs: Node[], getLocal: LocalGetter) {

  // `ctxt.client.<callName>`
  if (identifiers[2].getText() !== callName) return;

  let param = callArgs[sqlParamIndex];

  // In this case, trace it to its initializer (TODO: find other sets of the parameter)
  if (Node.isIdentifier(param)) {
    const localValue = getLocal(param.getText());

    /* TODO: figure out how to trace every setting of the variable
    (so trace through the function body for usages, and then check for a parent equals -
    use that for the global var checking too).  Make a function called `variableIsBeingModified`,
    and then use that for the global variable detector, and use it here too in an each-descendant case
    (and then stop using `getLocal` here; so undo it).

    Or, figure out how to use the reference-getting function (from creating a `Project` object). */
    if (localValue === undefined) {
      throw new Error("Do more elaborate tracing to find the definition!");
    }

    // TODO: use `getIdentifierIfVariableModification` over the function body (or figure out how to use the builtin helper function for this)

    param = localValue;
  }

  if (!Node.isStringLiteral(param)) {
    return "sqlInjection";
  }
}

const isSqlInjection: ErrorChecker = (node, _fn, getLocal) => {
  if (Node.isCallExpression(node)) {
    const subexpr = node.getExpression();
    const identifiers = subexpr.getDescendantsOfKind(SyntaxKind.Identifier);

    // An injection in DBOS must match `ctxt.client.<something>`
    if (identifiers.length !== 3) return;

    const callArgs = node.getArguments();
    const identifierTypeNames = identifiers.map(getTypeNameForTsMorphNode);

    const maybeOrmClientName = identifierTypeNames[1];

    // In this case, not a valid DBOS SQL query
    if (identifierTypeNames[0] !== "TransactionContext" || maybeOrmClientName === undefined || !validOrmClientNames.has(maybeOrmClientName)) {
      return;
    }

    if (maybeOrmClientName === "Knex") {
      const error = checkCallForInjection("raw", 0, identifiers, callArgs, getLocal);
      if (error !== undefined) return error;
    }
    else {
      throw new Error(`${maybeOrmClientName} not implemented yet`);
    }
  }
}

////////// This is the main function that recurs on the `ts-morph` AST

// At the moment, this only performs analysis on expected-to-be-deterministic functions
function analyzeFunction(fn: FunctionOrMethod) {
  const body = fn.getBody();
  if (body === undefined) throw new Error("When would a function not have a body?");

  /* Note that each stack is local to each function,
  so it's reset when a new function is entered
  (anything not on the stack would be outside the function).

  Also note that no exceptions should be caught in `analyzeFrame`,
  since this might result in the stack ending up in a bad state (allowing
  any exceptions to exit outside `analyzeFunction` would lead
  to the stack getting reset if `analyzeFunction` is called again). */

  // This maps locals to their initializers
  const stack: Map<string, Expression | undefined>[] = [new Map()];
  const getCurrentFrame = () => stack[stack.length - 1];
  const pushFrame = () => stack.push(new Map());
  const popFrame = () => stack.pop();

  // TODO: do this more idiomatically
  const getLocal: LocalGetter = (name: string) => {
    for (const frame of stack) {
      const initialValue = frame.get(name);
      if (initialValue !== undefined) return initialValue;
    }
  }

  const detCheckers: ErrorChecker[] = [mutatesGlobalVariable, callsBannedFunction, awaitsOnNotAllowedType];

  function runErrorChecker(errorChecker: ErrorChecker, node: Node) {
    const messageKey = errorChecker(node, fn, getLocal);

    if (messageKey !== undefined) {
      const correspondingEslintNode = makeEslintNode!(node);
      GLOBAL_TOOLS!.eslintContext.report({ node: correspondingEslintNode, messageId: messageKey });
    }
  }

  function analyzeFrame(node: Node) {
    const locals = getCurrentFrame();

    if (Node.isClassDeclaration(node)) {
      analyzeClass(node);
      return;
    }
    else if (Node.isFunctionDeclaration(node)) { // || Node.isArrowFunction(node)) {
      /* Not checking if this function should be deterministic
      strictly, since it might have nondeterministic subfunctions.
      This also creates a new stack indirectly. */
      analyzeFunction(node);
      return;
    }
    else if (Node.isBlock(node)) {
      pushFrame();
      node.forEachChild(analyzeFrame);
      popFrame();
      return;
    }
    // Note: parameters are not considered to be locals here (modifying them is not allowed, currently!)
    else if (Node.isVariableDeclaration(node)) {
      locals.set(node.getName(), node.getInitializer());
    }
    else if (functionHasDecoratorInSet(fn, deterministicDecorators)) {
      detCheckers.forEach((detChecker) => runErrorChecker(detChecker, node));
      // console.log(`Not accounted for (det function, ${node.getKindName()})... (${node.print()})`);
    }
    else if (functionHasDecoratorInSet(fn, checkSqlInjectionDecorators)) {
      runErrorChecker(isSqlInjection, node);
    }
    else {
      // console.log("Not accounted for (nondet function)...");
    }

    node.forEachChild(analyzeFrame);
  }

  body.forEachChild(analyzeFrame);
}

////////// These are the functions that deal with node interop

// Bijectivity is preseved for TSMorph <-> TSC <-> ESTree, as far as I can tell!
function makeTsMorphNode(eslintNode: EslintNode): Node {
  const parserServices = GLOBAL_TOOLS!.parserServices;
  const compilerNode = parserServices.esTreeNodeToTSNodeMap.get(eslintNode);

  const options = {
    compilerOptions: parserServices.program.getCompilerOptions(),
    sourceFile: compilerNode.getSourceFile(),
    typeChecker: GLOBAL_TOOLS!.typeChecker
  };

  return createWrappedNode(compilerNode, options);
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

  const typeChecker = GLOBAL_TOOLS!.typeChecker;

  // The name from the symbol is more minimal, so preferring that here when it's available
  const type = typeChecker.getTypeAtLocation(tsMorphNode.compilerNode);
  return type.getSymbol()?.getName() ?? typeChecker.typeToString(type);
}

function analyzeRootNode(eslintNode: EslintNode, eslintContext: EslintContext) {
  const parserServices = ESLintUtils.getParserServices(eslintContext, false);

  GLOBAL_TOOLS = {
    eslintContext: eslintContext,
    parserServices: parserServices,
    typeChecker: parserServices.program.getTypeChecker()
  };

  const tsMorphNode = makeTsMorphNode(eslintNode);

  try {
    if (Node.isStatemented(tsMorphNode)) {
      tsMorphNode.getFunctions().forEach(analyzeFunction);
      tsMorphNode.getClasses().forEach(analyzeClass);
    }
    else {
      throw new Error(`Was expecting a statemented node! Got this kind instead: ${tsMorphNode.getKindName()}`);
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
- Check for classes when assigned to a variable (like `const Foo = class ...`), and then scanning those
- Modification of outer class variables (so a class in another one, modifying some other `OuterClass.field`)
*/

//////////////////////////////////////////////////////////////////////////////////////////////////// Here is the ESLint plugin code (mostly boilerplate):

const baseConfig = {
  plugins: [
    "@typescript-eslint",
    "security",
    "no-secrets"
  ],

  env: { "node": true },

  rules: {
    "no-eval": "error",
    "@typescript-eslint/no-implied-eval": "error",
    "security/detect-unsafe-regex": "error",
    "no-secrets/no-secrets": "error",
    "@dbos-inc/dbos-static-analysis": "error"
  },

  extends: []
};

const recConfig = {
  ...baseConfig,

  extends: [
    ...baseConfig.extends,
    "plugin:@typescript-eslint/recommended-type-checked",
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

module.exports = {
  meta: {
    name: "@dbos-inc/eslint-plugin",
    version: "1.1.5"
  },

  rules: {
    "dbos-static-analysis": {
      meta: {
        type: "suggestion",
        docs: { description: "Analyze DBOS applications to make sure they run reliably (e.g. determinism checking)" },
        messages: Object.fromEntries(errorMessages)
      },

      create: (context: EslintContext) => {
        return {
          /* Note: I am working with ts-morph because it has
          stronger typing, and it's easier to work with the AST
          than ESTree's limited tree navigation. */
          Program(node: EslintNode) {
            analyzeRootNode(node, context);
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
    dbosBaseConfig: recConfig, // This is deprecated!
    dbosRecommendedConfig: recConfig,
    dbosExtendedConfig: recConfig // This is deprecated!
  }
};

export const dbosRulesPerName: any = module.exports.rules;
