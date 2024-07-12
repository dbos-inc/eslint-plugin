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

////////// These functions build different types of test cases with some primitive code structure around them

function makeDeterminismCode(
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
      injectionTime(ctxt: TransactionContext<Knex>, aParam: string) {
        ${code}
      }
    }
  `;
}

function errorIdsToObjectFormat(errorIds: string[]): { messageId: string }[] {
  return errorIds.map((id) => { return { messageId: id }; });
}

function makeDeterminismSuccessTest(code: string,
  { codeAboveClass, enclosingFunctionParams } = { codeAboveClass: "", enclosingFunctionParams: "" }): SuccessTest {

  return { code: makeDeterminismCode(code, codeAboveClass, enclosingFunctionParams) };
}

function makeDeterminismFailureTest(code: string, expectedErrorIds: string[],
  { codeAboveClass, enclosingFunctionParams } = { codeAboveClass: "", enclosingFunctionParams: "" }): FailureTest {

  return {
      code: makeDeterminismCode(code, codeAboveClass, enclosingFunctionParams),
      errors: errorIdsToObjectFormat(expectedErrorIds)
    };
}

function makeSqlInjectionSuccessTest(code: string): SuccessTest {
  return { code: makeSqlInjectionCode(code) };
}

function makeSqlInjectionFailureTest(code: string, expectedErrorIds: string[]): FailureTest {
  return {
      code: makeSqlInjectionCode(code),
      errors: errorIdsToObjectFormat(expectedErrorIds)
    };
}

//////////

// TODO: for the sake of testing the tests' soundness, check diagnostic warnings for these
const testSet: TestSet = [
  /* Note: the tests for SQL injection do not
  involve any actual SQL code; they just test
  for any non-LR-strings being passed to a raw SQL query callsite.
  You can find more info on LR-strings in `dbos-rules.ts`. */

  ["sql injection",
    [
      // Success test #1 (concatenation mania)
      makeSqlInjectionSuccessTest(`
        // Variables -> literals
        const foo = "xyz", bar = "xyw";
        ctxt.client.raw(foo);
        ctxt.client.raw(bar);

        // Variables -> variables -> ... -> literals

        // Literal concatenation (TODO: make adding parentheses in not fail)
        ctxt.client.raw("foo" + "bar" + "baz" + "bam");

        // Literal + variable concatenation
        ctxt.client.raw("foo" + "bar" + foo + bar + "baz" + "bam" + foo);

        // Variable + variable concatenation
        ctxt.client.raw(foo + foo + bar + foo);
      `),

      // Success test #2 (deep variable tracing)
      makeSqlInjectionSuccessTest(`
        let w, x, y, z, å = "ghi";

        w = "abc" + "def" + å;
        x = w;
        y = x;
        z = y;

        ctxt.client.raw(x);
        ctxt.client.raw(y);
        ctxt.client.raw(z);
        ctxt.client.raw(w); // This traces from w to z to y to x to "abc" + "def" + å;
      `),

      // Success test #3 (lots of variable reassignments, and repeated identical calls)
      makeSqlInjectionSuccessTest(`
        let y = "abc";
        y = "fox";
        y = "foy" + "fow";
        y = "foz" + "fow";
        y = "fox";
        ctxt.client.raw(y);
        ctxt.client.raw(y);
      `),

      // Success test #4 (messing around with scoping a bit)
      makeSqlInjectionSuccessTest(`
        let y = "abc";
        y = "foo";

        if (y === "foo") {
          y = "fox";
          y = "foy" + "foz";
          ctxt.client.raw(y);
          ctxt.client.raw(y);
        }

        {
          const y = "abc";
          ctxt.client.raw(y);
        }
      `),

      // Success test #5 (testing some reference cycle stuff)
      makeSqlInjectionSuccessTest(`
        let foo = "xyz" + "zyw" + foo; // The last concatenation is invalid, but we're just testing circular reference detection
        foo = "xyz" + "zyw";
        foo = foo + foo, bar = "def" + foo;

        ctxt.client.raw(foo);
        ctxt.client.raw(foo);
        ctxt.client.raw(bar);

        let x = "foo";
        let y = "bar";
        x = y, y = x;
        ctxt.client.raw(x + y);
      `),

      // Success test #6 (testing dependent assignment in a variable declaration list, namely for `y`'s rvalue)
      makeSqlInjectionSuccessTest(`
        const x = "foo", y = "bar" + x + x;
        ctxt.client.raw(x);
        ctxt.client.raw(y);
      `),

      // Success test #7 (testing template expression evaluation)
      makeSqlInjectionSuccessTest(`
        let foo = 'x';
        ctxt.client.raw(\`\${'305' + '2' + \`\${foo}\`} \${'abc' + 'def'} \${'512'} \${'603'} \${'712'} \${foo + foo + 'foo'}\`);
      `)
    ],

    [
      // Failure test #1 (testing lots of different types of things)
      makeSqlInjectionFailureTest(`
        const bam = foo + foo + foo + bar + baz + "foo" + "bar";
        ctxt.client.raw(bam + (5).toString()); // Concatenating a literal-reducible string with one that is not

        const asVar = bam + (5).toString();
        ctxt.client.raw(asVar);

        {
          ctxt.client.raw(asVar); // This emits an error

          // const asVar = "this one is literal";
          ctxt.client.raw(asVar); // TODO: make this not emit an error, if the aliasing is added back in above
        }

        // Testing the += operator
        let foo = "foo";
        foo += foo + foo + "bar" + (5).toString();
        ctxt.client.raw(foo);
        ctxt.client.raw(foo + "a");
        ctxt.client.raw(foo += "a");

        console.log("Hello!"); // This is allowed in a non-workflow function
      `,
        Array(7).fill("sqlInjection")
      ),

      // Failure test #2 (testing some function parameter aliasing behavior)
      makeSqlInjectionFailureTest(`
        ctxt.client.raw(aParam); // Using a function parameter for a raw call is invalid

        {
          // ctxt.client.raw(aParam);

          // Aliasing the function parameter, and making its usage valid (TODO: make this not make the statement above pass)
          const aParam = "foo";
          ctxt.client.raw(aParam);
        }

        ctxt.client.raw(aParam);
        ctxt.client.raw(aParam + (5).toString()); // This fails for two reasons (but only shows one)
        ctxt.client.raw((5).toString()); // And this fails like usual
      `,
        Array(4).fill("sqlInjection")
      ),

      // Failure test #3 (testing what happens when you call a function/method on a string)
      makeSqlInjectionFailureTest(`
        const foo = "x".to_lowercase(); // No function calls may be applied to literal strings
        const bar = baz("x");
        ctxt.client.raw(foo);
        ctxt.client.raw(bar);
      `,
        Array(2).fill("sqlInjection")
      ),

      // Failure test #4 (making sure that tagged template expressions do not work)
      makeSqlInjectionFailureTest(`
        // No tagged template expressions are allowed!
        const s = myFn\`foo \${'bar'} baz\`;
        ctxt.client.raw(s);
        `,
        Array(1).fill("sqlInjection")
      )
    ]
  ],

  ["global mutations", [],

    [makeDeterminismFailureTest(
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

          let y = {a: 3, b: 4}; // Aliases the global y
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
      makeDeterminismSuccessTest("foo();"), // Calling these `Date` variants is allowed
      makeDeterminismSuccessTest("Date('December 17, 1995 03:24:00');"),
      makeDeterminismSuccessTest("new Date('December 17, 1995 03:24:00');")
    ],

    [
      /* The secondary args here are the expected error
      IDs (which line up with the banned functions tested) */
      makeDeterminismFailureTest("Date();", ["Date"]),
      makeDeterminismFailureTest("new Date();", ["Date"]),
      makeDeterminismFailureTest("Math.random();", ["Math.random"]),
      makeDeterminismFailureTest("console.log(\"Hello!\");", ["console.log"]),
      makeDeterminismFailureTest("setTimeout(a, b);", ["setTimeout"]),
      makeDeterminismFailureTest("bcrypt.hash(a, b, c);", ["bcrypt.hash"]),
      makeDeterminismFailureTest("bcrypt.compare(a, b, c);", ["bcrypt.compare"])
    ]
  ],

  ["allowed/not allowed awaits",
    [

      makeDeterminismSuccessTest("await ({}).foo();"), // TODO: probably make this not allowed
      makeDeterminismSuccessTest("await new Set();"), // TODO: definitely make this not allowed

      // Awaiting on a method with a leftmost `WorkflowContext`, #1
      makeDeterminismSuccessTest(
        "await ctxt.foo();",
        { codeAboveClass: "class WorkflowContext {}", enclosingFunctionParams: "ctxt: WorkflowContext" }
      ),

      // Awaiting on a method with a leftmost `WorkflowContext`, #2
      makeDeterminismSuccessTest(
        "await ctxt.invoke(ShopUtilities).retrieveOrder(order_id);",
        { codeAboveClass: "class WorkflowContext {}", enclosingFunctionParams: "ctxt: WorkflowContext" }
      ),

      // Awaiting on a method with a leftmost `WorkflowContext`, #3
      makeDeterminismSuccessTest(
        "await ctxt.client<User>('users').select('password').where({ username }).first();",
        { codeAboveClass: "class WorkflowContext {}", enclosingFunctionParams: "ctxt: WorkflowContext" }
      ),

      // Awaiting on a leftmost non-`WorkflowContext` type, but you pass a `WorkflowContext` in
      makeDeterminismSuccessTest(
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
      makeDeterminismFailureTest("await fetch('https://www.google.com');", ["awaitingOnNotAllowedType"]),

      // Awaiting on a not-allowed function, #2
      makeDeterminismFailureTest(`
        async function foo() {
          return 5;
        }

        await foo();
        `,
        ["awaitingOnNotAllowedType"]
      ),

      // Awaiting on a not-allowed class, #1
      makeDeterminismFailureTest(
        "const x = new Set(); await x.foo();",
        ["awaitingOnNotAllowedType"]
      ),

      // Awaiting on a not-allowed class, #2
      makeDeterminismFailureTest(
        "await fooBar.foo();",
        ["awaitingOnNotAllowedType"],
        { codeAboveClass: "class FooBar {}", enclosingFunctionParams: "fooBar: FooBar" }
      ),

      // Awaiting on a not-allowed class, #3
      makeDeterminismFailureTest(
        "await fooBar.invoke(ShopUtilities).retrieveOrder(order_id);",
        ["awaitingOnNotAllowedType"],
        { codeAboveClass: "class FooBar {}", enclosingFunctionParams: "fooBar: FooBar" }
      ),

      // Awaiting on a not-allowed class, #4
      makeDeterminismFailureTest(
        "await fooBar.client<User>('users').select('password').where({ username }).first();",
        ["awaitingOnNotAllowedType"],
        { codeAboveClass: "class FooBar {}", enclosingFunctionParams: "fooBar: FooBar" }
      )
    ]
  ]
];

testSet.forEach((test) => doTest(...test));
