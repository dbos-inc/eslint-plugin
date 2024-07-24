import * as vitest from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { dbosStaticAnalysisRule } from "./dbos-rules";

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
  tester.run(title, dbosStaticAnalysisRule, { valid: successTests, invalid: failureTests });
}

//////////

const tester = new RuleTester({
  parser: "@typescript-eslint/parser",
  parserOptions: { project: "tsconfig.json" },
  defaultFilenames: { ts: "dbos-rules.test.ts", tsx: "this_file_doesnt_exist.tsx" }
});

////////// These functions build different types of test cases with some primitive code structure around them

function makeDeterminismCode(code: string, enclosingFunctionParams: string): string {
  return `
    class DBOSContext {}
    class UserDatabaseClient {}

    interface WorkflowContext extends DBOSContext {
      invoke<T extends object>(targetClass: T): any;
      client: any;
      foo(): any; // This is just here for testing
    }

    // This is used for some determinism failure tests
    interface IllegalClassToUse<T extends UserDatabaseClient> extends DBOSContext {
      invoke<T extends object>(targetClass: T): any;
      client: T;
      foo(): any; // This is just here for testing
    }

    function Workflow(target?: any, key?: any, descriptor?: any): any {
      return descriptor;
    }

    class DeterminismTestClass {
      @Workflow()
      async determinismTestMethod(${enclosingFunctionParams}) {
        ${code}
      }
    }
  `;
}

function makeSqlInjectionCode(code: string, sqlClient: string): string {
  return `
    class DBOSContext {}
    class UserDatabaseClient {}

    class Knex {
      raw(...x: any[]) {}
    }

    class PrismaClient {
      $queryRawUnsafe(...x: any[]) {}
      $executeRawUnsafe(...x: any[]) {}
    }

    class PoolClient {
      query(...x: any[]) {}
      queryWithClient(client: any, ...x: any[]) {}
    }

    class TypeORMEntityManager {
      query(...x: any[]) {}
    }

    class UserDatabase {
      query(...x: any[]) {}
    }

    function Transaction(target?: any, key?: any, descriptor?: any): any {
      return descriptor;
    }

    export interface TransactionContext<T extends UserDatabaseClient> extends DBOSContext {
      client: T;
    }

    class SqlInjectionTestClass {
      @Transaction()
      injectionTestMethod(ctxt: TransactionContext<${sqlClient}>, aParam: string) {
        ${code}
      }
    }
  `;
}

function errorIdsToObjectFormat(errorIds: string[]): { messageId: string }[] {
  return errorIds.map((id) => { return { messageId: id }; });
}

function makeDeterminismSuccessTest(code: string, enclosingFunctionParams: string = ""): SuccessTest {
  return { code: makeDeterminismCode(code, enclosingFunctionParams) };
}

function makeDeterminismFailureTest(code: string,
  expectedErrorIds: string[], enclosingFunctionParams: string = ""): FailureTest {

  return {
      code: makeDeterminismCode(code, enclosingFunctionParams),
      errors: errorIdsToObjectFormat(expectedErrorIds)
    };
}

function makeSqlInjectionSuccessTest(code: string, sqlClient: string = "Knex"): SuccessTest {
  return { code: makeSqlInjectionCode(code, sqlClient) };
}

function makeSqlInjectionFailureTest(code: string, expectedErrorIds: string[], sqlClient: string = "Knex"): FailureTest {
  return { code: makeSqlInjectionCode(code, sqlClient), errors: errorIdsToObjectFormat(expectedErrorIds) };
}

//////////

