// Copyright (C) 2026  W. M. Martinez
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { buildIncludeModel } = require("../include-model");
const { buildSemanticModel, semanticIssues, resolveAt } = require("../semantic-model");
const { validateWithCompiler, builtinSignatures, rankBuiltinOverloads } = require("../glsl-compiler");
let signatureLoader = builtinSignatures;

const root = path.resolve(__dirname, "..");

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
assert.strictEqual(packageJson.name, "libretro-slang");

const languageIds = packageJson.contributes.languages.map(language => language.id);
assert.deepStrictEqual(languageIds, ["libretro-slang", "libretro-slang-preset"]);
assert.ok(packageJson.contributes.languages[0].extensions.includes(".inc"));

const slangGrammar = JSON.parse(fs.readFileSync(
  path.join(root, "syntaxes", "libretro-slang.tmLanguage.json"),
  "utf8"
));
assert.strictEqual(slangGrammar.scopeName, "source.glsl.libretro-slang");
assert.ok(JSON.stringify(slangGrammar).includes("#\\\\s*pragma\\\\s+parameter"));
const formatPattern = slangGrammar.repository["slang-pragmas"].patterns.find(pattern => pattern.name === "meta.slang.pragma.format");
assert.ok(new RegExp(formatPattern.match).test("#pragma format R16G16B16A16_SFLOAT"));
assert.ok(!new RegExp(formatPattern.match).test("#pragma format R16G32_UINT"));
for (const directive of ["stage", "parameter", "format", "name", "alias", "include", "include_optional"]) {
  const example = `#pragma ${directive} placeholder`;
  assert.ok(slangGrammar.repository["slang-pragmas"].patterns.some(pattern =>
    new RegExp(pattern.match || pattern.begin).test(example)), `Missing pragma highlighting: ${directive}`);
}
const layoutPattern = slangGrammar.repository.layout.patterns[0].patterns[0];
assert.ok(new RegExp(layoutPattern.match).test("location"));
assert.ok(new RegExp(layoutPattern.match).test("std140"));
const literalPatterns = slangGrammar.repository.numbers.patterns.map(pattern => new RegExp(pattern.match));
for (const literal of ["true", "false", ".5", "1.0", "2e-3", "0xFFu"]) {
  assert.ok(literalPatterns.some(pattern => pattern.test(literal)), `Missing literal: ${literal}`);
}

const presetGrammar = JSON.parse(fs.readFileSync(
  path.join(root, "syntaxes", "libretro-slang-preset.tmLanguage.json"),
  "utf8"
));
assert.strictEqual(presetGrammar.scopeName, "source.libretro-slang-preset");

const extensionSource = fs.readFileSync(path.join(root, "extension.js"), "utf8");
assert.ok(extensionSource.includes("registerDocumentLinkProvider"));
assert.ok(extensionSource.includes("registerDefinitionProvider"));
assert.ok(extensionSource.includes("Missing required"));

const vscode = {
  DiagnosticSeverity: { Error: 0, Warning: 1 },
  Diagnostic: class Diagnostic {
    constructor(range, message, severity) {
      Object.assign(this, { range, message, severity });
    }
  },
  Uri: {
    joinPath: (uri, ...parts) => makeUri(path.win32.resolve(uri.path, ...parts))
  },
  workspace: {
    textDocuments: [],
    fs: {
      async readFile(uri) {
        if (!(uri.path in files)) {
          const error = new Error("Not found");
          error.code = "FileNotFound";
          throw error;
        }
        if (files[uri.path] instanceof Error) throw files[uri.path];
        return Buffer.from(files[uri.path]);
      }
    }
  }
};
const files = {};
function makeUri(value) {
  return { path: value, toString() { return this.path; } };
}
const sandbox = {
  require: name => {
    if (name === "vscode") return vscode;
    if (name === "./include-model") return require("../include-model");
    if (name === "./semantic-model") return require("../semantic-model");
    if (name === "./glsl-compiler") return { validateWithCompiler, rankBuiltinOverloads, builtinSignatures: (...args) => signatureLoader(...args) };
    throw new Error(`Unexpected module: ${name}`);
  },
  module: { exports: {} },
  Buffer
};
vm.runInNewContext(extensionSource + "\nmodule.exports.test = { validateSlang, shaderModel, collectIncludePaths };", sandbox);

function document(text, file = "C:\\shaders\\root.slang") {
  const lines = text.split("\n");
  return {
    uri: makeUri(file),
    lineCount: lines.length,
    lineAt: line => ({ text: lines[line], range: { line } }),
    getText: range => range ? lines[range.start.line].slice(range.start.character, range.end.character) : text,
    getWordRangeAtPosition: position => {
      const line = lines[position.line];
      const words = [...line.matchAll(/[A-Za-z_]\w*/g)];
      const word = words.find(match => position.character >= match.index && position.character < match.index + match[0].length);
      return word && new vscode.Range(position.line, word.index, position.line, word.index + word[0].length);
    }
  };
}

