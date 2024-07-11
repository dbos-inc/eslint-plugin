import * as vitest from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { dbosRulesPerName } from "./dbos-rules";

RuleTester.it = vitest.it;
RuleTester.itOnly = vitest.it.only;
RuleTester.describe = vitest.describe;
RuleTester.afterAll = vitest.afterAll;

//////////

// https://stackoverflow.com/questions/51851677/how-to-get-argument-types-from-function-in-typescript
type ArgumentTypes<F extends Function> = F extends (...args: infer A) => any ? A : never;

// https://stackoverflow.com/questions/41253310/typescript-retrieve-element-type-information-from-array-type
type ArrayElementType<ArrayType extends readonly unknown[]> = ArrayType extends readonly (infer T)[] ? T : never;

type TestTypes = ArgumentTypes<typeof tester.run>[2];
type SuccessTests = TestTypes["valid"];
type FailureTests = TestTypes["invalid"];

type TestSet = [string, SuccessTests, FailureTests][];
type SuccessTest = ArrayElementType<SuccessTests>;
type FailureTest = ArrayElementType<FailureTests>;

function doTest(title: string, successTests: SuccessTests, failureTests: FailureTests) {
  const ruleName = "dbos-static-analysis";
  tester.run(title, dbosRulesPerName[ruleName], { valid: successTests, invalid: failureTests });
}

//////////

const tester = new RuleTester({
  parser: "@typescript-eslint/parser",
  parserOptions: { project: "tsconfig.json" },
  defaultFilenames: { ts: "dbos-rules.test.ts", tsx: "this_file_doesnt_exist.tsx" }
});

////////// These functions build different types of test cases with some primitive code structure around them.

function makeExpectedDetCode(
  code: string,
  codeAboveClass: string,
  enclosingFunctionParams: string): string {

  return `
    ${codeAboveClass}

    class Foo {
      @Workflow()
      foo(${enclosingFunctionParams}) {
        ${code}
      }
    }
  `;
}

function makeSqlInjectionCode(code: string): string {
  return `
    class UserDatabaseClient {}
    class DBOSContext {}

    class Knex {
      raw(x: string) {

      }
    }

    export interface TransactionContext<T extends UserDatabaseClient> extends DBOSContext {
      readonly client: T;
    }

    class Foo {
      @Transaction()
      injectionTime(ctxt: TransactionContext<Knex>) {
        ${code}
      }
    }
  `;
}

function makeExpectedDetSuccessTest(code: string,
  { codeAboveClass, enclosingFunctionParams } = { codeAboveClass: "", enclosingFunctionParams: "" }): SuccessTest {

  return { code: makeExpectedDetCode(code, codeAboveClass, enclosingFunctionParams) };
}

function makeExpectedDetFailureTest(code: string, expectedErrorIds: string[],
  { codeAboveClass, enclosingFunctionParams } = { codeAboveClass: "", enclosingFunctionParams: "" }): FailureTest {

  const inObjectFormat = expectedErrorIds.map((id) => { return { messageId: id }; });
  return { code: makeExpectedDetCode(code, codeAboveClass, enclosingFunctionParams), errors: inObjectFormat };
}

function makeExpectedSqlInjectionSuccessTest(code: string): SuccessTest {
  return { code: makeSqlInjectionCode(code) };
}

function makeExpectedSqlInjectionFailureTest(code: string, expectedErrorIds: string[]): FailureTest {
  const inObjectFormat = expectedErrorIds.map((id) => { return { messageId: id }; });
  return { code: makeSqlInjectionCode(code), errors: inObjectFormat };
}

//////////