/* TODO: perhaps make some test helper functions to make that better, or split tests into more files
(core goal: isolate what each test tests for), and that might also make them somewhat easier to read */
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

        // Literal concatenation (with some parentheses thrown in)
        ctxt.client.raw("foo" + ("bar" + "baz" + "a" + "b" + "c" + "d") + "bam");

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
        ctxt.client.raw(w); // This traces from w to z to y to x to "abc" + "def" + å
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
        let bar, foo = "xyz" + "zyw";
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
        ctxt.client.raw(x + y);
        ctxt.client.raw(y);
      `),

      // Success test #7 (testing template expression evaluation)
      makeSqlInjectionSuccessTest(`
        let foo = 'x';
        ctxt.client.raw(\`\${'305' + '2' + \`\${foo}\`} \${'abc' + 'def'} \${'512'} \${'603'} \${'712'} \${foo + foo + 'foo'}\`);
      `),

      // Success test #8 (testing reassigning the client in a different format)
      makeSqlInjectionSuccessTest(`
        const client = ctxt.client;
        client.raw("foo");
      `)
    ],
    [
      // Failure test #1 (testing lots of different types of things)
      makeSqlInjectionFailureTest(`
        // Testing the += operator
        let foo = "foo";
        foo += foo + foo + "bar" + (5).toString();

        const bar = "bar", baz = "baz";
        const bam = foo + foo + foo + bar + baz + "foo" + "bar";
        ctxt.client.raw(bam + (5).toString()); // Concatenating a literal-reducible string with one that is not

        const asVar = bam + (5).toString();
        ctxt.client.raw(asVar);

        {
          const asVar = "this one is literal";
          ctxt.client.raw(asVar); // No error because of the shadowing
        }

        ctxt.client.raw(asVar);

        ctxt.client.raw(foo);
        ctxt.client.raw(foo + "a");
        ctxt.client.raw(foo += "a");

        console.log("Hello!"); // This is allowed in a non-workflow function
      `,
        Array(6).fill("sqlInjection")
      ),

      // Failure test #2 (testing some function parameter shadowing behavior)
      makeSqlInjectionFailureTest(`
        ctxt.client.raw(aParam); // Using a function parameter for a raw call is invalid

        {
          // Shadowing the function parameter, and making its usage valid
          const aParam = "foo";
          ctxt.client.raw(aParam);
        }

        ctxt.client.raw(aParam);
        ctxt.client.raw(aParam + (5).toString()); // This fails for two reasons (but only shows one)
        ctxt.client.raw((5).toString()); // And this fails like usual

        const foo = 5; // Testing numeric literals! Just thrown in here.
        ctxt.client.raw(5 + foo * 500 * foo);
      `,
        Array(4).fill("sqlInjection")
      ),

      // Failure test #3 (testing what happens when you call a function/method on a string)
      makeSqlInjectionFailureTest(`
        const baz = (s: string) => s;
        const foo = "x".toLowerCase(); // No function calls may be applied to literal strings
        const bar = baz("x");
        ctxt.client.raw(foo);
        ctxt.client.raw(bar);
      `,
        Array(2).fill("sqlInjection")
      ),

      // Failure test #4 (making sure that tagged template expressions do not work)
      makeSqlInjectionFailureTest(`
        const myFn = (a, b) => a;
        // No tagged template expressions are allowed!
        const s = myFn\`foo \${'bar'} baz\`;
        ctxt.client.raw(s);
        `,
        Array(1).fill("sqlInjection")
      ),

      // Failure test #5 (testing reassigning the client in a different format)
      makeSqlInjectionFailureTest(`
        const client = ctxt.client;
        client.raw((5).toString());
        `,
        Array(1).fill("sqlInjection")
      ),

      // Failure test #6 (testing `PrismaClient`)
      makeSqlInjectionFailureTest(`
        ctxt.client.$queryRawUnsafe((5).toString()); // Fail
        ctxt.client.$queryRawUnsafe("literal"); // No fail
        ctxt.client.$executeRawUnsafe((5).toString()); // Fail
        ctxt.client.$executeRawUnsafe("the-literal", 5); // No fail
        `,
        Array(2).fill("sqlInjection"),
        "PrismaClient"
      ),

      // Failure test #7 (testing `PoolClient`)
      makeSqlInjectionFailureTest(`
        ctxt.client.query("bob" + (5).toString()); // That works...

        const foo = ctxt.client; // And that does...
        foo.query("bob" + (5).toString());

        const obj = {bob: ctxt.client};
        obj.bob.query("bob" + (5).toString());
        `,
        Array(3).fill("sqlInjection"),
        "PoolClient"
      ),

      // Failure test #8 (testing `TypeORMEntityManager`)
      makeSqlInjectionFailureTest(`
        ctxt.client.query("foo" + (5).toString());
        `,
        Array(1).fill("sqlInjection"),
        "TypeORMEntityManager"
      ),

      // Failure test #9 (testing `UserDatabase`)
      makeSqlInjectionFailureTest(`
        const userDb = {} as UserDatabase;
        userDb.query("foo" + (5).toString());
        `,
        Array(1).fill("sqlInjection")
      ),
    ]
  ],

  ["global mutations", [],
    [makeDeterminismFailureTest(
      `
      let x = 3;
      let y = {a: 1, b: 2};
      let z = 256;

      class Bar {
        x: number;
        static xx: number;

        @Workflow()
        foo() {
          x = 4; // Not allowed
          this.x = 4; // Not allowed
          Bar.xx = 4; // Not allowed
          y.a += 1; // Not allowed

          z = [y.b, y.b = z][0]; // Not allowed (this is a funky variable swap)

          x = 23 + x, y.a = 24 + x; // Two global modifications, so not allowed

          {
            let x = 5; // x is now local
            x = 23 + x, y.a = 24 + x; // One local, one global (the right one is not allowed)
            y.a = 23 + x, x = 24 + x; // One global, one local (the left one is not allowed)
          }

          {
            let y = {a: 3, b: 4}; // Shadows the global y
            y.a = 1; // Not a global modification anymore
          }
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
      Array(12).fill("globalMutation")
    )]
  ],

  ["banned/not banned functions", [],
    [
      /* The secondary args here are the expected error
      IDs (which line up with the banned functions tested) */
      makeDeterminismFailureTest("Date();", ["Date"]),
      makeDeterminismFailureTest("new Date();", ["Date"]),
      makeDeterminismFailureTest("Date.now();", ["Date.now"]),
      makeDeterminismFailureTest("Math.random();", ["Math.random"]),
      makeDeterminismFailureTest("console.log(\"Hello!\");", ["console.log"]),
      makeDeterminismFailureTest("setTimeout(() => {});", ["setTimeout"]),
      makeDeterminismFailureTest("const bcrypt: any = {}; bcrypt.hash = (a, b, c) => {}; bcrypt.hash(1, 2, 3);", ["bcrypt.hash"]),
      makeDeterminismFailureTest("const bcrypt: any = {}; bcrypt.compare = (a, b, c) => {}; bcrypt.compare(1, 2, 3);", ["bcrypt.compare"])
    ]
  ],

  ["allowed/not allowed awaits",
    [
      // makeDeterminismSuccessTest("await ({}).foo();"), // TODO: probably make this fail in a proper way
      makeDeterminismSuccessTest("await new Set();"), // TODO: definitely make this not allowed (so ignore the `new`)

      // Awaiting on a method with a leftmost `WorkflowContext`, #1
      makeDeterminismSuccessTest("await ctxt.foo();", "ctxt: WorkflowContext"),

      // Awaiting on a method with a leftmost `WorkflowContext`, #2
      makeDeterminismSuccessTest(
        "class ShopUtilities {}; const orderId = 20; await ctxt.invoke(ShopUtilities).retrieveOrder(20);",
        "ctxt: WorkflowContext"
      ),

      // Awaiting on a method with a leftmost `WorkflowContext`, #3
      makeDeterminismSuccessTest(
        "type User = any; const username = 'phil'; await ctxt.client('users').select('password').where({ username }).first();",
        "ctxt: WorkflowContext"
      ),

      // Awaiting on a leftmost non-`WorkflowContext` type, but you pass a `WorkflowContext` in
      makeDeterminismSuccessTest(
        `async function workflowHelperFunction(ctxt: WorkflowContext) {return await ctxt.foo();}
        await workflowHelperFunction(ctxt);`,
        "ctxt: WorkflowContext"
      )
    ],

    [
      // Awaiting on a not-allowed function, #1
      makeDeterminismFailureTest("await fetch('https://www.google.com');", ["awaitingOnNotAllowedType"]),

      // Awaiting on a not-allowed function, #2
      makeDeterminismFailureTest(`
        async function foo() {return 5;}
        await foo();`,
        ["awaitingOnNotAllowedType"]
      ),

      // Awaiting on a not-allowed class, #1
      makeDeterminismFailureTest(
        "await illegal.foo();",
        ["awaitingOnNotAllowedType"],
        "illegal: IllegalClassToUse<any>"
      ),

      // Awaiting on a not-allowed class, #2
      makeDeterminismFailureTest(
        "class ShopUtilities {}; const orderId = 20; await illegal.invoke(ShopUtilities).retrieveOrder(orderId);",
        ["awaitingOnNotAllowedType"],
        "illegal: IllegalClassToUse<any>"
      ),

      // Awaiting on a not-allowed class, #3
      makeDeterminismFailureTest(
        "type User = any; const username = 'phil'; await illegal.client('users').select('password').where({ username }).first();",
        ["awaitingOnNotAllowedType"],
        "illegal: IllegalClassToUse<any>"
      )
    ]
  ]
];

testSet.forEach((test) => doTest(...test));
