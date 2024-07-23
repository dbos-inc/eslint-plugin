import * as tsExternal from "typescript";
import { ESLintUtils, TSESLint, TSESTree, ParserServicesWithTypeInformation } from "@typescript-eslint/utils";
import * as tslintPlugin from "@typescript-eslint/eslint-plugin";

import {
  ts, createWrappedNode, Node, Type, FunctionDeclaration,
  CallExpression, ConstructorDeclaration, ClassDeclaration,
  MethodDeclaration, SyntaxKind, Expression, Identifier, Symbol,
  VariableDeclaration, VariableDeclarationKind, ParenthesizedExpression,
  Project
} from "ts-morph";

// Should I find TypeScript variants of these?
const secPlugin = require("eslint-plugin-security");
const noSecrets = require("eslint-plugin-no-secrets");

/*
Note for upgrading `ts-morph` and `typescript` in `package.json`:
1. Make sure that the supported TypeScript version for `ts-morph` is the one installed here.
2. Make sure that the installed TypeScript version works with `dbos-demo-apps` (TypeScript 5.5 + ts-morph 23.0 caused some breakage there).
*/

//////////////////////////////////////////////////////////////////////////////////////////////////// Here is my `ts-morph` linting code:

////////// These are some shared types

const Nothing = undefined;
type Maybe<T> = NonNullable<T> | typeof Nothing;

type EslintNode = TSESTree.Node;
type EslintContext = TSESLint.RuleContext<string, unknown[]>;

// TODO: support `FunctionExpression` and `ArrowFunction` too
type FnDecl = FunctionDeclaration | MethodDeclaration | ConstructorDeclaration;
type GlobalTools = {eslintContext: EslintContext, parserServices: ParserServicesWithTypeInformation, typeChecker: ts.TypeChecker};

type ErrorMessageIdWithFormatData = [string, Record<string, unknown>];
type ErrorCheckerResult = Maybe<string | ErrorMessageIdWithFormatData>;

// This returns `string` for a simple error`, `ErrorMessageIdWithFormatData` for keys paired with formatting data, and `Nothing` for no error
type ErrorChecker = (node: Node, fnDecl: FnDecl, isLocal: (symbol: Symbol) => boolean) => ErrorCheckerResult;

////////// These are some shared values used throughout the code

let GLOBAL_TOOLS: Maybe<GlobalTools> = Nothing;

const errorMessages = makeErrorMessageSet();
const awaitableTypes = new Set(["WorkflowContext"]); // Awaitable in deterministic functions, to be specific