// TODO: for the sake of testing the tests' soundness, check diagnostic warnings for these
const testSet: TestSet = [
  ["sql injection",
    /* TODO: streamline these success tests more (less
    repetition, and more distinct meaning per every test),
    and use more consts */

    [
      // Success test #1
      makeExpectedSqlInjectionSuccessTest(`
        const foo = "xyz", bar = "xyw";
        ctxt.client.raw(foo);
        ctxt.client.raw(bar);

        // Literal concatenation is allowed
        ctxt.client.raw("foo" + "bar" + "baz" + "bam");

        // And concatenation with other reduced-to literals is allowed
        ctxt.client.raw("foo" + "bar" + "baz" + "bam" + foo);
      `),

      // Success test #2
      makeExpectedSqlInjectionSuccessTest(`
        let x, y, z;

        x = "fox" + "fob";
        y = x;
        z = y;

        ctxt.client.raw(x);
        ctxt.client.raw(y);
        ctxt.client.raw(y);
        ctxt.client.raw(z); // This traces from z to y to x to "fox + fob"
      `),

      // Success test #3
      makeExpectedSqlInjectionSuccessTest(`
        let y = "abc";
        y = "fox";
        y = "foy" + "fob";
        y = "foz" + "fob";
        y = "fox";
        ctxt.client.raw(y);
        ctxt.client.raw(y);
        ctxt.client.raw(y);
      `),

      // Success test #4
      makeExpectedSqlInjectionSuccessTest(`
        ctxt.client.raw("bob");
        ctxt.client.raw("bob" + "ba");
        ctxt.client.raw("bob" + "ba");
        ctxt.client.raw("bob" + "ba");

        const x = "foo";
        ctxt.client.raw(x);

        let z = "aha", y = "baha";

        {
          y = "fox";
          y = "foy" + "fob";
          y = "foz" + "fob";
          y = "fox";
          ctxt.client.raw(y);
          ctxt.client.raw(y);
        }
        ctxt.client.raw(y);
      `),

      // Success test #5
      makeExpectedSqlInjectionSuccessTest(`
        let foo = "xyz" + "zyw";
        foo = "xyz" + "zyw";
        foo = foo + foo, bar = "def" + foo;

        ctxt.client.raw(foo);
        ctxt.client.raw(foo);
        ctxt.client.raw(bar);
      `),

      // Success test #6
      makeExpectedSqlInjectionSuccessTest(`
        let foo = foo + "xyz"; // Partially invalid code, but just testing circular reference detection
        let bar = "xyz" + "zyw" + foo; // The same here

        ctxt.client.raw(foo);
        ctxt.client.raw(bar);

        let baz = bar + num.toString();
      `),

      // Success test #7
      makeExpectedSqlInjectionSuccessTest(`
        let x = "foo", y = "bar" + x + x;
        ctxt.client.raw(x);
        ctxt.client.raw(y);
      `),

      // Success test #8
      makeExpectedSqlInjectionSuccessTest(`
        let x = "foo", y = "bar";

        let z = x + y; // Concatenating two literals is allowed
        ctxt.client.raw(z);

        z = z + "foo";
        ctxt.client.raw(z);
      `),

      // Success test #9
      makeExpectedSqlInjectionSuccessTest(`
        let foo = "xyz", bar = "zyw";
        ctxt.client.raw(foo + foo + foo + bar + baz + "foo" + "bar");

        let baz = foo + foo + foo + bar + baz + "foo" + "bar";
        ctxt.client.raw(baz);

        let x = "foo";
        let y = "bar";
        let x = y, y = x;
        ctxt.client.raw(x + y);
      `),
    ],

    [
      makeExpectedSqlInjectionFailureTest(`

        let bam = foo + foo + foo + bar + baz + "foo" + "bar", num = 5;
        ctxt.client.raw(bam + num.toString()); // Concatenating a literal-reducible string with one that is not

        let asVar = bam + num.toString();
        ctxt.client.raw(asVar);
      `,
        Array(2).fill("sqlInjection")
      )
    ]
  ],

  ["global mutations", [],

    [makeExpectedDetFailureTest(
      `
      let x = 3;
      let y = {a: 1, b: 2};
      let z = 256;

      class Bar {
        @Workflow()
        foo() {
          x = 4; // Not allowed
          this.x = 4; // Allowed
          y.a += 1; // Not allowed

          z = [y, y = z][0]; // Not allowed (this is a funky variable swap)

          x = 23 + x, y.a = 24 + x; // Two global modifications, so not allowed

          let x = 5; // x is now local
          x = 23 + x, y.a = 24 + x; // One local, one global (the right one is not allowed)
          y.a = 23 + x, x = 24 + x; // One global, one local (the left one is not allowed)

          let y = {a: 3, b: 4}; // Aliases the global 'y'
          y.a = 1; // Not a global modification anymore
        }

        bar() {
          y.b += 2;
          let z = 8;

          class Bar {
            @Workflow()
            w() {
              z = 9; // Not allowed
            }
          }
        }

        @Workflow()
        baz() {
          x *= 5; // Not allowed
          y.b += y.a; // Not allowed

          function bazbaz() {
            x -= 6;
            y.b += y.a;
          }
        }
      }`,
      Array(11).fill("globalModification")
    )]
  ],

  ["banned/not banned functions",
    [
      makeExpectedDetSuccessTest("foo();"), // Calling these `Date` variants is allowed
      makeExpectedDetSuccessTest("Date('December 17, 1995 03:24:00');"),
      makeExpectedDetSuccessTest("new Date('December 17, 1995 03:24:00');")
    ],

    [
      /* The secondary args here are the expected error
      IDs (which line up with the banned functions tested) */
      makeExpectedDetFailureTest("Date();", ["Date"]),
      makeExpectedDetFailureTest("new Date();", ["Date"]),
      makeExpectedDetFailureTest("Math.random();", ["Math.random"]),
      makeExpectedDetFailureTest("console.log(\"Hello!\");", ["console.log"]),
      makeExpectedDetFailureTest("setTimeout(a, b);", ["setTimeout"]),
      makeExpectedDetFailureTest("bcrypt.hash(a, b, c);", ["bcrypt.hash"]),
      makeExpectedDetFailureTest("bcrypt.compare(a, b, c);", ["bcrypt.compare"])
    ]
  ],

  ["allowed/not allowed awaits",
    [

      makeExpectedDetSuccessTest("await ({}).foo();"), // TODO: probably make this not allowed
      makeExpectedDetSuccessTest("await new Set();"), // TODO: definitely make this not allowed

      // Awaiting on a method with a leftmost `WorkflowContext`, #1
      makeExpectedDetSuccessTest(
        "await ctxt.foo();",
        { codeAboveClass: "class WorkflowContext {}", enclosingFunctionParams: "ctxt: WorkflowContext" }
      ),

      // Awaiting on a method with a leftmost `WorkflowContext`, #2
      makeExpectedDetSuccessTest(
        "await ctxt.invoke(ShopUtilities).retrieveOrder(order_id);",
        { codeAboveClass: "class WorkflowContext {}", enclosingFunctionParams: "ctxt: WorkflowContext" }
      ),

      // Awaiting on a method with a leftmost `WorkflowContext`, #3
      makeExpectedDetSuccessTest(
        "await ctxt.client<User>('users').select('password').where({ username }).first();",
        { codeAboveClass: "class WorkflowContext {}", enclosingFunctionParams: "ctxt: WorkflowContext" }
      ),

      // Awaiting on a leftmost non-`WorkflowContext` type, but you pass a `WorkflowContext` in
      makeExpectedDetSuccessTest(
        `
        async function workflowHelperFunction(ctxt: WorkflowContext) {
          return await ctxt.baz();
        }

        await workflowHelperFunction(ctxt);
        `,
        { codeAboveClass: "class WorkflowContext {}", enclosingFunctionParams: "ctxt: WorkflowContext" }
      )
    ],

    [
      // Awaiting on a not-allowed function, #1
      makeExpectedDetFailureTest("await fetch('https://www.google.com');", ["awaitingOnNotAllowedType"]),

      // Awaiting on a not-allowed function, #2
      makeExpectedDetFailureTest(`
        async function foo() {
          return 5;
        }

        await foo();
        `,
        ["awaitingOnNotAllowedType"]
      ),

      // Awaiting on a not-allowed class, #1
      makeExpectedDetFailureTest(
        "const x = new Set(); await x.foo();",
        ["awaitingOnNotAllowedType"]
      ),

      // Awaiting on a not-allowed class, #2
      makeExpectedDetFailureTest(
        "await fooBar.foo();",
        ["awaitingOnNotAllowedType"],
        { codeAboveClass: "class FooBar {}", enclosingFunctionParams: "fooBar: FooBar" }
      ),

      // Awaiting on a not-allowed class, #3
      makeExpectedDetFailureTest(
        "await fooBar.invoke(ShopUtilities).retrieveOrder(order_id);",
        ["awaitingOnNotAllowedType"],
        { codeAboveClass: "class FooBar {}", enclosingFunctionParams: "fooBar: FooBar" }
      ),

      // Awaiting on a not-allowed class, #4
      makeExpectedDetFailureTest(
        "await fooBar.client<User>('users').select('password').where({ username }).first();",
        ["awaitingOnNotAllowedType"],
        { codeAboveClass: "class FooBar {}", enclosingFunctionParams: "fooBar: FooBar" }
      )
    ]
  ]
];

testSet.forEach((test) => doTest(...test));
