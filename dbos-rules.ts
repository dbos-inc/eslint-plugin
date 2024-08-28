import * as tslintPlugin from "@typescript-eslint/eslint-plugin";
import { ESLintUtils, TSESLint, TSESTree, ParserServicesWithTypeInformation } from "@typescript-eslint/utils";

import {
  ts, createWrappedNode, Node, Type, FunctionDeclaration,
  CallExpression, ConstructorDeclaration, ClassDeclaration,
  MethodDeclaration, SyntaxKind, Expression, Identifier, Symbol,
  VariableDeclaration, VariableDeclarationKind, ParenthesizedExpression,
  Project, PropertyAccessExpression, ElementAccessExpression
} from "ts-morph";

import * as fs from "fs";
import * as path from "path";

//////////////////////////////////////////////////////////////////////////////////////////////////// Here is my `ts-morph` linting code:

////////// These are some shared types

const Nothing = undefined;
type Maybe<T> = NonNullable<T> | typeof Nothing;

type EslintNode = TSESTree.Node;
type EslintContext = TSESLint.RuleContext<string, unknown[]>;

// TODO: support `FunctionExpression` and `ArrowFunction` too
type FnDecl = FunctionDeclaration | MethodDeclaration | ConstructorDeclaration;

type GlobalTools = {
  eslintContext: EslintContext,
  rootEslintNode: EslintNode,
  parserServices: ParserServicesWithTypeInformation,
  typeChecker: ts.TypeChecker,
  symRefMap: Map<Symbol, Node[]>
};

type ErrorMessageIdWithFormatData = [string, Record<string, unknown>];
type ErrorCheckerResult = Maybe<string | ErrorMessageIdWithFormatData>;

// This returns `string` for a simple error`, `ErrorMessageIdWithFormatData` for keys paired with formatting data, and `Nothing` for no error
type ErrorChecker = (node: Node, fnDecl: FnDecl, isLocal: (symbol: Symbol) => boolean) => ErrorCheckerResult;

/* Note that for property access expressions and element access expressions,
that they cannot be mutlilayered (e.g. `a.b.c` or `a["b"]["c"]`). This is
a current limitation in the implementation of allowed LValues for SQL injection.  */
type AllowedLValue = Identifier | PropertyAccessExpression | ElementAccessExpression;

////////// These are some shared values used throughout the code

let GLOBAL_TOOLS: Maybe<GlobalTools> = Nothing;

const errorMessages = makeErrorMessageSet();
const awaitableTypes = new Set(["WorkflowContext"]); // Awaitable in deterministic functions, to be specific

