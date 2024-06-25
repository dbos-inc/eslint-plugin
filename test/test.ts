import { after as mochaAfter } from "mocha"; // TODO: switch to `jest` or `vitest`
import { RuleTester } from "@typescript-eslint/rule-tester";
const rulesUnderTest = require("../dist/src/dbos-rules.js"); // TODO: import my rules normally

RuleTester.afterAll = mochaAfter;

//////////

// https://stackoverflow.com/questions/51851677/how-to-get-argument-types-from-function-in-typescript
type ArgumentTypes<F extends Function> = F extends (...args: infer A) => any ? A : never;

type TestTypes = ArgumentTypes<typeof tester.run>[2];
type ValidTests = TestTypes["valid"];
type InvalidTests = TestTypes["invalid"];

type TestSet = [string, ValidTests, InvalidTests][];

function doTest(title: string, valid: ValidTests, invalid: InvalidTests) {
  const ruleName = "unexpected-nondeterminism";
  tester.run(title, rulesUnderTest.rules[ruleName], { valid: valid, invalid: invalid });
}

//////////

const tester = new RuleTester({
  parser: "@typescript-eslint/parser",
  parserOptions: { project: "tsconfig.json" },
  defaultFilenames: { ts: "test/test.ts", tsx: "test/this_file_doesnt_exist.tsx" }
});

function makeExpectedDetCode(code: string, params: string = "", aboveClass: string = ""): string {
  return `
    ${aboveClass}
    class Foo {
      @Workflow
      bar(${params}) {
        ${code}
      }
    }
  `;
}

// TODO: give this a better return type
function makeCaseForModification(numErrors: number, code: string): any {
  return { code: code, errors: Array(numErrors).fill({ messageId: "globalModification" }) };
}

// TODO: this too
function makeCaseForOkayCall(call: string): any {
  return { code: makeExpectedDetCode(`const x = ${call};`) };
}

// TODO: this too
function makeCaseForBannedCall(prefix: string, functionName: string, params: string): any {
  return { code: makeExpectedDetCode(`const x = ${prefix} ${functionName}(${params});`), errors: [{ messageId: functionName }] }
}

function makeCaseForOkayAwaitCall(params: string, awaitedUpon: string): any {
  const code = makeExpectedDetCode(`const x = await ${awaitedUpon};`, params, "class WorkflowContext {}");
  return { code: code };
}

// TODO: this too
function makeCaseForBannedAwaitCall(params: string, awaitedUpon: string): any {
  const code = makeExpectedDetCode(`const x = await ${awaitedUpon};`, params, "class FooBar {}");
  return { code: code, errors: [{ messageId: "awaitingOnNotAllowedType" }]};
}

const testSet: TestSet = [
  ["global modifications", [], [makeCaseForModification(5,
`
let x = 3;
let y = {a: 1, b: 2};

class Foo {
  @Workflow
  foo() {
    x = 4; // Not allowed
    y.a += 1; // Not allowed

    let y = {a: 3, b: 4}; // Aliases the global 'y'
    y.a = 1; // Not a global modification anymore
  }

  bar() {
    y.b += 2;
    let z = 8;

    class Bar {
      @Workflow
      w() {
        z = 9; // Not allowed
      }
    }
  }

  @Workflow
  baz() {
    x *= 5; // Not allowed
    y.b += y.a; // Not allowed

    function bazbaz() {
      x -= 6;
      y.b += y.a;
    }
  }
}`)]
  ],

  ["banned/not banned functions",
    [
      makeCaseForOkayCall("foo()"),
      makeCaseForOkayCall("Date('December 17, 1995 03:24:00')"),
      makeCaseForOkayCall("new Date('December 17, 1995 03:24:00')")
    ],

    [
      makeCaseForBannedCall("", "Date", ""),
      makeCaseForBannedCall("new", "Date", ""),
      makeCaseForBannedCall("", "Math.random", ""),
      makeCaseForBannedCall("", "setTimeout", "a, b"),
      makeCaseForBannedCall("", "bcrypt.hash", "a, b, c"),
      makeCaseForBannedCall("", "bcrypt.compare", "a, b, c")
    ]
  ],

  ["allowed/not allowed awaits",
    [
      makeCaseForOkayAwaitCall("ctxt: WorkflowContext", "({}).foo()"), // TODO: probably make this not allowed
      makeCaseForOkayAwaitCall("ctxt: WorkflowContext", "ctxt.foo()"),
      makeCaseForOkayAwaitCall("ctxt: WorkflowContext", "ctxt.invoke(ShopUtilities).retrieveOrder(order_id)"),
      makeCaseForOkayAwaitCall("ctxt: WorkflowContext", "ctxt.client<User>('users').select('password').where({ username }).first();")
    ],

    [
      makeCaseForBannedAwaitCall("", "fetch('https://www.google.com')"),
      makeCaseForBannedAwaitCall("ctxt: FooBar", "ctxt.foo()"),
      makeCaseForBannedAwaitCall("ctxt: FooBar", "ctxt.invoke(ShopUtilities).retrieveOrder(order_id)"),
      makeCaseForBannedAwaitCall("ctxt: FooBar", "ctxt.client<User>('users').select('password').where({ username }).first();")
    ]
  ]
];

testSet.forEach((test) => doTest(...test));

// TODO: test the 1 other await case
