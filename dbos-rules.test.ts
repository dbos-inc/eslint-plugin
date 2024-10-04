import * as vitest from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { dbosStaticAnalysisRule } from "./dbos-rules";
import Parser from "@typescript-eslint/parser";

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
  languageOptions: {
    parser: Parser,
    parserOptions: { project: "tsconfig.json" },
  },
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
      raw(query: string, ...bindings: any[]) {}
    }

    class PrismaClient {
      $queryRawUnsafe(query: string, ...values: any[]) {}
      $executeRawUnsafe(query: string, ...values: any[]) {}
    }

    class EntityManager {
      query<T extends unknown[]>(query: string, parameters?: T) {}
    }

    class PoolClient {
      query(query: string, ...values: any[]) {}
    }

    class PgDatabase {
      execute(query: string, ...values: any[]) {}
    }

    function Transaction(target?: any, key?: any, descriptor?: any): any {
      return descriptor;
    }

    export interface TransactionContext<T extends UserDatabaseClient> extends DBOSContext {
      client: T;
    }

    class SqlInjectionTestClass {
      aFieldInTheClass: string;

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

const testSet: TestSet = [
  /* Note: the tests for SQL injection do not involve any actual SQL code;
  they just test for any non-LR-values being passed to a raw SQL query callsite.
  You can find more info on LR-values in `dbos-rules.ts`. */

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

      // Success test #2 (deep variable tracing, along with some literal type concatenation)
      makeSqlInjectionSuccessTest(`
        let w, x, y, z, å = "ghi";

        w = "abc" + "def" + å + 503n + 504 + true + false + undefined + null + {} + {a: 3} + function() {} + (() => {}) + [1];
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
      `),

      // Success test #9 (testing unsubstituted template literals)
      makeSqlInjectionSuccessTest(`
        ctxt.client.raw(\`foo\`);
      `),

      // Success test #10 (testing Drizzle support)
      makeSqlInjectionSuccessTest(`
        ctxt.client.execute("foo");`,
        "PgDatabase"
      )
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

      // Failure test #8 (testing `EntityManager`)
      makeSqlInjectionFailureTest(`
        ctxt.client.query("foo" + (5).toString());
        `,
        Array(1).fill("sqlInjection"),
        "EntityManager"
      ),

      // Failure test #9 (testing not using `TransactionContext`, and malformed transactions)
      makeSqlInjectionFailureTest(`
        ctxt;

        class Other {
          @Transaction() // This one does not use 'ctxt'
          foo(ctxt: TransactionContext<Knex>) {}
        }

        const stuff = [1, 2, 3];
        stuff[1] %= 30;

        const x = "foo";

        const bob = {
          foo: 5,
          bar: 6,
          baz: stuff,
          baz2: "literal",

          get thing() {
            return this.foo;
          },

          otherThing() {
            console.log("Hello");
          }
        };

        // But this one does
        ctxt.client.raw(bob.baz2);

        //////////

        // Testing transactions without params
        class Other2 {
          @Transaction()
          myInvalidTransactionWithoutParams() {}
        }

        // Testing transactions without a specified client type
        class Other3 {
          @Transaction()
          myInvalidTransactionWithoutTypeParam(ctxt: TransactionContext) {}
        }

        class InvalidDatabaseClient {}

        // Testing transactions with an invalid client type
        class Other4 {
          @Transaction()
          myInvalidTransactionWithoutTypeParam(ctxt: TransactionContext<InvalidDatabaseClient>) {}
        }
        `,
        [
          "transactionDoesntUseTheDatabase", "transactionHasNoParameters",
          "transactionContextHasNoTypeArguments", "transactionContextHasInvalidClientType"
        ]
      ),

      // Failure test #10 (a simpler object test)
      makeSqlInjectionFailureTest(`
        // Case 1: declaring an object with a non-LR field
        const foo = {a: (5).toString()};
        ctxt.client.raw(foo.a); // Failure

        // Case 2: reassigning an object with a non-LR field
        let bar = {a: "initial"};
        bar = {a: (7).toString()};
        ctxt.client.raw(bar.a); // Failure

        // Case 3: assining one field of an object with a non-LR field
        const baz = {a: "initial"};
        baz.a = (6).toString();
        ctxt.client.raw(baz.a); // Failure
        ctxt.client.raw(baz); // Failure
        `,
        Array(4).fill("sqlInjection")
      ),

      // Failure test #11 (a more complex object test)
      makeSqlInjectionFailureTest(`
        // This stuff should fail
        const x = {y: "literal", z: {a: (30).toString()}};
        const z = x.z;
        const a = {b: z + x.y};
        const c = {d: a.b};
        ctxt.client.raw(c.d); // Failure

        // This stuff should succeed
        const xx = {yy: "literal", zz: {a: (40).toString()}};
        const zz = xx.yy;
        const aa = {bb: zz + xx.yy};
        const cc = {dd: aa.bb};
        ctxt.client.raw(cc.dd); // Success
        `,
        Array(1).fill("sqlInjection")
      ),

      // Failure test #12 (testing shorthand property assignment)
      makeSqlInjectionFailureTest(`
        const b = [(5).toString()];
        const a = {b, c: "literal"};
        ctxt.client.raw(a); // Failure
        ctxt.client.raw(a.b); // Failure
        ctxt.client.raw(a.c); // Success
        `,
        Array(2).fill("sqlInjection")
      ),

      // Failure test #13 (testing element array accesses)
      makeSqlInjectionFailureTest(`
        const foo = ["1", "2", (5).toString()];
        ctxt.client.raw(foo); // Failure
        ctxt.client.raw(foo[0]); // Failure

        let bar = ["a", "b", "c"];
        bar = [2, 3, 4];
        bar[0] = 5;
        bar = {a: 1, b: 2, c: (6).toString(), d: "literal"};
        ctxt.client.raw(bar["c"]); // Failure
        `,
        Array(3).fill("sqlInjection")
      ),

      // Failure test #14 (testing nested object and array accesses, along with arbitrary parenthetical placements)
      makeSqlInjectionFailureTest(`
        const nested = {a: {b: {c: (20).toString(), d: "literal"}}, e: "another literal"};

        ctxt.client.raw(nested.e); // Succeeds
        ctxt.client.raw(nested.a.b.c); // Fails (reduces down to a.b (this is an implementation limitation), and then fails)
        ctxt.client.raw(nested["a"]); // Fails
        ctxt.client.raw(nested["a"]["b"]["d"]); // Fails
        ctxt.client.raw((nested["a"])["b"]["c"]); // Fails
        ctxt.client.raw((nested)["a"]["b"]["c"]); // Fails
        ctxt.client.raw((nested["a"]["b"]["c"])); // Fails
        `,
        Array(6).fill("sqlInjection")
      ),

      // Failure test #15 (testing object access with leftmost non-allowed-lvalues)
      makeSqlInjectionFailureTest(`
        function fooFn(): {a: string} {
          return {a: "hello"};
        }

        ctxt.client.raw(fooFn().a); // Failure
        ctxt.client.raw(this.aFieldInTheClass); // Failure
        `,
        Array(2).fill("sqlInjection")
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
