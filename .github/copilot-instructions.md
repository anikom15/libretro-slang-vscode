# Code documentation

- Document exported functions and non-obvious internal helpers with concise JSDoc
  describing their purpose, inputs and outputs, and important assumptions or
  limitations. Include types when useful and keep them consistent with the code.
- Explain subtle behavior, error handling, and invariants where needed; avoid
  comments that merely repeat the implementation.
- When changing behavior or interfaces, update the affected JSDoc and related
  user-facing documentation in the same change.

# Tests

- Add focused unit tests for new or changed behavior, including important
  failure, boundary and ambiguity cases. Assert observable results rather than
  implementation details, and avoid tests that merely repeat constants or syntax.
- Extend the existing tests in `test/extension.test.js` and use the built-in
  Node.js assertion library; don't add a test framework without a clear need.
- Run `npm test` for changes to extension behavior. Set `GLSLANG_TEST_PATH` to an
  installed `glslangValidator` executable to also run compiler integration tests;
  keep ordinary unit tests independent of an installed compiler.