// This maps the ORM client name to a list of raw SQL query calls to check
const ormClientInfoForRawSqlQueries: Map<string, string[]> = new Map([
  ["PoolClient", ["TODO"]],
  ["PrismaClient", ["$queryRawUnsafe", "$executeRawUnsafe"]],
  ["TypeORMEntityManager", ["TODO"]],
  ["Knex", ["raw"]]
  // TODO: also support `UserDatabase` (if applicable)
]);

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

  // TODO: update this message if more types are added in the future to the `Workflow` key in `decoratorSetErrorCheckerMapping` below, or `awaitableTypes` above
  const awaitMessage = `The enclosing workflow makes an asynchronous call to a non-DBOS function. \
Please verify that this call is deterministic or it may lead to non-reproducible behavior`;

  const bcryptMessage = "Avoid using `bcrypt`, which contains native code. Instead, use `bcryptjs`. \
Also, some `bcrypt` functions generate random data and should only be called from communicators";

  // The keys are the ids, and the values are the messages themselves
  return new Map([
    ["sqlInjection", "Possible SQL injection detected. The parameter to the query call site traces back to the nonliteral on line {{ lineNumber }}: '{{ theExpression }}'"],
    ["globalMutation", "Deterministic DBOS operations (e.g. workflow code) should not mutate global variables; it can lead to non-reproducible behavior"],
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

// This is just for making sure that my tests work as they should
const testingValidityOfTestsLocally = false;

/*
TODO (requests from others, and general things for me to do):

- Harry asked me to add a config setting for `@StoredProcedure` methods to enable them to run locally.
  How hard is it to add a linter rule to always warn the user of this config setting is enabled?`

- Chuck gave a suggestion to allow some function calls for LR-values; and do this by finding a way to mark them as constant

From me:
- More callsite support
- Run this over `dbos-transact`
- Maybe track type and variable aliasing somewhere, somehow (if needed)
- Should I check more functions for SQL injection, if non-transactions are allowed to run raw queries?
*/

////////// These are some utility functions

function panic(message: string): never {
  throw new Error(message);
}

// This function exists so that I can make sure that my tests are reading valid symbols
function getNodeSymbol(node: Node | Type): Maybe<Symbol> {
  const symbol = node.getSymbol(); // Hm, how is `getSymbolAtLocation` different?
  if (testingValidityOfTestsLocally && symbol === Nothing) panic(`Expected a symbol for this node: '${node.getText()}'`);
  return symbol;
}

function unpackParenthesizedExpression(expr: ParenthesizedExpression): Node {
  // The first and third child are parentheses, and the second child is the contained value
  if (expr.getChildCount() !== 3) panic("Unexpected child count for a parenthesized expression!");
  return expr.getChildAtIndex(1);
}

// This reduces `f.x.y.z` or `f.y().z.w()` into `f` (the leftmost child). This term need not be an identifier.
function reduceNodeToLeftmostLeaf(node: Node): Node {
 while (true) {
    // For parenthesized expressions, we don't want the leftmost parenthesis
    if (Node.isParenthesizedExpression(node)) {
      node = unpackParenthesizedExpression(node);
    }
    else {
      const value = node.getFirstChild();
      if (value === Nothing) return node;
      node = value;
    }
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
function getLAndRValuesIfAssignment(node: Node): Maybe<[Identifier, Expression]> {
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
  // Could I use `getSymbolsInScope` with some right combination of flags here?
  const maybeLAndRValues = getLAndRValuesIfAssignment(node);
  if (maybeLAndRValues === Nothing) return;

  const lhsSymbol = getNodeSymbol(maybeLAndRValues[0]);

  if (lhsSymbol !== Nothing && !isLocal(lhsSymbol)) {
    return "globalMutation";
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

    if (argCountRange !== Nothing) {
      const argCount = node.getArguments().length;

      if (argCount >= argCountRange.min && argCount <= argCountRange.max) {
        return text; // Returning the function name key
      }
    }
  }
}

// TODO: match against `.then` as well (with a promise object preceding it)
const awaitsOnNotAllowedType: ErrorChecker = (node, _fnDecl, _isLocal) => {
  // If the valid type set and arg type set intersect, then there's a valid type in the args
  function validTypeExistsInFunctionCallParams(functionCall: CallExpression, validTypes: Set<string>): boolean {
    // I'd like to use `isDisjointFrom` here, but it doesn't seem to be available, for some reason
    const argTypes = functionCall.getArguments().map(getTypeNameForTsMorphNode);
    return argTypes.some((argType) => validTypes.has(argType));
  }

  //////////

  if (Node.isAwaitExpression(node)) {
    const functionCall = node.getExpression();
    if (!Node.isCallExpression(functionCall)) return; // Wouldn't make sense otherwise

    const lhs = reduceNodeToLeftmostLeaf(functionCall);

    if (!Node.isIdentifier(lhs) && !Node.isThisExpression(lhs)) { // `this` may have a type too
      // Doesn't make sense to await on literals (that will be reported by something else)
      if (Node.isLiteralExpression(lhs)) return;

      else {
        return; // Sometimes throwing an error here, since I want to catch what this could be, and maybe revise the code below
        // panic(`Hm, what could this expression be? Examine... (LHS: '${functionCall.getText()}', kind: ${lhs.getKindName()})`);
      }
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

function getNodePosInFile(node: Node): {line: number, column: number} {
  return node.getSourceFile().getLineAndColumnAtPos(node.getStart());
}

// This checks if a variable was used before it was declared; if so, there's a hoisting issue, and skip the declaration.
function identifierUsageIsValid(identifierUsage: Identifier, decl: VariableDeclaration): boolean {
  const declKind = decl.getVariableStatement()?.getDeclarationKind() ?? panic("When would a variable statement ever not be defined?");

  // If a variable was declared with `var`, then it can be used before it's declared (damn you, Brendan Eich!)
  if (declKind === VariableDeclarationKind.Var) return true;

  const identifierPos = getNodePosInFile(identifierUsage), declPos = getNodePosInFile(decl);

  const declIsOnPrevLine = declPos.line < identifierPos.line;
  const declIsOnSameLineButBeforeIdentifier = (declPos.line === identifierPos.line && declPos.column < identifierPos.column);

  return declIsOnPrevLine || declIsOnSameLineButBeforeIdentifier;
}

// This function scans the function body, and finds all references to the given identifier (excluding the one passed in)
function* getRValuesAssignedToIdentifier(fnDecl: FnDecl, identifier: Identifier): Generator<Expression | "NotRValueButFnParam"> {
  for (const param of fnDecl.getParameters()) {
    yield* getCorrespondingRValuesWithinNode(param);
  }

  yield* getCorrespondingRValuesWithinNode(fnDecl);

  //////////

  function* getCorrespondingRValuesWithinNode(node: Node): Generator<Expression | "NotRValueButFnParam"> {
    for (const child of node.getChildren()) { // Could I iterate through here without allocating the children?
      yield* getCorrespondingRValuesWithinNode(child);

      ////////// First, see if the child should be checked or not

      const isTheSameButUsedInAnotherPlace = (
        child !== identifier // Not the same node as our identifier
        && child.getKind() === SyntaxKind.Identifier // This child is an identifier
        && getNodeSymbol(child) === getNodeSymbol(identifier) // They have the same symbol (this stops false positives from shadowed values)
      );

      if (!isTheSameButUsedInAnotherPlace) continue;

      ////////// Then, analyze the child

      const parent = child.getParent() ?? panic("When would the parent to a reference ever not be defined?");

      if (Node.isVariableDeclaration(parent)) {
        // In this case, silently skip the reference (a compilation step will catch any hoisting issues)
        if (!identifierUsageIsValid(identifier, parent)) continue;

        const initialValue = parent.getInitializer();
        if (initialValue === Nothing) continue; // Not initialized yet, so skip this reference

        yield initialValue;
      }
      else {
          const maybeLAndRValues = getLAndRValuesIfAssignment(parent);

          if (maybeLAndRValues !== Nothing) {
            yield maybeLAndRValues[1];
          }
          else if (Node.isParameterDeclaration(parent)) {
            yield "NotRValueButFnParam";
          }
      }
    }
  }
}

function checkCallForInjection(callParam: Node, fnDecl: FnDecl): Maybe<ErrorMessageIdWithFormatData> {
  /*
  A literal-reducible value is either a literal string/number, or a variable that reduces down to a literal string/number. Acronym: LR.
  I'm just mentioning numbers here since the core allowed value is a string or number literal (but the main query parameter is a string).

  Here's what's allowed for SQL string parameters (from a supported callsite):
    1. LR
    2. LRs concatenated with other LRs
    3. Variables that reduce down to LRs concatenated with other LRSs

  A literal-reducible value is not flagged for SQL injection, since injection would typically
  happen in a case where you take some other non-literal-string datatype, cast it to a string,
  and then concatenate that with a SQL query string. As long as the final value passed to the
  callsite is only built up from literal strings at its core, then the final string should be okay.
  */

  /* If the node doesn't exist in `nodeLRResults`, it hasn't been explored yet.
  If its value is false, it's not LR. If its value is true, it's LR, or currently being
  computed (which can indicate the existence of a reference cycle).

  Also, it's worthy of noting that I'm not doing this result caching
  for the sake of efficiency: it's just so that reference cycles won't result
  in infinite recursion.

  Also note that errors may be falsely reported if you first use a string for a raw query,
  and then assign that query to a non-LR value. In most cases, that post-assigned value will
  not affect the query, but if you are in a loop and the query string is defined in an outer
  scope, the next loop iteration may then receive that non-LR value, which would qualify as a SQL injection.

  This is only for declarations, and not assignments; doing a raw query with some LR value,
  and then declaring a variable with the same name, is an error (due to variable hoisting).
  It would not be an error with `var` (since you can use variables defined with `var` before
  they are declared), but that is a practical error that this linter plugin is not expected to pick up on.
  */

  const nodeLRResults: Map<Node, boolean> = new Map();
  const rootProblemNodes: Set<Node> = new Set();

  function isLRWithoutResultCache(node: Node): boolean {
    if (Node.isStringLiteral(node) || Node.isNumericLiteral(node)) {
      return true;
    }
    /* i.e. if it's a format string (like `${foo} ${bar} ${baz}`).
    I am not supporting tagged template expressions, since they involve
    a function call. */
    else if (Node.isTemplateExpression(node)) {
      return node.getTemplateSpans().every((span) => {
        // The first child is the contained value, and the second child is the end of the format specifier
        if (span.getChildCount() !== 2) panic("Unexpected child count for a template span!");
        return isLR(span.getChildAtIndex(0));
      });
    }
    else if (Node.isIdentifier(node)) {
      for (const rValueAssigned of getRValuesAssignedToIdentifier(fnDecl, node)) {
        const isParam = rValueAssigned === "NotRValueButFnParam";

        if (isParam) rootProblemNodes.add(node);
        if (isParam || !isLR(rValueAssigned)) return false;
      }

      return true;
    }
    else if (Node.isBinaryExpression(node)) {
      return isLR(node.getLeft()) && isLR(node.getRight());
    }
    else if (Node.isParenthesizedExpression(node)) {
      return isLR(unpackParenthesizedExpression(node));
    }
    else {
      rootProblemNodes.add(node);
      return false;
    }
  }

  function isLR(node: Node): boolean {
    const maybeResult = nodeLRResults.get(node);

    if (maybeResult !== Nothing) {
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
    if (rootProblemNodes.size !== 1) panic("There's a strict requirement of 1 root problem node during failure!");
    let discoveredNode = Array.from(rootProblemNodes)[0];

    return ["sqlInjection", {
      lineNumber: getNodePosInFile(discoveredNode).line,
      theExpression: discoveredNode.getText()
    }];
  }
}

// If it's a raw SQL injection callsite, then this returns the arguments to examine
function maybeGetArgsFromRawSqlCallSite(callExpr: CallExpression): Maybe<Node[]> {
  const callExprWithoutParams = callExpr.getExpression();

  // `client.<callName>`, or `ctxt.client.<callName>`
  const identifiers = callExprWithoutParams.getDescendantsOfKind(SyntaxKind.Identifier);
  if (identifiers.length !== 2 && identifiers.length !== 3) return;

  const identifierTypeNames = identifiers.map(getTypeNameForTsMorphNode);

  if (identifiers.length === 3) {
    // If it's the 3-identifier variant, check that it's from a `TransactionContext`
    if (identifierTypeNames[0] !== "TransactionContext") return;

    // Removing the context from the front
    identifiers.shift();
    identifierTypeNames.shift();
  }

  //////////

  const maybeInfo = ormClientInfoForRawSqlQueries.get(identifierTypeNames[0]);

  if (maybeInfo !== Nothing) {
    const callArgs = callExpr.getArguments();
    const callSiteHere = identifiers[1].getText();
    if (maybeInfo.includes(callSiteHere)) return callArgs;
  }
}

const isSqlInjection: ErrorChecker = (node, fnDecl, _isLocal) => {
  if (Node.isCallExpression(node)) {
   const maybeArgs = maybeGetArgsFromRawSqlCallSite(node);

    if (maybeArgs !== Nothing) {
      for (const arg of maybeArgs) {
        const injectionFailure = checkCallForInjection(arg, fnDecl);
        if (injectionFailure !== Nothing) return injectionFailure;
      }
    }
  }
}

////////// This is the main function that recurs on the `ts-morph` AST

// Note: a workflow can never be a transaction, so no need to worry about overlap here
const decoratorSetErrorCheckerMapping: [Set<string>, ErrorChecker[]][] = [
  [new Set(["Transaction"]), [isSqlInjection]], // Checking for SQL injection here
  [new Set(["Workflow"]), [mutatesGlobalVariable, callsBannedFunction, awaitsOnNotAllowedType]] // Checking for nondeterminism here
];

function analyzeFunction(fnDecl: FnDecl) {
  // A function declaration without a body: `declare function myFunction();`
  const body = fnDecl.getBody();
  if (body === Nothing) return;

  /* Note that each stack is local to each function,
  so it's reset when a new function is entered
  (anything not on the stack would be outside the function).

  Also note that no exceptions should be caught in `analyzeFrame`,
  since this might result in the stack ending up in a bad state (allowing
  any exceptions to exit outside `analyzeFunction` would lead
  to the stack getting reset if `analyzeFunction` is called again). */

  // This stack variant is slower for `isLocal`, but uses less memory for symbols allocated
  const stack: Set<Symbol>[] = [new Set()];
  const getCurrentFrame = () => stack[stack.length - 1];
  const pushFrame = () => stack.push(new Set());
  const popFrame = () => stack.pop(); // Would I resolve the symbol faster in `isLocal` if checking backwards?
  const isLocal = (symbol: Symbol) => stack.some((frame) => frame.has(symbol));

  // This stack variant is faster for `isLocal`, but uses more memory for lots of scopes
  /*
  const stack: Set<Symbol> = new Set();
  const getCurrentFrame = () => stack;
  const pushFrame = () => {};
  const popFrame = () => {};
  const isLocal = (symbol: Symbol) => stack.has(symbol);
  */

  function runErrorChecker(errorChecker: ErrorChecker, node: Node) {
    const response = errorChecker(node, fnDecl, isLocal);

    if (response !== Nothing) {
      const [messageId, formatData] = typeof response === "string" ? [response, {}] : response;
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
    // Note: parameters are not considered to be locals here (mutating them is not allowed, currently!)
    else if (Node.isVariableDeclaration(node)) {
      const symbol = getNodeSymbol(node);
      if (symbol !== Nothing) locals.add(symbol);
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

  const eslintNode =
    GLOBAL_TOOLS!.parserServices.tsNodeToESTreeNodeMap.get(compilerNode)
    ?? panic("Couldn't find the corresponding ESLint node!");

  return eslintNode;
}

function getTypeNameForTsMorphNode(tsMorphNode: Node): string {
  // If it's a literal type, it'll get the base type; otherwise, nothing happens
  const type = tsMorphNode.getType().getBaseTypeOfLiteralType();
  const maybeSymbol = getNodeSymbol(type);
  return maybeSymbol?.getName() ?? type.getText();
}

// This is just for making sure that the unit tests are well constructed (not used when deployed)
function checkDiagnostics(node: Node) {
  const project = new Project({});

  const eslintNodeCode = node.getFullText();
  project.createSourceFile("temp.ts", eslintNodeCode, { overwrite: true });
  const diagnostics = project.getPreEmitDiagnostics();

  if (diagnostics.length != 0) {
    const formatted = diagnostics.map((diagnostic) =>
      `Diagnostic at line ${diagnostic.getLineNumber()}: ${JSON.stringify(diagnostic.getMessageText())}.\n---\n`
    ).join("\n");

    panic(formatted);
  }
}

function analyzeRootNode(eslintNode: EslintNode, eslintContext: EslintContext) {
  const parserServices = ESLintUtils.getParserServices(eslintContext, false);

  GLOBAL_TOOLS = {
    eslintContext: eslintContext,
    parserServices: parserServices,
    typeChecker: parserServices.program.getTypeChecker()
  };

  const tsMorphNode = makeTsMorphNode(eslintNode);
  if (testingValidityOfTestsLocally) checkDiagnostics(tsMorphNode);

  try {
    if (Node.isStatemented(tsMorphNode)) {
      tsMorphNode.getFunctions().forEach(analyzeFunction);
      tsMorphNode.getClasses().forEach(analyzeClass);
    }
    else {
      const possibleVersioningError = `\
This might be from disjoint TypeScript compiler API versions (ts-morph uses ${ts.version}, but ${tsExternal.version} is installed externally).
If the versions are the same, check the version that typescript-eslint is using. A likely fix would be to match your local
TypeScript version with one of these, as an exact version (no ^ or ~ prefixes)`;

      panic(`Was expecting a statemented root node! Got this kind instead: ${tsMorphNode.getKindName()}.\n${possibleVersioningError}\n`);
    }
  }
  finally {
    // Not keeping the tools around after being done with them
    GLOBAL_TOOLS = Nothing;
  }
}

/*
- Take a look at these functions later on:
isArrowFunction, isFunctionExpression, isObjectBindingPattern, isPropertyAssignment, isQualifiedName, isVariableDeclarationList

- Check function expressions and arrow functions for mutation (and interfaces?)
- Check for recursive global mutation for expected-to-be-deterministic functions
- Check for classes when assigned to a variable (like `const Foo = class ...`), and then scanning those
- Mutation of outer class variables (so a class in another one, modifying some other `OuterClass.field`)
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
    version: "2.0.0"
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