(async () => {
  const { validateSlang, shaderModel, collectIncludePaths } = sandbox.module.exports.test;
  async function validate(doc) {
    return validateSlang(doc, await shaderModel(doc));
  }
  const incomplete = await validate(document("vec4 helper;"));
  assert.strictEqual(incomplete.length, 3);
  assert.ok(incomplete.every(item => item.severity === vscode.DiagnosticSeverity.Warning));

  const complete = await validate(document(
    "#version 450\n#pragma stage vertex\n#pragma stage fragment"
  ));
  assert.strictEqual(complete.length, 0);

  const missingStep = await validate(document('#pragma parameter Gain "Gain" 1 0 2', "C:\\shaders\\helper.inc"));
  assert.strictEqual(missingStep.length, 1);
  assert.strictEqual(missingStep[0].severity, vscode.DiagnosticSeverity.Warning);
  assert.ok(missingStep[0].message.includes("step"));
  const invalidValues = await validate(document('#pragma parameter Gain "Gain" 1 nope 2 0.1', "C:\\shaders\\helper.inc"));
  assert.strictEqual(invalidValues.length, 1);
  assert.strictEqual(invalidValues[0].severity, vscode.DiagnosticSeverity.Error);
  const validValues = await validate(document('#pragma parameter Gain "Gain" -1e-1 .0 +2. 0.1', "C:\\shaders\\helper.inc"));
  assert.strictEqual(validValues.length, 0);

  const helper = await validate(document("vec4 helper;", "C:\\shaders\\helper.inc"));
  assert.strictEqual(helper.length, 0);
  const vertexHelper = await validate(document("#pragma stage vertex\nvec4 helper;", "C:\\shaders\\helper.INC"));
  assert.strictEqual(vertexHelper.length, 0);
  const badVersion = await validate(document(
    "// #version 450\n/* #version 450 */\n#version 450",
    "C:\\shaders\\helper.inc"
  ));
  assert.strictEqual(badVersion.length, 1);
  assert.strictEqual(badVersion[0].range.line, 2);
  assert.strictEqual(badVersion[0].severity, vscode.DiagnosticSeverity.Error);
  assert.ok(badVersion[0].message.includes(".inc file cannot contain a #version"));

  const malformed = await validate(document(
    '#version 450\n#pragma parameter Broken\n#pragma stage vertex\n#pragma stage fragment'
  ));
  assert.strictEqual(malformed.length, 1);
  assert.strictEqual(malformed[0].severity, vscode.DiagnosticSeverity.Error);

  files["C:\\shaders\\shared.inc"] = '#include "nested.inc"\n#pragma stage vertex';
  files["C:\\shaders\\nested.inc"] = '#pragma parameter Gain "Gain" 1.0 0.0 2.0 0.1';
  const rootDocument = document(
    '#version 450\n#if 0\n#include "shared.inc"\n#endif\n#pragma stage fragment\nfloat value = Gain;'
  );
  let model = await shaderModel(rootDocument);
  assert.strictEqual(model.parameters.length, 1);
  assert.strictEqual(model.parameters[0].uri.path, "C:\\shaders\\nested.inc");
  assert.strictEqual(model.parameters[0].rootLine, 2);
  assert.strictEqual(model.entries.find(entry => entry.text.includes("float value")).stage, "fragment");
  assert.strictEqual((await validateSlang(rootDocument, model)).length, 0);

  files["C:\\shaders\\stages.inc"] = '#pragma stage vertex\nfloat vertexValue;\n#include "fragment.inc"\nfloat stillFragment;';
  files["C:\\shaders\\fragment.inc"] = '#pragma stage fragment\nfloat fragmentValue;';
  const allStages = document('#version 450\nfloat commonValue;\n#include "stages.inc"\nfloat afterInclude;');
  const stagedModel = await shaderModel(allStages);
  assert.strictEqual((await validateSlang(allStages, stagedModel)).length, 0);
  for (const [name, stage] of [
    ["commonValue", null], ["vertexValue", "vertex"], ["fragmentValue", "fragment"],
    ["stillFragment", "fragment"], ["afterInclude", "fragment"]
  ]) {
    assert.strictEqual(stagedModel.entries.find(entry => entry.text.includes(name)).stage, stage);
  }
  const inherited = await shaderModel(document(
    '#version 450\n#pragma stage vertex\n#include "nested.inc"\n#pragma stage fragment'
  ));
  assert.strictEqual(inherited.parameters[0].stage, "vertex");
  files["C:\\shaders\\reverse.inc"] = '#pragma stage fragment\n#pragma stage vertex';
  const reversed = await validate(document('#version 450\n#include "reverse.inc"'));
  assert.strictEqual(reversed.length, 1);
  assert.strictEqual(reversed[0].severity, vscode.DiagnosticSeverity.Warning);
  assert.ok(reversed[0].message.includes("vertex stage appears before"));

  files["C:\\shaders\\bad-version.inc"] = "#version 450\n#pragma stage vertex";
  const includedVersion = await validate(document(
    '#version 450\n#include "bad-version.inc"\n#pragma stage fragment'
  ));
  assert.strictEqual(includedVersion.length, 1);
  assert.strictEqual(includedVersion[0].range.line, 1);
  assert.ok(includedVersion[0].message.includes("bad-version.inc:1"));

  const unsaved = document('#pragma parameter Gain "Unsaved" 1.0 0.0 2.0 0.1', "C:\\shaders\\nested.inc");
  vscode.workspace.textDocuments.push(unsaved);
  model = await shaderModel(rootDocument);
  assert.strictEqual(model.parameters[0].description, "Unsaved");
  vscode.workspace.textDocuments.pop();

  const conflict = document(
    '#version 450\n#include "shared.inc"\n#pragma parameter Gain "Other" 1.0 0.0 2.0\n#pragma stage fragment'
  );
  const conflictDiagnostics = await validate(conflict);
  assert.ok(conflictDiagnostics.some(item => item.message.includes('Duplicate parameter "Gain"')));

  files["C:\\shaders\\cycle.inc"] = '#include "root.slang"';
  const missing = document(
    '#version 450\n#include "cycle.inc"\n#pragma include_optional "absent.inc"\n#include "absent.inc"\n#pragma stage vertex\n#pragma stage fragment'
  );
  const missingDiagnostics = await validate(missing);
  assert.ok(missingDiagnostics.some(item => item.message.includes("Cyclic include")));
  assert.strictEqual(missingDiagnostics.filter(item => item.message.includes("was not found")).length, 1);
  assert.ok(missingDiagnostics.some(item => item.message.includes("cycle.inc:1") && item.range.line === 1));

  files["C:\\shaders\\denied.inc"] = new Error("Permission denied");
  const unreadable = await validate(document('#include "denied.inc"'));
  assert.ok(unreadable.some(item => item.message.includes("Permission denied")));

  const commented = document('/*\n#include "missing.inc"\n#pragma parameter Fake "Fake" 0 0 1\n*/\n#pragma parameter URL "https://example" 0 0 1 // comment');
  model = await shaderModel(commented);
  assert.strictEqual(model.issues.length, 0);
  assert.strictEqual(model.parameters.length, 1);
  assert.strictEqual(model.parameters[0].description, "https://example");
  assert.strictEqual(collectIncludePaths(commented).length, 0);

  const repeated = await buildIncludeModel(
    { uri: makeUri("C:\\shaders\\root.slang"), text: '#include "nested.inc"\n#include "nested.inc"' },
    (uri, name) => makeUri(path.win32.resolve(uri.path, "..", name)),
    async uri => ({ uri, text: files[uri.path] })
  );
  assert.strictEqual(repeated.parameters.length, 2);
  assert.strictEqual(repeated.issues.length, 0);

  files["C:\\shaders\\functions.inc"] = [
    "float transform(float x) { return x; }",
    "vec2 transform(vec2 x) { return x; }",
    "float transform(float x, float y) { return x + y; }"
  ].join("\n");
  const semanticDocument = document([
    "#version 450",
    '#include "functions.inc"',
    '#pragma parameter Gain "Gain" 1.0 0.0 2.0',
    "layout(binding = 0) uniform UBO {",
    "  mat4 MVP;",
    "  float Gain;",
    "  vec4 PassOutputSize0;",
    "} global;",
    "#pragma stage vertex",
    "layout(location = 0) out vec2 uv;",
    "void main() { float f = transform(1.0); }",
    "#pragma stage fragment",
    "layout(location = 0) in vec2 texcoord;",
    "void main() { float v = global.Gain + transform(1.0, 2.0); }"
  ].join("\n"));
  const includeModel = await shaderModel(semanticDocument);
  const semantic = buildSemanticModel(includeModel);
  assert.strictEqual(semanticIssues(includeModel, semantic).length, 0);
  assert.strictEqual(semantic.symbols.filter(symbol => symbol.kind === "function" && symbol.name === "transform").length, 3);
  const findAt = (line, word) => {
    const character = semanticDocument.lineAt(line).text.indexOf(word);
    return resolveAt(includeModel, semantic, semanticDocument.uri, line, character, word);
  };
  assert.strictEqual(findAt(10, "transform").symbols.length, 1);
  assert.strictEqual(findAt(10, "transform").symbols[0].parameterTypes[0], "float");
  assert.strictEqual(findAt(13, "transform").symbols[0].arity, 2);
  assert.strictEqual(findAt(13, "Gain").parameters.length, 1);
  assert.strictEqual(findAt(13, "Gain").symbols[0].instance, "global");
  assert.strictEqual(findAt(2, "Gain").symbols[0].kind, "uniformMember");
  assert.ok(findAt(12, "texcoord").symbols.some(symbol => symbol.name === "uv"));
  const ambiguous = document('#include "functions.inc"\n#pragma stage fragment\nvoid main() { transform(someValue); }');
  const ambiguousModel = await shaderModel(ambiguous);
  const ambiguousSemantic = buildSemanticModel(ambiguousModel);
  const ambiguousResolution = resolveAt(ambiguousModel, ambiguousSemantic, ambiguous.uri, 2,
    ambiguous.lineAt(2).text.indexOf("transform"), "transform");
  assert.strictEqual(ambiguousResolution.symbols.length, 2);

  const invalid = document([
    "#version 450",
    '#pragma parameter Gain "Gain" 1 0 2 0.1',
    "layout(push_constant) uniform Push { int Gain; float FrameCount; } constants;",
    "#pragma stage vertex",
    "layout(location = 1) out vec2 first;",
    "#pragma stage fragment",
    "layout(location = 1) in vec3 second;"
  ].join("\n"));
  const invalidDiagnostics = await validate(invalid);
  assert.strictEqual(invalidDiagnostics.length, 3);
  assert.ok(invalidDiagnostics.every(item => item.severity === vscode.DiagnosticSeverity.Warning));
  assert.ok(invalidDiagnostics.some(item => item.message.includes('Uniform "Gain" must have type float')));
  assert.ok(invalidDiagnostics.some(item => item.message.includes('Uniform "FrameCount" must have type uint')));
  assert.ok(invalidDiagnostics.some(item => item.message.includes("location 1")));
  const conditional = document([
    "#version 450",
    "#pragma stage vertex",
    "#if SOME_OPTION",
    "layout(location = 1) out vec2 first;",
    "#endif",
    "#pragma stage fragment",
    "layout(location = 1) in vec3 second;"
  ].join("\n"));
  assert.strictEqual((await validate(conditional)).length, 0);
  const macroType = document([
    "#version 450",
    "#define MY_FLOAT float",
    '#pragma parameter Gain "Gain" 1 0 2 0.1',
    "uniform UBO { MY_FLOAT Gain; };",
    "#pragma stage vertex",
    "#pragma stage fragment"
  ].join("\n"));
  assert.strictEqual((await validate(macroType)).length, 0);

  const outputDocument = document([
    "#version 450",
    "#pragma stage vertex",
    "layout(location = 0) out vec2 uv;",
    "void main() { }",
    "#pragma stage fragment",
    "layout(location = 0) in vec2 coord;",
    "layout(location = 0) out vec4 result;",
    "void main() { }"
  ].join("\n"));
  const outputDiagnostics = await validate(outputDocument);
  assert.strictEqual(outputDiagnostics.length, 3);
  assert.ok(outputDiagnostics.some(item => item.message.includes("gl_Position")));
  assert.ok(outputDiagnostics.some(item => item.message.includes('fragment output "result"')));
  assert.ok(outputDiagnostics.some(item => item.message.includes('vertex output "uv"')));
  const partialShader = await validate(document("void main() { }"));
  assert.strictEqual(partialShader.length, 3);
  const validOutputDocument = document([
    "#version 450",
    "#pragma stage vertex",
    "layout(location = 0) out vec2 uv;",
    "void setValues() { uv.xy = vec2(0); gl_Position = vec4(0); }",
    "void main() { setValues(); }",
    "#pragma stage fragment",
    "layout(location = 0) in vec2 coord;",
    "layout(location = 0) out vec4 arbitraryName;",
    "void main() { arbitraryName = vec4(coord, 0, 1); }"
  ].join("\n"));
  assert.strictEqual((await validate(validOutputDocument)).length, 0);
  const mismatchDocument = document([
    "#version 450",
    "#pragma stage vertex",
    "void main() { gl_Position = vec4(0); }",
    "#pragma stage fragment",
    "layout(location = 3) in vec2 coord;",
    "layout(location = 0) out vec4 result;",
    "void main() { result = vec4(coord, 0, 1); }"
  ].join("\n"));
  const mismatchDiagnostics = await validate(mismatchDocument);
  assert.strictEqual(mismatchDiagnostics.length, 1);
  assert.ok(mismatchDiagnostics[0].message.includes("no vertex output"));
  files["C:\\shaders\\fragment-input.inc"] = "layout(location = 4) in vec2 missing;";
  const nestedInput = await validate(document([
    "#version 450", "#pragma stage vertex", "void main() { gl_Position = vec4(0); }",
    "#pragma stage fragment", '#include "fragment-input.inc"',
    "layout(location = 0) out vec4 result;", "void main() { result = vec4(1); }"
  ].join("\n")));
  assert.ok(nestedInput.some(item => item.range.line === 4 && item.message.includes("no vertex output")));
  const conditionalOutput = document([
    "#version 450",
    "#pragma stage vertex",
    "#if OPTION",
    "void main() { gl_Position = vec4(0); }",
    "#else",
    "void main() {}",
    "#endif",
    "#pragma stage fragment",
    "layout(location = 0) out vec4 result;",
    "void main() { result = vec4(0); }"
  ].join("\n"));
  assert.ok(!(await validate(conditionalOutput)).some(item => item.message.includes("gl_Position")));
  const optionalUnknown = document([
    "#version 450", '#pragma include_optional "optional-helper.inc"',
    "#pragma stage vertex", "void main() {}",
    "#pragma stage fragment", "void main() {}"
  ].join("\n"));
  assert.ok(!(await validate(optionalUnknown)).some(item => item.message.includes("gl_Position")));

  if (process.env.GLSLANG_TEST_PATH) {
    const compilerShader = document([
      "#version 450",
      "#pragma stage vertex",
      "void main() { gl_Position = vec4(0.0); }",
      "#pragma stage fragment",
      "layout(location = 0) out vec4 color;",
      "void main() { color = texture(1.0, vec2(0.0)); }"
    ].join("\n"));
    const compilerModel = await shaderModel(compilerShader);
    const compilerIssues = await validateWithCompiler(compilerModel, process.env.GLSLANG_TEST_PATH);
    assert.ok(compilerIssues.some(issue => issue.rootLine === 5 && issue.message.includes("texture")));
    const validCompilerModel = await shaderModel(validOutputDocument);
    assert.strictEqual((await validateWithCompiler(validCompilerModel, process.env.GLSLANG_TEST_PATH)).length, 0);
      files["C:\\shaders\\bad-call.inc"] = "vec4 invalidSample() { return texture(1.0, vec2(0.0)); }";
      const includedCompilerModel = await shaderModel(document([
        "#version 450", "#pragma stage vertex", "void main() { gl_Position = vec4(0.0); }",
        "#pragma stage fragment", '#include "bad-call.inc"',
        "layout(location = 0) out vec4 color;", "void main() { color = invalidSample(); }"
      ].join("\n")));
      const includedCompilerIssues = await validateWithCompiler(includedCompilerModel, process.env.GLSLANG_TEST_PATH);
      assert.ok(includedCompilerIssues.some(issue => issue.uri.path.endsWith("bad-call.inc") && issue.rootLine === 4));
    const signatures = await builtinSignatures(process.env.GLSLANG_TEST_PATH, "fragment", "#version 450");
    assert.ok(signatures.get("texture").some(signature => signature.includes("sampler2D")));
    await assert.rejects(() => validateWithCompiler(compilerModel, "C:\\missing\\glslangValidator.exe"));
  }

  const providers = {};
  const disposable = { dispose() {} };
  const event = () => disposable;
  Object.assign(vscode, {
    Range: class Range {
      constructor(startLine, startCharacter, endLine, endCharacter) {
        this.start = { line: startLine, character: startCharacter };
        this.end = { line: endLine, character: endCharacter };
      }
    },
    Location: class Location {
      constructor(uri, range) { Object.assign(this, { uri, range }); }
    },
    MarkdownString: class MarkdownString {
      constructor(value = "") { this.value = value; }
      appendMarkdown(value) { this.value += value; return this; }
      appendText(value) { this.value += value; return this; }
      appendCodeblock(value) { this.value += `\n${value}\n`; return this; }
    },
    SemanticTokensLegend: class SemanticTokensLegend {
      constructor(tokenTypes, tokenModifiers) { Object.assign(this, { tokenTypes, tokenModifiers }); }
    },
    SignatureHelp: class SignatureHelp {},
    SignatureInformation: class SignatureInformation {
      constructor(label) { this.label = label; this.parameters = []; }
    },
    ParameterInformation: class ParameterInformation {
      constructor(label) { this.label = label; }
    },
    EventEmitter: class EventEmitter {
      constructor() { this.event = () => disposable; }
      fire() {}
      dispose() {}
    },
    SemanticTokensBuilder: class SemanticTokensBuilder {
      constructor() { this.tokens = []; }
      push(...token) { this.tokens.push(token); }
      build() { return this.tokens; }
    },
    Hover: class Hover {
      constructor(contents, range) { Object.assign(this, { contents, range }); }
    },
    window: {
      createOutputChannel: () => ({ ...disposable, appendLine() {} }),
      showWarningMessage: message => warnings.push(message)
    },
    languages: {
      createDiagnosticCollection: () => ({ ...disposable, set() {}, delete() {} }),
      registerDefinitionProvider: (selector, provider) => { providers.definition = provider; return disposable; },
      registerHoverProvider: (selector, provider) => { providers.hover = provider; return disposable; },
      registerDocumentSemanticTokensProvider: (selector, provider) => { providers.semantic = provider; return disposable; },
      registerSignatureHelpProvider: (selector, provider) => { providers.signature = provider; return disposable; },
      registerDocumentLinkProvider: () => disposable,
      registerDocumentSymbolProvider: () => disposable,
      registerCompletionItemProvider: () => disposable
    }
  });
  const warnings = [];
  Object.assign(vscode.workspace, {
    onDidOpenTextDocument: event,
    onDidChangeTextDocument: event,
    onDidSaveTextDocument: event,
    onDidCloseTextDocument: event,
    onDidChangeConfiguration: event,
    createFileSystemWatcher: () => ({ ...disposable, onDidCreate: event, onDidChange: event, onDidDelete: event })
  });
  vscode.workspace.getConfiguration = () => ({ get: (name, fallback) =>
    name === "glslangValidatorPath" ? process.env.GLSLANG_TEST_PATH || "test-compiler" : fallback });
  sandbox.module.exports.activate({ subscriptions: [] });
  if (process.env.GLSLANG_TEST_PATH) {
    vscode.workspace.getConfiguration = () => ({ get: (name, fallback) =>
      name === "glslangValidatorPath" ? process.env.GLSLANG_TEST_PATH : fallback });
    const signatureDoc = document("#version 450\n#pragma stage fragment\nvoid main() { texture(Source, vec2(0.0)); }");
    const callLine = signatureDoc.lineAt(2).text;
    const signatureHelp = await providers.signature.provideSignatureHelp(signatureDoc,
      { line: 2, character: callLine.indexOf("vec2") }, { isCancellationRequested: false });
    assert.ok(signatureHelp.signatures.some(signature => signature.label.includes("sampler2D")));
    assert.strictEqual(signatureHelp.activeParameter, 1);
    const builtinHover = await providers.hover.provideHover(signatureDoc,
      { line: 2, character: callLine.indexOf("texture") }, { isCancellationRequested: false });
    assert.ok(builtinHover.contents.value.includes("GLSL built-in"));
    assert.ok(builtinHover.contents.value.includes("Samples a texture"));
    assert.ok(builtinHover.contents.value.includes("texture("));
    const typedTextureDoc = document([
      "#version 450", "#pragma stage fragment", "uniform sampler2D Source;",
      "in vec2 uv;", "void main() { texture(Source, uv); }"
    ].join("\n"));
    const typedTextureHover = await providers.hover.provideHover(typedTextureDoc,
      { line: 4, character: typedTextureDoc.lineAt(4).text.indexOf("texture") });
    assert.ok(typedTextureHover.contents.value.includes("texture(in sampler2D , in 2-component vector of float)"));
    assert.ok(!typedTextureHover.contents.value.includes("texture(in samplerCube"));
    assert.ok(!typedTextureHover.contents.value.includes("texture(in isampler2D"));
  }
  const calls = [];
  signatureLoader = async (...args) => {
    calls.push(args);
    return new Map([["mix", ["float mix(in float, in float, in float)"]]]);
  };
  vscode.workspace.getConfiguration = () => ({ get: (name, fallback) =>
    name === "glslangValidatorPath" ? "mock-compiler" : fallback });
  const hoverDoc = document("#version 310 es\n#pragma stage vertex\nvoid main() { float a = mix(1.0, 2.0, 0.5); }");
  const hoverPosition = { line: 2, character: hoverDoc.lineAt(2).text.indexOf("mix") };
  const builtinHover = await providers.hover.provideHover(hoverDoc, hoverPosition, { isCancellationRequested: false });
  assert.ok(builtinHover.contents.value.includes("float mix(in float"));
  assert.ok(builtinHover.contents.value.includes("Interpolates"));
  assert.deepStrictEqual(calls[0], ["mock-compiler", "vertex", "#version 310 es"]);
  await providers.hover.provideHover(hoverDoc, hoverPosition, { isCancellationRequested: false });
  assert.strictEqual(calls.length, 1);
  const hoverSignature = await providers.signature.provideSignatureHelp(hoverDoc,
    { line: 2, character: hoverDoc.lineAt(2).text.indexOf("1.0") }, { isCancellationRequested: false });
  assert.strictEqual(hoverSignature.signatures.length, 1);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(await providers.hover.provideHover(hoverDoc, hoverPosition, { isCancellationRequested: true }), null);
  const commentedCall = document("// mix(1.0, 2.0, 0.5)");
  assert.strictEqual(await providers.hover.provideHover(commentedCall, { line: 0, character: 3 }), null);
  const userFunction = document("float mix(float a) { return a; }\nvoid main() { float x = mix(1.0); }");
  const userHover = await providers.hover.provideHover(userFunction, { line: 1, character: 24 });
  assert.ok(userHover.contents.value.includes("float mix("));
  assert.ok(!userHover.contents.value.includes("GLSL built-in"));
  const includeHoverDoc = document("float test() { return mix(1.0, 2.0, 0.5); }", "C:\\shaders\\utility.inc");
  assert.ok((await providers.hover.provideHover(includeHoverDoc, { line: 0, character: 22 })).contents.value.includes("GLSL built-in"));
  assert.deepStrictEqual(calls[1], ["mock-compiler", "fragment", "#version 450"]);

  signatureLoader = async () => new Map([
    ["texture", [
      "vec4 texture(in samplerCube, in 3-component vector of float)",
      "vec4 texture(in sampler2D, in 3-component vector of float)",
      "vec4 texture(in sampler2D, in 2-component vector of float)",
      "vec4 texture(in sampler2D, in 2-component vector of float, in float)"
    ]],
    ["sin", [
      "2-component vector of float sin(in 2-component vector of float)",
      "float sin(in float)",
      "double sin(in double)",
      "bool sin(in bool)",
      "unknown sin(in specialType)"
    ]]
  ]);
  vscode.workspace.getConfiguration = () => ({ get: (name, fallback) =>
    name === "glslangValidatorPath" ? "typed-overloads" : fallback });
  files["C:\\shaders\\samplers.inc"] = "uniform sampler2D Source;\nin vec2 uv;";
  async function hoverCall(doc, line, name) {
    return (await providers.hover.provideHover(doc, { line, character: doc.lineAt(line).text.indexOf(name) })).contents.value;
  }
  const typedDoc = document([
    "#pragma stage fragment", '#include "samplers.inc"',
    "void main() { texture(Source, uv); }"
  ].join("\n"));
  const typedHover = await hoverCall(typedDoc, 2, "texture");
  assert.ok(typedHover.includes("texture(in sampler2D, in 2-component vector of float)"));
  assert.ok(!typedHover.includes("samplerCube"));
  assert.ok(!typedHover.includes("3-component vector"));
  assert.ok(!typedHover.includes("in float)"));
  const shadowDoc = document([
    "in vec3 uv;", "void main() { vec2 uv = vec2(0.0); sin(uv); }"
  ].join("\n"));
  const shadowCallHover = await hoverCall(shadowDoc, 1, "sin");
  assert.ok(shadowCallHover.includes("sin(in 2-component vector of float)"));
  assert.ok(!shadowCallHover.includes("sin(in bool)"));
  const parameterDoc = document("void f(float v) { sin(v); sin(v + 1.0); sin(v); }");
  const scalarHover = await hoverCall(parameterDoc, 0, "sin");
  assert.ok(scalarHover.indexOf("sin(in float)") < scalarHover.indexOf("sin(in double)"));
  assert.ok(scalarHover.includes("sin(in specialType)"));
  assert.ok(!scalarHover.includes("sin(in bool)"));
  const swizzleDoc = document("void f(vec4 v) { sin(v.xy); }");
  const swizzleHover = await hoverCall(swizzleDoc, 0, "sin");
  assert.ok(swizzleHover.includes("sin(in 2-component vector of float)"));
  assert.ok(!swizzleHover.includes("sin(in float)"));
  const nestedDoc = document("vec2 coords() { return vec2(0.0); }\nvoid f() { sin(coords()); }");
  const nestedHover = await hoverCall(nestedDoc, 1, "sin");
  assert.ok(nestedHover.includes("sin(in 2-component vector of float)"));
  assert.ok(!nestedHover.includes("sin(in bool)"));
  const conditionalDoc = document("#if CHOICE\nvec2 value;\n#else\nfloat value;\n#endif\nvoid f() { sin(value); }");
  const conditionalHover = await hoverCall(conditionalDoc, 5, "sin");
  assert.ok(conditionalHover.includes("sin(in bool)"));
  const arrayDoc = document("void f(float v[2]) { sin(v); }");
  const arrayHover = await hoverCall(arrayDoc, 0, "sin");
  assert.ok(arrayHover.includes("sin(in bool)"));
  const extensionTypeDoc = document("uniform float16_t value;\nvoid f() { sin(value); }");
  const extensionTypeHover = await hoverCall(extensionTypeDoc, 1, "sin");
  assert.ok(extensionTypeHover.includes("sin(in float)"));
  assert.ok(extensionTypeHover.includes("sin(in bool)"));
  const unknownHover = await providers.hover.provideHover(parameterDoc,
    { line: 0, character: parameterDoc.lineAt(0).text.indexOf("sin(v +") });
  assert.ok(unknownHover.contents.value.includes("sin(in bool)"));
  const partialDoc = document("uniform sampler2D Source;\nvoid main() { texture(Source, unknown); }");
  const partialHover = await hoverCall(partialDoc, 1, "texture");
  assert.ok(partialHover.includes("2-component vector"));
  assert.ok(partialHover.includes("3-component vector"));
  assert.ok(!partialHover.includes("samplerCube"));
  const incompleteDoc = document("uniform sampler2D Source;\nvoid main() { texture(Source, vec2(0.0); }");
  const incompleteHover = await hoverCall(incompleteDoc, 1, "texture");
  assert.ok(incompleteHover.includes("samplerCube"));
  assert.ok(incompleteHover.includes("in float)"));
  const fallbackDoc = document("void main() { texture(true); }");
  const fallbackHover = await hoverCall(fallbackDoc, 0, "texture");
  assert.ok(fallbackHover.includes("No candidate matched"));
  assert.ok(fallbackHover.includes("samplerCube"));

  const manyDoc = document("#version 450\nvoid main() { sin(1.0); }");
  signatureLoader = async () => new Map([["sin", Array.from({ length: 15 }, (_, i) => `float sin(type${i})`)]]);
  vscode.workspace.getConfiguration = () => ({ get: (name, fallback) =>
    name === "glslangValidatorPath" ? "many-overloads" : fallback });
  const manyHover = await providers.hover.provideHover(manyDoc, { line: 1, character: 14 });
  assert.ok(manyHover.contents.value.includes("Showing 12 of 15 overloads"));
  assert.ok(!manyHover.contents.value.includes("type14"));
  signatureLoader = async () => { throw new Error("compiler unavailable"); };
  vscode.workspace.getConfiguration = () => ({ get: (name, fallback) =>
    name === "glslangValidatorPath" ? "missing-compiler" : fallback });
  assert.strictEqual(await providers.hover.provideHover(hoverDoc, hoverPosition), null);
  assert.ok(warnings.some(message => message.includes("compiler unavailable")));
  vscode.workspace.textDocuments.push(unsaved);
  const position = { line: 5, character: 15 };
  const definitions = await providers.definition.provideDefinition(rootDocument, position);
  assert.strictEqual(definitions.length, 1);
  assert.strictEqual(definitions[0].uri.path, unsaved.uri.path);
  assert.strictEqual(definitions[0].range.start.character, 18);
  const hover = await providers.hover.provideHover(rootDocument, position);
  assert.ok(hover.contents.value.includes("Unsaved"));
  vscode.workspace.textDocuments.pop();
  const functionDefinitions = await providers.definition.provideDefinition(semanticDocument, { line: 10, character: 28 });
  assert.strictEqual(functionDefinitions.length, 1);
  assert.strictEqual(functionDefinitions[0].uri.path, "C:\\shaders\\functions.inc");
  assert.strictEqual(functionDefinitions[0].range.start.line, 0);
  const stageDefinitions = await providers.definition.provideDefinition(semanticDocument, { line: 12, character: 29 });
  assert.ok(stageDefinitions.some(item => item.range.start.line === 9));

  files["C:\\shaders\\documented.inc"] = [
    "/**",
    " * Apply the curve.",
    " * Preserves alpha.",
    " */",
    "float curve(",
    "    float x) { // Inline details",
    "  return x;",
    "}"
  ].join("\n");
  const docsDocument = document([
    '#include "documented.inc"',
    "// Controls gain.",
    '#pragma parameter Gain "Gain" 1 0 2 // Adjusts intensity.',
    "uniform UBO {",
    "  // Used by the frontend.",
    "  float Gain; // Scale factor.",
    "};",
    "#pragma stage fragment",
    "void main() { float f = curve(Gain); }",
    "// Disconnected comment.",
    "",
    "float unrelated;"
  ].join("\n"));
  const docModel = await shaderModel(docsDocument);
  const docSemantic = buildSemanticModel(docModel);
  const functionSymbol = docSemantic.symbols.find(symbol => symbol.name === "curve");
  assert.strictEqual(functionSymbol.documentation, "Apply the curve.\nPreserves alpha.\nInline details");
  assert.strictEqual(docSemantic.symbols.find(symbol => symbol.name === "Gain").documentation, "Used by the frontend.\nScale factor.");
  assert.strictEqual(docSemantic.symbols.find(symbol => symbol.name === "unrelated").documentation, "");
  assert.strictEqual(docModel.parameters[0].documentation, "Controls gain.\nAdjusts intensity.");
  const parameterHover = await providers.hover.provideHover(docsDocument, { line: 8, character: 30 });
  assert.ok(parameterHover.contents.value.includes("Controls gain."));
  assert.ok(parameterHover.contents.value.includes("Scale factor."));
  const functionHover = await providers.hover.provideHover(docsDocument, { line: 8, character: 24 });
  assert.ok(functionHover.contents.value.includes("Apply the curve."));
  assert.ok(functionHover.contents.value.includes("Inline details"));
  const semanticTokens = await providers.semantic.provideDocumentSemanticTokens(docsDocument, { isCancellationRequested: false });
  assert.ok(semanticTokens.some(token => token[0] === 2 && token[3] === 0 && token[4] === 1));
  assert.ok(semanticTokens.some(token => token[0] === 8 && token[1] === 24 && token[3] === 1));
  assert.ok(semanticTokens.some(token => token[0] === 8 && token[1] === 30 && token[3] === 0));
  assert.strictEqual(await providers.semantic.provideDocumentSemanticTokens(docsDocument, { isCancellationRequested: true }), null);
  const aliasDocument = document([
    "#pragma name BlurPass",
    "#pragma stage fragment",
    "vec4 color = texture(BlurPassFeedback, uv);",
    "// BlurPassFeedback is a previous frame."
  ].join("\n"));
  const aliasTokens = await providers.semantic.provideDocumentSemanticTokens(aliasDocument, { isCancellationRequested: false });
  assert.ok(aliasTokens.some(token => token[0] === 0 && token[3] === 3 && token[4] === 1));
  assert.ok(aliasTokens.some(token => token[0] === 2 && token[3] === 3 && token[2] === "BlurPassFeedback".length));
  assert.ok(aliasTokens.every(token => token[0] !== 3));

  const nonDocs = document([
    "float first; /* inline",
    " * not next */",
    "float second;",
    "// comment mentioning Gain",
    'const float url = 1.0; // https://example',
    "float Gain;"
  ].join("\n"));
  const nonDocSemantic = buildSemanticModel(await shaderModel(nonDocs));
  assert.strictEqual(nonDocSemantic.symbols.find(symbol => symbol.name === "second").documentation, "");
  assert.strictEqual(nonDocSemantic.symbols.find(symbol => symbol.name === "Gain").documentation, "");
  const multilineComment = document([
    "float intensity; /* First line",
    " * Second line. */",
    "float other;"
  ].join("\n"));
  const multilineSemantic = buildSemanticModel(await shaderModel(multilineComment));
  assert.strictEqual(multilineSemantic.symbols.find(symbol => symbol.name === "intensity").documentation, "First line\nSecond line.");
  assert.strictEqual(multilineSemantic.symbols.find(symbol => symbol.name === "other").documentation, "");

  const scopedDoc = document([
    "// Global scale.",
    "float amount;",
    "struct Pixel { vec4 color; };",
    "float shade(in float inputValue) {",
    "  // Local scale.",
    "  float amount = inputValue; // Local detail.",
    "  {",
    "    // Inner scale.",
    "    vec2 amount = vec2(0.0);",
    "    float x = amount.x;",
    "  }",
    "  return amount + inputValue;",
    "}",
    "float other(float inputValue) { return inputValue + amount; }",
    "Pixel convert(Pixel value) { return value; }"
  ].join("\n"));
  const hoverAt = async (line, word) => providers.hover.provideHover(scopedDoc, {
    line, character: scopedDoc.lineAt(line).text.indexOf(word)
  });
  const localHover = await hoverAt(11, "amount");
  assert.ok(localHover.contents.value.includes("Local scale."));
  assert.ok(localHover.contents.value.includes("Local detail."));
  assert.ok(!localHover.contents.value.includes("Inner scale."));
  const innerHover = await hoverAt(9, "amount");
  assert.ok(innerHover.contents.value.includes("Inner scale."));
  const globalHover = await hoverAt(13, "amount");
  assert.ok(globalHover.contents.value.includes("Global scale."));
  const parameterHover2 = await hoverAt(11, "inputValue");
  assert.ok(parameterHover2.contents.value.includes("float inputValue"));
  const tokens = await providers.semantic.provideDocumentSemanticTokens(scopedDoc, { isCancellationRequested: false });
  const hasToken = (line, word, type, declaration) => tokens.some(token =>
    token[0] === line && token[1] === scopedDoc.lineAt(line).text.indexOf(word) &&
    token[3] === type && token[4] === declaration);
  assert.ok(hasToken(2, "Pixel", 4, 1));
  assert.ok(hasToken(14, "Pixel", 4, 0));
  assert.ok(hasToken(3, "inputValue", 0, 1));
  assert.ok(hasToken(11, "inputValue", 0, 0));
  assert.ok(hasToken(5, "amount", 3, 1));
  assert.ok(hasToken(11, "amount", 3, 0));
  assert.ok(hasToken(13, "inputValue", 0, 1));
  const commentsOnly = document("// texture(inputValue) Pixel\n");
  const commentTokens = await providers.semantic.provideDocumentSemanticTokens(commentsOnly, { isCancellationRequested: false });
  assert.strictEqual(commentTokens.length, 0);
  files["C:\\shaders\\local-function.inc"] = [
    "float doWork(float inputValue) {",
    "  // Returned scale.",
    "  float result = inputValue;",
    "  return result;",
    "}"
  ].join("\n");
  const includedLocal = document('#include "local-function.inc"');
  const includedSemantic = buildSemanticModel(await shaderModel(includedLocal));
  assert.strictEqual(includedSemantic.symbols.find(symbol => symbol.name === "result").documentation, "Returned scale.");
  assert.strictEqual(includedSemantic.symbols.find(symbol => symbol.name === "inputValue").kind, "functionParameter");
  const shadowBuiltin = document([
    "float f(float MVP) {",
    "  // Local source.",
    "  float SourceSize = MVP;",
    "  return SourceSize;",
    "}"
  ].join("\n"));
  const shadowHover = await providers.hover.provideHover(shadowBuiltin, { line: 3, character: 10 });
  assert.ok(shadowHover.contents.value.includes("Local source."));
  assert.ok(!shadowHover.contents.value.includes("built-in uniform"));
  const shaderParameterShadow = document([
    '#pragma parameter Gain "Gain" 1 0 2',
    "float f(float Gain) { return Gain; }"
  ].join("\n"));
  const shadowTokens = await providers.semantic.provideDocumentSemanticTokens(shaderParameterShadow, { isCancellationRequested: false });
  const gainLine = shaderParameterShadow.lineAt(1).text;
  assert.ok(shadowTokens.some(token => token[0] === 1 && token[1] === gainLine.lastIndexOf("Gain") && token[3] === 0));
  const shadowParameterHover = await providers.hover.provideHover(shaderParameterShadow, {
    line: 1, character: gainLine.lastIndexOf("Gain")
  });
  assert.ok(!shadowParameterHover.contents.value.includes("Libretro parameter"));
  const initializedGlobal = document([
    "// Initial tone.",
    "vec4 tone = vec4(1.0);",
    "void main() { vec4 value = tone; }"
  ].join("\n"));
  const initializedHover = await providers.hover.provideHover(initializedGlobal, { line: 2, character: 28 });
  assert.ok(initializedHover.contents.value.includes("Initial tone."));
  console.log("Extension metadata, grammar, include model, and diagnostic tests passed.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
