import * as vitest from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
const rulesUnderTest = require("../dist/src/dbos-rules.js"); // TODO: import my rules normally (and no `tsc` before the test too)

RuleTester.afterAll = vitest.afterAll;
RuleTester.it = vitest.it;
RuleTester.itOnly = vitest.it.only;
RuleTester.describe = vitest.describe;

//////////

// https://stackoverflow.com/questions/51851677/how-to-get-argument-types-from-function-in-typescript
type ArgumentTypes<F extends Function> = F extends (...args: infer A) => any ? A : never;

// https://stackoverflow.com/questions/41253310/typescript-retrieve-element-type-information-from-array-type
type ArrayElementType<ArrayType extends readonly unknown[]> = ArrayType extends readonly (infer T)[] ? T : never;

type TestTypes = ArgumentTypes<typeof tester.run>[2];
type ValidTests = TestTypes["valid"];
type InvalidTests = TestTypes["invalid"];

type TestSet = [string, ValidTests, InvalidTests][];
type ValidTest = ArrayElementType<ValidTests>;
type InvalidTest = ArrayElementType<InvalidTests>;

function doTest(title: string, valid: ValidTests, invalid: InvalidTests) {
  const ruleName = "unexpected-nondeterminism";
  tester.run(title, rulesUnderTest.rules[ruleName], { valid: valid, invalid: invalid });
}

//////////

const tester = new RuleTester({
  parser: "@typescript-eslint/parser",
  parserOptions: { project: "tsconfig.json" },
  defaultFilenames: { ts: "test/dbos-rules.test.ts", tsx: "test/this_file_doesnt_exist.tsx" }
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

function makeCaseForModification(numErrors: number, code: string): InvalidTest {
  return { code: code, errors: Array(numErrors).fill({ messageId: "globalModification" }) };
}

function makeCaseForOkayCall(call: string): ValidTest {
  return { code: makeExpectedDetCode(`const x = ${call};`) };
}

function makeCaseForBannedCall(prefix: string, functionName: string, params: string): InvalidTest {
  return { code: makeExpectedDetCode(`const x = ${prefix} ${functionName}(${params});`), errors: [{ messageId: functionName }] }
}

function makeCaseForOkayAwaitCall(params: string, awaitedUpon: string): ValidTest {
  return { code: makeExpectedDetCode(`const x = await ${awaitedUpon};`, params, "class WorkflowContext {}") };
}

function makeCaseForBannedAwaitCall(params: string, awaitedUpon: string): InvalidTest {
  const code = makeExpectedDetCode(`const x = await ${awaitedUpon};`, params, "class FooBar {}");
  return { code: code, errors: [{ messageId: "awaitingOnNotAllowedType" }] };
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
      makeCaseForOkayAwaitCall("", "new Set()"), // TODO: definitely make this not allowed
      makeCaseForOkayAwaitCall("", "({}).foo()"), // TODO: probably make this not allowed

      // When you don't await on a `WorkflowContext`, but you pass a param into the function you're calling, it's okay
      makeCaseForOkayAwaitCall("ctxt: WorkflowContext", "foo(ctxt); async function foo(bar: WorkflowContext) {return bar.baz();} "),

      makeCaseForOkayAwaitCall("ctxt: WorkflowContext", "ctxt.foo()"),
      makeCaseForOkayAwaitCall("ctxt: WorkflowContext", "ctxt.invoke(ShopUtilities).retrieveOrder(order_id)"),
      makeCaseForOkayAwaitCall("ctxt: WorkflowContext", "ctxt.client<User>('users').select('password').where({ username }).first();")
    ],

    [
      makeCaseForBannedAwaitCall("", "fetch('https://www.google.com')"),
      makeCaseForBannedAwaitCall("", "foo(); async function foo() {return 5;} "),
      makeCaseForBannedAwaitCall("ctxt: FooBar", "ctxt.foo()"),
      makeCaseForBannedAwaitCall("ctxt: FooBar", "ctxt.invoke(ShopUtilities).retrieveOrder(order_id)"),
      makeCaseForBannedAwaitCall("ctxt: FooBar", "ctxt.client<User>('users').select('password').where({ username }).first();"),
      makeCaseForBannedAwaitCall("ctxt: object", "5; const y = new Set(); await y.foo()")
    ]
  ]
];

testSet.forEach((test) => doTest(...test));
