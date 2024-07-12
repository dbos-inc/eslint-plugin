import * as tslintPlugin from "@typescript-eslint/eslint-plugin";
import { ESLintUtils, TSESLint, TSESTree, ParserServicesWithTypeInformation } from "@typescript-eslint/utils";

import {
  ts, createWrappedNode, Node, FunctionDeclaration,
  CallExpression, ConstructorDeclaration, ClassDeclaration,
  MethodDeclaration, SyntaxKind, Expression, Identifier
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

////////// These are some shared types

// TODO: support `FunctionExpression` and `ArrowFunction` too
type FnDecl = FunctionDeclaration | MethodDeclaration | ConstructorDeclaration;
type GlobalTools = {eslintContext: EslintContext, parserServices: ParserServicesWithTypeInformation, typeChecker: ts.TypeChecker};

type ErrorMessageIdWithFormatData = [string, Record<string, unknown>];

// This returns `undefined` for no error; otherwise, it returns a just key to the `errorMessages` map, or a key paired with info for error string formatting
type ErrorChecker = (node: Node, fnDecl: FnDecl, isLocal: (name: string) => boolean) => string | ErrorMessageIdWithFormatData | undefined;

////////// These are some shared values used throughout the code

let GLOBAL_TOOLS: GlobalTools | undefined = undefined;

const errorMessages = makeErrorMessageSet();
const awaitableTypes = new Set(["WorkflowContext"]); // Awaitable in deterministic functions, to be specific
const validOrmClientNames = new Set(["PoolClient", "PrismaClient", "TypeORMEntityManager", "Knex"]);

const assignmentTokenKinds = new Set([
  SyntaxKind.EqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.SlashEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.LessThanLessThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.BarEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
  SyntaxKind.CaretEqualsToken
]);

// All of these function names are also keys in `errorMesages` above. Also note that the ranges are inclusive.
const bannedFunctionsWithArgCountRanges: Map<string, {min: number, max: number}> = new Map([
  ["Date",           {min: 0, max: 0}],
  ["Date.now",       {min: 0, max: 0}],
  ["Math.random",    {min: 0, max: 0}],
  ["console.log",    {min: 0, max: Number.MAX_SAFE_INTEGER}],
  ["setTimeout",     {min: 1, max: Number.MAX_SAFE_INTEGER}],
  ["bcrypt.hash",    {min: 3, max: 3}],
  ["bcrypt.compare", {min: 3, max: 3}]
]);

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
  return new Map([ // TODO: vary the error type ("involved nonliteral string concatenation", or "was a nonliteral parameter")
    ["sqlInjection", "Possible SQL injection detected (The expression on line {{ lineNumber }} involved nonliteral string concatenation, or a function parameter)! Use prepared statements instead"],
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
Peter asked me to add a config setting for `@StoredProcedure` methods to enable them to run locally.
How hard is it to add a linter rule to always warn the user of this config setting is enabled?`
*/

////////// These are some utility functions

function panic(message: string): never {
  throw new Error(message);
}

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

function functionHasDecoratorInSet(fnDecl: FnDecl, decoratorSet: Set<string>): boolean {
  return fnDecl.getModifiers().some((modifier) =>
    Node.isDecorator(modifier) && decoratorSet.has(modifier.getName())
  );
}

/* This returns the lvalue and rvalue for an assignment,
if the node is an assignment expression and the lvalue is an identifier */
function getLAndRValuesIfAssignment(node: Node): [Identifier, Expression] | undefined {
  if (Node.isBinaryExpression(node)) {
    const operatorKind = node.getOperatorToken().getKind();

    if (assignmentTokenKinds.has(operatorKind)) {
      /* Reducing from `a.b.c` to `a`, or just `a` to `a`.
      Also, note that `lhs` means lefthand side. */
      const lhs = reduceNodeToLeftmostLeaf(node.getLeft());
      if (Node.isIdentifier(lhs)) return [lhs, node.getRight()];
    }
  }
}

////////// These functions are the determinism heuristics that I've written

const mutatesGlobalVariable: ErrorChecker = (node, _fnDecl, isLocal) => {
  const maybeLAndRValues = getLAndRValuesIfAssignment(node);

  if (maybeLAndRValues !== undefined && !isLocal(maybeLAndRValues[0].getText())) {
    return "globalModification";
  }

  /*
  Note that `a = 5, b = 6`, or `x = 23 + x, x = 24 + x;` both work,
  along with variable swaps in the style of `b = [a, a = b][0]`.
  TODO: catch spread assignments like this one: `[a, b] = [b, a]`.
  */
}

/* TODO: should I ban more IO functions, like `fetch`,
and mutating global arrays via functions like `push`, etc.? */
const callsBannedFunction: ErrorChecker = (node, _fnDecl, _isLocal) => {
  if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
    /* Doing this to make syntax like `Math. random` be reduced to `Math.random`
    (although this might not work for more complicated function call layouts).
    If I have to make more complicated function calls, make this call more robust. */

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

const awaitsOnNotAllowedType: ErrorChecker = (node, _fnDecl, _isLocal) => {
  // TODO: match against `.then` as well (with a promise object preceding it)

  //////////

  // If the valid type set and arg type set intersect, then there's a valid type in the args
  function validTypeExistsInFunctionCallParams(functionCall: CallExpression, validTypes: Set<string>): boolean {
    // I'd like to use `isDisjointFrom` here, but it doesn't seem to be available, for some reason
    const argTypes = functionCall.getArguments().map(getTypeNameForTsMorphNode);
    return argTypes.some((argType) => validTypes.has(argType));
  }

  if (Node.isAwaitExpression(node)) {
    const functionCall = node.getExpression();
    if (!Node.isCallExpression(functionCall)) return; // Wouldn't make sense otherwise

    let lhs = reduceNodeToLeftmostLeaf(functionCall);

    if (!Node.isIdentifier(lhs) && !Node.isThisExpression(lhs)) { // `this` may have a type too
      // Doesn't make sense to await on literals (that will be reported by something else)
      if (Node.isLiteralExpression(lhs)) return;

      // Throwing an error here, since I want to catch what this could be, and maybe revise the code below
      else panic(`Hm, what could this expression be? Examine... (${lhs.getKindName()}, ${lhs.print()})`);
    }

    //////////

    const typeName = getTypeNameForTsMorphNode(lhs);
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

// This function scans the function body, and finds all references to the given identifier (excluding the one passed in)
function* getRValuesAssignedToIdentifier(fnDecl: FnDecl, identifier: Identifier): Generator<Expression | "NotRValueButFnParam"> {
  for (const param of fnDecl.getParameters()) {
    yield* getCorrespondingRValuesWithinNode(param);
  }

  yield* getCorrespondingRValuesWithinNode(fnDecl);

  function* getCorrespondingRValuesWithinNode(node: Node): Generator<Expression | "NotRValueButFnParam"> {
    for (const child of node.getChildren()) {
      yield* getCorrespondingRValuesWithinNode(child);

      ////////// First, see if the child should be checked or not

      const isTheSameButUsedInAnotherPlace = (
        child !== identifier // Not the same node as our identifier
        && child.getKind() === SyntaxKind.Identifier // This child is an identifier
        && child.getSymbol() === identifier.getSymbol() // They have the same symbol (this stops false positives from aliased values)
      );

      if (!isTheSameButUsedInAnotherPlace) continue;

      //////////

      const parent = child.getParent();
      if (parent === undefined) panic("When would the parent to a reference ever not be defined?");

      if (Node.isVariableDeclaration(parent)) {
        const initialValue = parent.getInitializer();
        if (initialValue === undefined) continue; // Not initialized yet, so skip this reference
        yield initialValue;
      }
      else {
          const maybeLAndRValues = getLAndRValuesIfAssignment(parent);

          if (maybeLAndRValues !== undefined) {
            yield maybeLAndRValues[1];
          }
          else if (Node.isParameterDeclaration(parent)) {
            yield "NotRValueButFnParam";
          }
      }
    }
  }
}

function checkCallForInjection(callParam: Node, fnDecl: FnDecl): ErrorMessageIdWithFormatData | undefined {
  /* TODO:
  - Do not allow format strings
  - Try a function with a string parameter, and test out concatenation from there
  - Don't report errors if it is statically determined that they don't influence the query string (e.g. it's after the call, and it's not in a loop context)

  A literal-reducible value is either a literal string, or a variable that reduces down to a literal string. Acronym: LR.
  Here's what's allowed for SQL string parameters (from a supported callsite):
    1. LR
    2. LRs concatenated with other LRs
    3. Variables that reduce down to LRs concatenated with other LRSs

  A literal-reducible value is not flagged for SQL injection, since injection would typically
  happen in a case where you take some other non-literal-string datatype, cast it to a string,
  and then concatenate that with a SQL query string. As long as the final value passed to the
  callsite is only built up from literal strings at its core, then the final string should be okay.
  */

  /* If the node's value is undefined, it hasn't been explored yet.
  If it's false, it's not LR. If it's true, it's LR, or currently being
  computed (which can indicate the existance of a reference cycle).

  Also, it's worthy of noting that I'm not doing this result caching
  for the sake of efficiency, it's so that reference cycles won't result
  in infinite recursion. */
  let nodeLRResults: Map<Node, boolean> = new Map();

  function isLRWithoutResultCache(node: Node): boolean {
    if (Node.isStringLiteral(node)) {
      return true;
    }
    else if (Node.isIdentifier(node)) {
      for (const rvalueAssigned of getRValuesAssignedToIdentifier(fnDecl, node)) {
        if (rvalueAssigned === "NotRValueButFnParam" || !isLR(rvalueAssigned)) return false;
      }

      return true;
    }
    else if (Node.isBinaryExpression(node)) {
      return isLR(node.getLeft()) && isLR(node.getRight());
    }
    else {
      return false;
    }
  }

  function isLR(node: Node): boolean {
    const maybeResult = nodeLRResults.get(node);

    if (maybeResult !== undefined) {
      return maybeResult;
    }
    else {
      // Ending up in a cycle (e.g. from `z = z + "foo";`) will mark the node as LR
      nodeLRResults.set(node, true);
      const wasLR = isLRWithoutResultCache(node);
      nodeLRResults.set(node, wasLR);
      return wasLR;
    }
  }

  if (!isLR(callParam)) {
    // TODO: report the node that failed the check, in order to get the right line number
    const lineNumber = callParam.getSourceFile().getLineAndColumnAtPos(callParam.getStart()).line;
    return ["sqlInjection", {lineNumber: lineNumber}];
  }
}

const isSqlInjection: ErrorChecker = (node, fnDecl, _isLocal) => {
  if (Node.isCallExpression(node)) {
    const subexpr = node.getExpression();

    // `ctxt.client.<callName>`
    const identifiers = subexpr.getDescendantsOfKind(SyntaxKind.Identifier);

    // An injection in DBOS must match `ctxt.client.<something>`
    if (identifiers.length !== 3) return;

    const callArgs = node.getArguments();
    const identifierTypeNames = identifiers.map(getTypeNameForTsMorphNode);

    const maybeOrmClientName = identifierTypeNames[1];

    // In this case, not a valid DBOS SQL query
    if (identifierTypeNames[0] !== "TransactionContext" || !validOrmClientNames.has(maybeOrmClientName)) {
      return;
    }

    if (maybeOrmClientName === "Knex" && identifiers[2].getText() === "raw") {
      // TODO: just return this directly
      const errors = checkCallForInjection(callArgs[0], fnDecl);
      if (errors !== undefined) return errors;
    }
    else {
      panic(`${maybeOrmClientName} not implemented yet`);
    }
  }
}

////////// This is the main function that recurs on the `ts-morph` AST

// Note: a workflow can never be a transaction, so no need to worry about overlap here
const decoratorSetErrorCheckerMapping: Map<Set<string>, ErrorChecker[]> = new Map([
  [new Set(["Transaction"]), [isSqlInjection]],
  [new Set(["Workflow"]), [mutatesGlobalVariable, callsBannedFunction, awaitsOnNotAllowedType]]
]);

function analyzeFunction(fnDecl: FnDecl) {
  const body = fnDecl.getBody(); // TODO: use the or-throw variant here
  if (body === undefined) panic("When would a function not have a body?");

  /* Note that each stack is local to each function,
  so it's reset when a new function is entered
  (anything not on the stack would be outside the function).

  Also note that no exceptions should be caught in `analyzeFrame`,
  since this might result in the stack ending up in a bad state (allowing
  any exceptions to exit outside `analyzeFunction` would lead
  to the stack getting reset if `analyzeFunction` is called again). */

  const stack: Set<string>[] = [new Set()];
  const getCurrentFrame = () => stack[stack.length - 1];
  const pushFrame = () => stack.push(new Set());
  const popFrame = () => stack.pop();
  const isLocal = (name: string) => stack.some((frame) => frame.has(name));

  function runErrorChecker(errorChecker: ErrorChecker, node: Node) {
    const response = errorChecker(node, fnDecl, isLocal);

    if (response !== undefined) {
      let [messageId, formatData] = typeof response === "string" ? [response, {}] : response;
      GLOBAL_TOOLS!.eslintContext.report({ node: makeEslintNode(node), messageId: messageId, data: formatData });
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
      locals.add(node.getName());
    }
    else {
      for (const [decoratorSet, errorCheckers] of decoratorSetErrorCheckerMapping) {
        if (functionHasDecoratorInSet(fnDecl, decoratorSet)) {
          errorCheckers.forEach((errorChecker) => runErrorChecker(errorChecker, node));
          break; // This assumes that applying one decorator means that you can't apply another on top of it
        }
      }
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
  const eslintNode = GLOBAL_TOOLS!.parserServices.tsNodeToESTreeNodeMap.get(compilerNode);
  if (eslintNode === undefined) panic("Couldn't find the corresponding ESLint node!");
  return eslintNode;
}

// If the returned name is undefined, then there is no associated type (e.g. a never-defined but used variable)
function getTypeNameForTsMorphNode(tsMorphNode: Node): string {
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
      panic(`Was expecting a statemented root node! Got this kind instead: ${tsMorphNode.getKindName()}`);
    }
  }
  finally {
    // Not keeping the tools around after failure
    GLOBAL_TOOLS = undefined;
  }
}

/*
- Take a look at these functions later on:
isArrowFunction, isFunctionExpression, isObjectBindingPattern, isPropertyAssignment, isQualifiedName, isVariableDeclarationList

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
