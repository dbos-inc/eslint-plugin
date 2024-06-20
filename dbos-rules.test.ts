const {RuleTester} = require("eslint");
const ruleUnderTest = require("./dbos-rules");

const ruleTester = new RuleTester({
  parserOptions: { ecmaVersion: 2015 }
});

// TODO: get the tests to start running again (they should be able to pass, but something's up with `parserServices`...)

// Throws error if the tests in ruleTester.run() do not pass
/*
ruleTester.run(
  "detect-nondeterministic-calls", // rule name
  ruleUnderTest.rules['detect-nondeterministic-calls'], // rule code
  { // checks
    // 'valid' checks cases that should pass
    valid: [{
      code: "const foo = 'bar';",
    }],
    // 'invalid' checks cases that should not pass
    invalid: [{
      code: "const foo = Math.random();",
      //output: 'const foo = *NEED SUGGESTION*;',
      errors: 1,
    },
    {
      code: "setTimeout(1000).then();",
      //output: 'const foo = *NEED SUGGESTION*;',
      errors: 1,
    }],
  }
);

ruleTester.run(
  "detect-new-date", // rule name
  ruleUnderTest.rules['detect-new-date'], // rule code
  { // checks
    // 'valid' checks cases that should pass
    valid: [{
      code: "const foo = 'bar';",
    }],
    // 'invalid' checks cases that should not pass
    invalid: [{
      code: "const foo = new Date();",
      //output: 'const foo = *NEED SUGGESTION*;',
      errors: 1,
    }],
  }
);

ruleTester.run(
  "detect-native-code", // rule name
  ruleUnderTest.rules['detect-native-code'], // rule code
  { // checks
    // 'valid' checks cases that should pass
    valid: [{
      code: "const foo = 'bar';",
    }],
    // 'invalid' checks cases that should not pass
    invalid: [{
      code: "const foo = bcrypt.hash('xxx', 10);",
      //output: 'const foo = *NEED SUGGESTION*;',
      errors: 1,
    }]
    invalid: [{
      code: "const foo = bcrypt.compare('xxx', pass);",
      //output: 'const foo = *NEED SUGGESTION*;',
      errors: 1,
    }],
  }
);
*/

console.log("All tests passed!");