// This maps the ORM client name to a list of raw SQL query calls to check
const ormClientInfoForRawSqlQueries: Map<string, string[]> = new Map([
  ["Knex", ["raw"]], // For Knex
  ["PrismaClient", ["$queryRawUnsafe", "$executeRawUnsafe"]], // For Prisma
  ["EntityManager", ["query"]], // For TypeORM
  ["PoolClient", ["query"]], // This is supported in `dbos-transact` (see `user_database.ts`, but not sure what ORM this corresponds to)
  ["PgDatabase", []], // For Drizzle (Currently we don't detect raw SQL calls for Drizzle)
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

  const sqlInjectionNotes = `Note: for object access, an access of \`a.b.c.d\` will reduce to \`a.b\`, which may result in false positives;
and accesses via brackets (e.g. \`a["b"]\`) only succeed when every field in the object is known to be always constant`;

  // The keys are the ids, and the values are the messages themselves
  return new Map([
    ["transactionHasNoParameters", "This transaction has no parameters; add a `TransactionContext` parameter"],
    ["transactionContextHasNoTypeArguments", "The context passed to this transaction has no type arguments; add one to specify the database client"],
    ["transactionContextHasInvalidClientType", "The database client type `{{ clientType }}` used here is not recognized by the linter; consult the DBOS docs to find a supported one"],
    ["transactionDoesntUseTheDatabase", "This transaction does not use the database (via its `client` field). Consider using a communicator or a normal function"],

    ["sqlInjection", `Possible SQL injection detected. The parameter to the query call site traces back to the nonliteral on line {{ lineNumber }}: \`{{ theExpression }}\`\n${sqlInjectionNotes}`],
    ["globalMutation", "Deterministic DBOS operations (e.g. workflow code) should not mutate global variables; it can lead to non-reproducible behavior"],
    ["awaitingOnNotAllowedType", awaitMessage],
    ["Date", makeDateMessage("`Date()` or `new Date()`")],
    ["Date.now", makeDateMessage("`Date.now()`")],
    ["Math.random", "Avoid calling `Math.random()` directly; it can lead to non-reproducible behavior. See `@dbos-inc/communicator-random`"],
    ["console.log", "Avoid calling `console.log` directly; the DBOS logger, `ctxt.logger.info`, is recommended."],
    ["setTimeout", "Avoid calling `setTimeout()` directly; it can lead to undesired behavior when debugging"],
    ["bcrypt.hash", bcryptMessage],
    ["bcrypt.compare", bcryptMessage],
    ["debugLogMessage", "{{ message }}"]
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
const testValidityOfTestsLocally = false;

// This controls whether debug logging is enabled (outputted as an ESLint error)
const enableDebugLog = false;

/*
TODO (requests from others, and general things for me to do):

- Harry asked me to add a config setting for `@StoredProcedure` methods to enable them to run locally.
  How hard is it to add a linter rule to always warn the user of this config setting is enabled?`

- Chuck gave a suggestion to allow some function calls for LR-values; and do this by finding a way to mark them as constant

- Alex gave me this suggestion from a user: resolve many promises in parallel (with `Promise.all`)

From me:
- Run this over `dbos-transact`
- Maybe track type and variable aliasing somewhere, somehow (if needed)
- Mark some simple function calls as being constant (this could quickly spiral in terms of complexity)
- Add full Drizzle support!
*/

////////// These are some utility functions

function debugLog(message: string) {
  if (enableDebugLog) {
    const eslintContext = GLOBAL_TOOLS!.eslintContext, rootNode = GLOBAL_TOOLS!.rootEslintNode;
    eslintContext.report({ node: rootNode, messageId: "debugLogMessage", data: { message: message } });
  }
}

function panic(message: string): never {
  throw new Error(message);
}

// This function exists so that I can make sure that my tests are reading valid symbols
function getSymbol(nodeOrType: Node | Type): Maybe<Symbol> {
  const symbol = nodeOrType.getSymbol(); // Hm, how is `getSymbolAtLocation` different?

  if (symbol === Nothing) {
    const name = (nodeOrType instanceof Node) ? "node" : "type";
    debugLog(`Expected a symbol for this ${name}: '${nodeOrType.getText()}'`);
  }

  return symbol;
}

function getTypeName(nodeOrType: Node | Type): string {
  if (nodeOrType instanceof Node) {
    // If it's a literal type, it'll get the base type; otherwise, nothing happens
    const type = nodeOrType.getType().getBaseTypeOfLiteralType();
    const maybeSymbol = getSymbol(type);
    return maybeSymbol?.getName() ?? type.getText(nodeOrType);
  }
  else {
    return getSymbol(nodeOrType)?.getName() ?? nodeOrType.getText();
  }
}

function getRefsToNodeOrSymbol(nodeOrSymbol: Node | Symbol): Node[] {
  let maybeSymbol = nodeOrSymbol instanceof Node ? getSymbol(nodeOrSymbol) : nodeOrSymbol;

  if (maybeSymbol === Nothing) {
    debugLog("Found no symbol for the node or symbol passed in!");
    return [];
  }
  else {
    const refs = GLOBAL_TOOLS!.symRefMap.get(maybeSymbol);
    if (refs === Nothing) panic("Expected to find refs for a symbol, but refs could not be found!");
    return refs;
  }
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

function isAllowedLValue(node: Node): node is AllowedLValue {
  return Node.isIdentifier(node) || Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node);
}

////////// These functions are the determinism heuristics that I've written

// Could I use `getSymbolsInScope` with some right combination of flags here?
const mutatesGlobalVariable: ErrorChecker = (node, _fnDecl, isLocal) => {
  if (!Node.isBinaryExpression(node)) return;

  const operatorKind = node.getOperatorToken().getKind();
  if (!assignmentTokenKinds.has(operatorKind)) return;

  /* Reducing from `a.b.c` to `a`, or just `a` to `a`.
  Also, note that `lhs` means lefthand side. */
  const lhs = reduceNodeToLeftmostLeaf(node.getLeft());
  if (!isAllowedLValue(lhs)) return;

  const lhsSymbol = getSymbol(lhs);

  if (lhsSymbol !== Nothing && !isLocal(lhsSymbol)) {
    return "globalMutation";
  }

  /* Note that `a = 5, b = 6`, or `x = 23 + x, x = 24 + x;` both work,
  along with variable swaps in the style of `b = [a, a = b][0]`.
  TODO: catch spread assignments like this one: `[a, b] = [b, a]`. */
};

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
};

// TODO: match against `.then` as well (with a promise object preceding it)
const awaitsOnNotAllowedType: ErrorChecker = (node, _fnDecl, _isLocal) => {
  // If the valid type set and arg type set intersect, then there's a valid type in the args.
  function validTypeExistsInFunctionCallParams(functionCall: CallExpression, validTypes: Set<string>): boolean {
    // I'd like to use `isDisjointFrom` here, but it doesn't seem to be available, for some reason
    const argTypes = functionCall.getArguments().map(getTypeName);
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
        debugLog(`Hm, what could this expression be? Examine... (LHS: '${functionCall.getText()}', kind: ${lhs.getKindName()})`);
        return;
      }
    }

    //////////

    const awaitingOnAllowedType = awaitableTypes.has(getTypeName(lhs));

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
};

////////// This code is for detecting SQL injections

function getNodePosInFile(node: Node): {line: number, column: number} {
  return node.getSourceFile().getLineAndColumnAtPos(node.getStart());
}

// This checks if a variable was used before it was declared; if so, there's a hoisting issue, and skip the declaration.
function lValueUsageIsValidRegardingHoisting(allowedLValueUsage: AllowedLValue, decl: VariableDeclaration): boolean {
  const variableStatement = decl.getVariableStatement();
  if (variableStatement === Nothing) return true; // This should ideally never happen
  const declKind = variableStatement.getDeclarationKind();

  // If a variable was declared with `var`, then it can be used before it's declared (damn you, Brendan Eich!)
  if (declKind === VariableDeclarationKind.Var) return true;

  const identifierPos = getNodePosInFile(allowedLValueUsage), declPos = getNodePosInFile(decl);

  const declIsOnPrevLine = declPos.line < identifierPos.line;
  const declIsOnSameLineButBeforeIdentifier = (declPos.line === identifierPos.line && declPos.column < identifierPos.column);

  return declIsOnPrevLine || declIsOnSameLineButBeforeIdentifier;
}

function* implGetAssignmentsToLValue(maybeAllowedLValue: Node,
  rhsExtractor: (rhs: Expression) => Maybe<Node>): Generator<Node | "NotRValueButFnParam"> {

  // e.g. `bar().foo`, or `this.foo`
  if (!isAllowedLValue(maybeAllowedLValue)) {
    yield maybeAllowedLValue;
    return;
  }

  const allowedLValue: AllowedLValue = maybeAllowedLValue;

  for (const ref of getRefsToNodeOrSymbol(allowedLValue)) {
    if (ref === allowedLValue) continue;

    if (Node.isVariableDeclaration(ref)) {
      if (!lValueUsageIsValidRegardingHoisting(allowedLValue, ref)) continue;
      const initializer = ref.getInitializer();
      if (initializer === Nothing) continue;

      const initialValue = rhsExtractor(initializer);
      if (initialValue !== Nothing) yield initialValue;
    }
    else if (Node.isParameterDeclaration(ref)) {
      yield "NotRValueButFnParam";
    }
    else {
      let refParent = ref;

      while (Node.isLeftHandSideExpression(refParent)) {
        refParent = refParent.getParentOrThrow("Expected a parent node to exist!");
      }

      if (Node.isBinaryExpression(refParent)) {
        const extracted = rhsExtractor(refParent.getRight());
        if (extracted !== Nothing) yield extracted;
      }
    }
  }
}

/* This function scans the scope to check, and finds all things assigned to the given identifier
(excluding the one passed in). A 'thing' is either an rvalue expression or a function parameter.
Also note that the identifier can be something like `x`, where an assignment could be something like
`x.y` (so not just an direct assignment). Indexing works too.

If multilayered access happens, like `x.y.z`, or `x["y"]["z"]`, the node will get reduced down to the
first layer of access (so `x.y` and `x["y"]`, which may result in false positives. As a programmer,
you can make plugin able to detect this if you assign each access step along the way to a variable. */
function* getAssignmentsToLValue(allowedLValue: AllowedLValue): Generator<Node | "NotRValueButFnParam"> {
  if (Node.isPropertyAccessExpression(allowedLValue)) {

    /* If we have nested property access (e.g. `a.b.c.d`, as compared to `a.b`),
    reduce that down to `a.b`. This will sometimes yield false positives though. */
    const firstDot = allowedLValue.getFirstDescendantByKindOrThrow(SyntaxKind.DotToken, "Expected a dot token!");
    const firstPropertyAccess = firstDot.getParentOrThrow("Expected a parent to the dot token!");
    const leftmostObject = firstPropertyAccess.getChildAtIndex(0), firstPropField = firstPropertyAccess.getChildAtIndex(2);

    yield* implGetAssignmentsToLValue(leftmostObject, (rhsAssignment) => {
      if (Node.isObjectLiteralExpression(rhsAssignment)) {
        const propName = firstPropField.getText();
        const result = rhsAssignment.getProperty(propName);
        if (result === Nothing) debugLog(`No property found with this name: '${propName}'`);
        return result;
      }
      else {
        return rhsAssignment;
      }
    });
  }
  else if (Node.isElementAccessExpression(allowedLValue)) {
    // TODO: should I do a similar reduction here?
    const leftmostObject = reduceNodeToLeftmostLeaf(allowedLValue);
    yield* implGetAssignmentsToLValue(leftmostObject, (rhsAssignment) => rhsAssignment);
  }

  yield* implGetAssignmentsToLValue(allowedLValue, (rhsAssignment) => rhsAssignment);
}

function checkCallForInjection(callParam: Node): Maybe<ErrorMessageIdWithFormatData> {
  /*
  A literal-reducible value is either a literal value, or a variable that reduces down to a literal value.
  Some examples of literal values would be literal strings, literal numbers, bigints, enums, etc. Acronym: LR.
  The main query parameter is implicitly assumed to be a string, though.

  Here's what's allowed for SQL string parameters (from a supported callsite):
    1. LR
    2. LRs concatenated with other LRs
    3. Variables that reduce down to LRs concatenated with other LRSs

  A LR-value is not flagged for SQL injection, since injection would typically
  happen in a case where you take some other non-literal datatype, cast it to a string,
  and then concatenate that with a SQL query string. As long as the final value passed to the
  callsite is only built up from literal strings at its core, then the final string should be okay.
  */

  /*
  If the node doesn't exist in `nodeLRStates`, it hasn't been explored yet.
  If its value is false, it's not LR. If its value is true, it's LR, or currently being
  computed (which can indicate the existence of a reference cycle).

  Also, it's worthy of noting that I'm not doing this state caching
  for the sake of efficiency: it's just so that reference cycles won't result
  in infinite recursion.

  Also note that errors may be falsely reported if you first make a raw query string, use that in a query,
  and then assign that string to a non-LR value after. In most cases, that post-assigned value will
  not affect the query, but if you are in a loop and the query string is defined in an outer
  scope, the next loop iteration may then receive that non-LR value, which would qualify as a SQL injection.

  This is only for declarations, and not assignments; doing a raw query with some LR value,
  and then declaring a variable with the same name, is an error (due to variable hoisting).
  It would not be an error with `var` (since you can use variables defined with `var` before
  they are declared), but that is a practical error that this linter plugin is not expected to pick up on.
  */

  const nodeLRStates: Map<Node, boolean> = new Map();
  const rootProblemNodes: Set<Node> = new Set();

  enum ScopeAssignmentCategory {
    NotAssignedToInScope,
    AssignedToNonLRValue,
    OnlyAssignedToLRValues
  }

  function getLValueAssignmentCategory(allowedLValue: AllowedLValue): ScopeAssignmentCategory {
    let foundAssignedThing = false;

    for (const thingAssigned of getAssignmentsToLValue(allowedLValue)) {
      foundAssignedThing = true;

      // If it's not a function param, it's an rvalue expression
      const isParam = (thingAssigned === "NotRValueButFnParam");

      if (isParam) rootProblemNodes.add(allowedLValue);
      if (isParam || !isLR(thingAssigned)) return ScopeAssignmentCategory.AssignedToNonLRValue;
    }

    return foundAssignedThing ? ScopeAssignmentCategory.OnlyAssignedToLRValues : ScopeAssignmentCategory.NotAssignedToInScope;
  }

  function isLRWithoutStateCache(node: Node): boolean {
    ////////// This part concerns the most primitive types of values

    /* The `isLiteral` here does not cover all literal types; it only does booleans,
    bigints, enums, numbers, and strings (and no-substitution template literals), I think. */
    if (node.getType().isLiteral() || Node.isNullLiteral(node) || Node.isRegularExpressionLiteral(node)
      || Node.isFunctionDeclaration(node) || Node.isFunctionExpression(node) || Node.isArrowFunction(node)
      || Node.isClassDeclaration(node) || Node.isClassExpression(node)) {

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
    else if (isAllowedLValue(node)) {
      switch (getLValueAssignmentCategory(node)) {
        // Failing silently when there's nothing assigned to a value (the compiler will take care of this error)
        case ScopeAssignmentCategory.NotAssignedToInScope:
          debugLog(`Never assigned to: '${node.getText()}'`);
          return true;
        case ScopeAssignmentCategory.AssignedToNonLRValue:
          return false;
        case ScopeAssignmentCategory.OnlyAssignedToLRValues:
          return true;
      }
    }

    ////////// This part concerns simple expressions wrapped in other expressions

    else if (Node.isBinaryExpression(node)) {
      return isLR(node.getLeft()) && isLR(node.getRight());
    }
    else if (Node.isParenthesizedExpression(node)) {
      return isLR(unpackParenthesizedExpression(node));
    }
    else if (Node.isConditionalExpression(node)) {
      return isLR(node.getWhenTrue()) && isLR(node.getWhenFalse());
    }
    else if (Node.isArrayLiteralExpression(node)) {
      return node.getElements().every(isLR);
    }

    ////////// This part concerns object access

    else if (Node.isObjectLiteralExpression(node)) {
      return node.getProperties().every(isLR);
    }
    else if (Node.isPropertyAssignment(node)) {
      const initializer = node.getInitializer();
      return (initializer === Nothing) ? true : isLR(initializer);
    }
    else if (Node.isShorthandPropertyAssignment(node)) {
      const assignmentValueSymbol = node.getValueSymbol();

      // Failing if there's no assigned symbol here
      if (assignmentValueSymbol === Nothing) {
        debugLog("Expecting the assignment value symbol to have a value!");
        rootProblemNodes.add(node);
        return false;
      }

      for (const ref of getRefsToNodeOrSymbol(assignmentValueSymbol)) {
        if (ref === node) continue;

        else if (!Node.isVariableDeclaration(ref)) {
          debugLog("Unknown structure of assignment value symbol for shorthand property assignment!");
          continue;
        }

        const initializer = ref.getInitializer();
        if (initializer !== Nothing && !isLR(initializer)) return false;
      }

      debugLog(`No refs exist pointing to this shorthand property assignment: '${node.getText()}'`);
      return true;
    }
    // TODO: support spread assignments
    else if (Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node) || Node.isMethodDeclaration(node)) {
      return true;
    }
    else {
      rootProblemNodes.add(node);
      return false;
    }
  }

  ////////// This is the LR-state-caching code

  function isLR(node: Node): boolean {
    const maybeState = nodeLRStates.get(node);

    if (maybeState !== Nothing) {
      return maybeState;
    }
    else {
      // Ending up in a cycle (e.g. from `z = z + "foo";`) will mark the node as LR
      nodeLRStates.set(node, true);
      const wasLR = isLRWithoutStateCache(node);
      nodeLRStates.set(node, wasLR);
      return wasLR;
    }
  }

  if (!isLR(callParam)) {
    if (rootProblemNodes.size !== 1) {
      panic(`There's a strict requirement of 1 root problem node during failure! Got ${rootProblemNodes.size}.`);
    }

    const discoveredNode = Array.from(rootProblemNodes)[0];

    return ["sqlInjection", {
      lineNumber: getNodePosInFile(discoveredNode).line,
      theExpression: discoveredNode.getText()
    }];
  }
}

// If it's a raw SQL injection callsite, then this returns the argument to examine.
function maybeGetArgFromRawSqlCallSite(callExpr: CallExpression): Maybe<Node> {
  const callExprWithoutParams = callExpr.getExpression();
  const args = callExpr.getArguments();

  // Need the first argument, which is the query string
  if (args.length === 0) return;

  // `client.<callName>`, or `ctxt.client.<callName>`, and so on with the prefixes
  const identifiers = callExprWithoutParams.getDescendantsOfKind(SyntaxKind.Identifier);

  if (identifiers.length <= 1) {
    debugLog(`Cannot recognize a raw SQL call from this here: '${callExpr.getText()}'`);
    return;
  }

  const identifierTypeNames = identifiers.map(getTypeName);
  const expectedClient = identifierTypeNames[identifierTypeNames.length - 2];
  const callNames = ormClientInfoForRawSqlQueries.get(expectedClient);

  if (callNames === Nothing) {
    debugLog(`Unrecognized database client: '${expectedClient}'`);
    return;
  }

  const expectedRawQueryCall = identifiers[identifiers.length - 1].getText();

  if (callNames.includes(expectedRawQueryCall)) {
    return args[0];
  }
}

const isSqlInjection: ErrorChecker = (node, _fnDecl, _isLocal) => {
  if (Node.isCallExpression(node)) {
    const maybeArg = maybeGetArgFromRawSqlCallSite(node);

    if (maybeArg !== Nothing) {
      return checkCallForInjection(maybeArg);
    }
  }
}

////////// This code is for detecting useless/malformed transactions

/* Note: this may result in false negatives for nested closures that capture the transaction context's client,
and when you call helper functions that you pass the context object to, but that helper function does nothing. */
const transactionIsMalformed: ErrorChecker = (node, fnDecl, _isLocal) => {
  if (node !== fnDecl) return; // Only analyze the whole function

  ////////// Step 1: check if the transaction has no parameters

  const params = fnDecl.getParameters();
  if (params.length === 0) return "transactionHasNoParameters";

  ////////// Step 2: check if the transaction context has no type arguments

  const transactionContext = params[0];
  const typeArgs = transactionContext.getType().getTypeArguments();
  if (typeArgs.length === 0) return "transactionContextHasNoTypeArguments";

  ////////// Step 3: check if the database client used is unrecognized

  const clientType = getTypeName(typeArgs[0]);

  if (!ormClientInfoForRawSqlQueries.has(clientType)) {
    return ["transactionContextHasInvalidClientType", {clientType: clientType}];
  }

  ////////// Step 4: check if the transaction context is never used

  const transactionContextSymbol = getSymbol(transactionContext);

  if (transactionContextSymbol === Nothing) {
    debugLog("No symbol was ever found for the transaction context!");
    return; // No symbol for the first param -> should not analyze
  }

  let foundDatabaseUsage = false;

  for (const ref of getRefsToNodeOrSymbol(transactionContextSymbol)) {
    if (ref === transactionContext) continue;

    const parent = ref.getParentOrThrow("Expected a parent node to exist!");

    if (Node.isPropertyAccessExpression(parent) && parent.getChildCount() >= 3) {
      const left = parent.getChildAtIndex(0), right = parent.getChildAtIndex(2);

      // If we find a direct usage of `ctxt.client`
      if (getSymbol(left) === transactionContextSymbol && right.getText() === "client") {
        foundDatabaseUsage = true;
        break;
      }
    }
    else {
      const parentCall = ref.getFirstAncestorByKind(SyntaxKind.CallExpression);
      if (parentCall === Nothing) continue;

      // If we call a helper function that is passed our transaction context (TODO: limit this to just other transactions)
      if (parentCall.getArguments().some((arg) => getSymbol(arg) === transactionContextSymbol)) {
        foundDatabaseUsage = true;
        break;
      }
    }
  }

  if (!foundDatabaseUsage) return "transactionDoesntUseTheDatabase";
};

////////// This is the main function that recurs on the `ts-morph` AST

/*
First field: a set of method decorators to match on (if `Nothing`, then match on everything).
Second field: a list of error checkers to run.
*/
const decoratorSetErrorCheckerMapping: [Maybe<Set<string>>, ErrorChecker[]][] = [
  [new Set(["Transaction"]), [isSqlInjection, transactionIsMalformed]], // Checking for SQL injection and malformed transactions here
  [new Set(["Workflow"]), [mutatesGlobalVariable, callsBannedFunction, awaitsOnNotAllowedType]] // Checking for nondeterminism here
];

function runErrorCheckers(node: Node, fnDecl: FnDecl, isLocal: (symbol: Symbol) => boolean) {
  for (const [decoratorSet, errorCheckers] of decoratorSetErrorCheckerMapping) {
    if ((decoratorSet === Nothing || functionHasDecoratorInSet(fnDecl, decoratorSet))) {

      for (const errorChecker of errorCheckers) {
        const response = errorChecker(node, fnDecl, isLocal);

        if (response !== Nothing) {
          const [messageId, formatData] = typeof response === "string" ? [response, {}] : response;
          GLOBAL_TOOLS!.eslintContext.report({ node: makeEslintNode(node), messageId: messageId, data: formatData });
        }
      }
    }
  }
}

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

  // Run the error checkers over the fn decl itself as well
  runErrorCheckers(fnDecl, fnDecl, isLocal);

  function analyzeFrame(node: Node) {
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
      const symbol = getSymbol(node);
      if (symbol !== Nothing) getCurrentFrame().add(symbol);
    }
    else {
      runErrorCheckers(node, fnDecl, isLocal);
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

// This is just for making sure that the unit tests are well constructed (not used when deployed)
function checkDiagnostics(node: Node) {
  const project = new Project({});

  const eslintNodeCode = node.getFullText();
  project.createSourceFile("temp.ts", eslintNodeCode, { overwrite: true });
  const diagnostics = project.getPreEmitDiagnostics();

  if (diagnostics.length !== 0) {
    const formatted = diagnostics.map((diagnostic) =>
      `Diagnostic at line ${diagnostic.getLineNumber()}: ${JSON.stringify(diagnostic.getMessageText())}.\n---\n`
    ).join("\n");

    panic(formatted);
  }
}

function buildSymRefMap(root: Node): Map<Symbol, Node[]> {
  let map = new Map<Symbol, Node[]>();

  root.forEachDescendant((descendant) => {
    // Not using the wrapping `getSymbol` here to avoid errors
    const symbol = descendant.getSymbol();
    if (symbol === Nothing) return;

    const refList = map.get(symbol);
    if (refList === Nothing) map.set(symbol, ([descendant]));
    else refList.push(descendant);
  });

  return map;
}

function analyzeRootNode(eslintNode: EslintNode, eslintContext: EslintContext) {
  const parserServices = ESLintUtils.getParserServices(eslintContext, false);

  GLOBAL_TOOLS = {
    eslintContext: eslintContext,
    rootEslintNode: eslintNode,
    parserServices: parserServices,
    typeChecker: parserServices.program.getTypeChecker(),
    symRefMap: new Map()
  };

  const tsMorphNode = makeTsMorphNode(eslintNode);
  if (testValidityOfTestsLocally) checkDiagnostics(tsMorphNode);

  GLOBAL_TOOLS!.symRefMap = buildSymRefMap(tsMorphNode);

  try {
    if (Node.isStatemented(tsMorphNode)) {
      // TODO: just analyze the statements instead
      tsMorphNode.getFunctions().forEach(analyzeFunction);
      tsMorphNode.getClasses().forEach(analyzeClass);
    }
    else {
      const dependencyMessage = "This may be due to a dependency issue; make sure that the same version of typescript-eslint is being used everywhere.";
      panic(`Was expecting a statemented root node! Got this kind instead: ${tsMorphNode.getKindName()}. ${dependencyMessage}\n`);
    }
  }
  finally {
    // Not keeping the tools around after being done with them
    GLOBAL_TOOLS = Nothing;
  }
}

/*
- Take a look at these functions later on:
isArrowFunction, isFunctionExpression, isObjectBindingPattern, isPropertyAssignment,
isQualifiedName, isVariableDeclarationList, isUpdateExpression

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

const createRule = ESLintUtils.RuleCreator((_) => "https://docs.dbos.dev/api-reference/static-analysis");

export const dbosStaticAnalysisRule = createRule({
  create: (context: EslintContext) => {
    // panic(`Parser path: ${context.parserPath}`);

    return {
      /* Note: I am working with ts-morph because it has
      stronger typing, and it's easier to work with the AST
      than ESTree's limited tree navigation. */
      Program(node: EslintNode) {
        analyzeRootNode(node, context);
      }
    }
  },

  name: "dbos-static-analysis",

  meta: {
    schema: [],
    type: "suggestion",
    docs: { description: "Analyze DBOS applications to make sure they run reliably (e.g. determinism checking, SQL injection detection, etc..." },
    messages: Object.fromEntries(errorMessages)
  },

  defaultOptions: []
});

const packageJsonPrefix = (path.basename(process.cwd()) === "eslint-plugin") ? "" : "../";
const packageJsonPath = path.join(__dirname, packageJsonPrefix, "package.json");
const packageJsonInfo = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

module.exports = {
  meta: {
    name: packageJsonInfo.name,
    version: packageJsonInfo.version
  },

  rules: { "dbos-static-analysis": dbosStaticAnalysisRule },

  plugins: {
    "@typescript-eslint": tslintPlugin,

    // Should I find TypeScript variants of these?
    "security": require("eslint-plugin-security"),
    "no-secrets": require("eslint-plugin-no-secrets")
  },

  configs: {
    dbosBaseConfig: recConfig, // This is deprecated!
    dbosRecommendedConfig: recConfig,
    dbosExtendedConfig: recConfig // This is deprecated!
  }
};
