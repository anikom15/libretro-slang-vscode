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

const vscode = require("vscode");
const { buildIncludeModel, includeAtLine, uncommentLines } = require("./include-model");
const { builtinType, buildSemanticModel, resolveAt, semanticIssues, outputIssues, callArgumentTypes } = require("./semantic-model");
const { validateWithCompiler, builtinSignatures, rankBuiltinOverloads } = require("./glsl-compiler");

const PRESET_KEYS = [
  "shaders",
  "shader",
  "filter_linear",
  "wrap_mode",
  "scale_type",
  "scale_x",
  "scale_y",
  "mipmap_input",
  "float_framebuffer",
  "srgb_framebuffer",
  "frame_count_mod",
  "alias",
  "textures"
];

const PRAGMAS = [
  "stage",
  "parameter",
  "include",
  "include_optional",
  "name",
  "alias",
  "format"
];

const FORMATS = [
  "R8_UNORM", "R8_UINT", "R8_SINT",
  "R8G8_UNORM", "R8G8_UINT", "R8G8_SINT",
  "R8G8B8A8_UNORM", "R8G8B8A8_UINT", "R8G8B8A8_SINT", "R8G8B8A8_SRGB",
  "A2B10G10R10_UNORM_PACK32", "A2B10G10R10_UINT_PACK32",
  "R16_UINT", "R16_SINT", "R16_SFLOAT",
  "R16G16_UINT", "R16G16_SINT", "R16G16_SFLOAT",
  "R16G16B16A16_UINT", "R16G16B16A16_SINT", "R16G16B16A16_SFLOAT",
  "R32_UINT", "R32_SINT", "R32_SFLOAT",
  "R32G32_UINT", "R32G32_SINT", "R32G32_SFLOAT",
  "R32G32B32A32_UINT", "R32G32B32A32_SINT", "R32G32B32A32_SFLOAT"
];

const BUILTIN_UNIFORMS = [
  "MVP", "SourceSize", "OutputSize", "FinalViewportSize", "OriginalSize",
  "FrameCount", "FrameDirection", "Rotation", "OriginalAspect",
  "OriginalAspectRotated", "OriginalFPS", "FrameTimeDelta"
];

const BUILTIN_DESCRIPTIONS = {
  texture: "Samples a texture at the supplied coordinates.",
  textureLod: "Samples a texture using an explicit level of detail.",
  texelFetch: "Fetches a texel at integer coordinates.",
  textureSize: "Returns the dimensions of a texture at a given level of detail.",
  mix: "Interpolates between values using the supplied weight or selector.",
  clamp: "Restricts a value to a specified range.",
  smoothstep: "Interpolates smoothly between two edges.",
  dot: "Computes the dot product of two vectors.",
  cross: "Computes the cross product of two three-dimensional vectors.",
  normalize: "Returns a vector with the same direction and unit length.",
  length: "Returns the length of a vector.",
  distance: "Returns the distance between two points.",
  fract: "Returns the fractional part of a value.",
  mod: "Computes the GLSL floating-point modulus.",
  dFdx: "Computes the derivative with respect to the window x coordinate.",
  dFdy: "Computes the derivative with respect to the window y coordinate.",
  fwidth: "Returns the sum of the absolute x and y derivatives."
};

function lineRange(document, line) {
  return document.lineAt(line).range;
}

/** Collect parameter pragmas from the current document for the document outline. */
function findParameterDeclarations(document) {
  const declarations = [];
  const pattern = /^\s*#\s*pragma\s+parameter\s+([A-Za-z_]\w*)\s*(?:"([^"]*)")?\s*(.*)$/;
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    const match = text.match(pattern);
    if (match) {
      declarations.push({
        name: match[1],
        description: match[2] || "",
        values: (match[3] || "").trim(),
        line
      });
    }
  }
  return declarations;
}

/** Collect include directives with their document line numbers, ignoring comments. */
function collectIncludePaths(document) {
  const includes = [];
  const lines = uncommentLines(document.getText());
  for (let line = 0; line < lines.length; line++) {
    const include = includeAtLine(lines[line]);
    if (include) includes.push({ ...include, line });
  }
  return includes;
}

function resolveInclude(uri, path) {
  return vscode.Uri.joinPath(vscode.Uri.joinPath(uri, ".."), path);
}

/**
 * Expand a shader using open editor contents in preference to the filesystem.
 * Missing files return null to the include model; other read errors are reported
 * by that model as include issues.
 */
async function shaderModel(document) {
  return buildIncludeModel(
    { uri: document.uri, text: document.getText() },
    resolveInclude,
    async uri => {
      const open = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri.toString());
      if (open) return { uri, text: open.getText() };
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return { uri, text: Buffer.from(bytes).toString("utf8") };
      } catch (error) {
        if (error.code === "FileNotFound") return null;
        throw error;
      }
    }
  );
}

async function pathExists(uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function diagnostic(document, line, message, severity = vscode.DiagnosticSeverity.Error) {
  return new vscode.Diagnostic(lineRange(document, line), message, severity);
}

/**
 * Parse a preset assignment, keeping the value's source offset for document links.
 * Quoted values may contain # characters; unquoted values end at a comment.
 */
function presetAssignment(text, line) {
  const match = text.match(/^\s*([A-Za-z_]\w*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#]*?))\s*(?:#.*)?$/);
  if (!match) return null;
  const quoted = match[2] !== undefined || match[3] !== undefined;
  const value = quoted ? (match[2] !== undefined ? match[2] : match[3]) : match[4].trim();
  const valueStart = text.indexOf("=", text.indexOf(match[1]) + match[1].length) + 1;
  const leading = text.slice(valueStart).match(/^\s*/)[0].length;
  return { key: match[1], value, line, start: valueStart + leading + (quoted ? 1 : 0) };
}

/**
 * Produce Slang structure and semantic diagnostics for an expanded shader.
 * Included-file issues are reported on their corresponding root document line.
 */
async function validateSlang(document, model) {
  const diagnostics = [];
  if (!document.lineCount) return diagnostics;

  const isShader = /\.slang$/i.test(document.uri.path);
  const first = document.lineAt(0).text.trim();
  if (isShader && !/^#\s*version\s+(?:450|310\s+es|\d+)/i.test(first)) {
    diagnostics.push(diagnostic(document, 0, "A standalone .slang shader must start with a #version statement.", vscode.DiagnosticSeverity.Warning));
  }

  const stages = [];
  const parameters = new Map();

  for (const entry of model.entries) {
    const line = entry.rootLine;
    const text = entry.text;
    if (/\.inc$/i.test(entry.uri.path) && /^\s*#\s*version\b/.test(text)) {
      const source = entry.uri.toString() === document.uri.toString() ? "" : ` (${entry.uri.toString()}:${entry.line + 1})`;
      diagnostics.push(diagnostic(document, line, "An .inc file cannot contain a #version statement." + source));
    }
    let match = text.match(/^\s*#\s*pragma\s+stage\s+(vertex|fragment)\s*$/i);
    if (match) stages.push({ type: match[1].toLowerCase(), line });

    match = text.match(/^\s*#\s*pragma\s+format\s+(\S+)/i);
    if (match) {
      const format = match[1];
      if (!FORMATS.includes(format)) {
        diagnostics.push(diagnostic(document, line, `"${format}" is not a supported .slang framebuffer format.`));
      }
    }

    if (/^\s*#\s*pragma\s+parameter\b/i.test(text) &&
        !model.parameters.some(parameter => parameter.uri.toString() === entry.uri.toString() &&
          parameter.line === entry.line && parameter.rootLine === entry.rootLine)) {
      diagnostics.push(diagnostic(document, line, 'Expected: #pragma parameter IDENTIFIER "DESCRIPTION" INITIAL MINIMUM MAXIMUM [STEP]'));
    }
  }

  for (const parameter of model.parameters) {
    const values = parameter.values.trim().split(/\s+/);
    if (values.some(value => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value)))) {
      diagnostics.push(diagnostic(document, parameter.rootLine,
        `Parameter "${parameter.name}" values must be finite numbers.`));
    }
    if (values.length === 3) {
      diagnostics.push(diagnostic(document, parameter.rootLine,
        `Parameter "${parameter.name}" omits the optional step value; specify a step for consistency.`,
        vscode.DiagnosticSeverity.Warning));
    }
    if (parameters.has(parameter.name) && parameters.get(parameter.name) !== parameter.signature) {
      diagnostics.push(diagnostic(document, parameter.rootLine, `Duplicate parameter "${parameter.name}" must match exactly across shader passes and includes.`));
    } else {
      parameters.set(parameter.name, parameter.signature);
    }
  }

  const vertex = stages.find(stage => stage.type === "vertex");
  const fragment = stages.find(stage => stage.type === "fragment");
  if (isShader && !vertex) diagnostics.push(diagnostic(document, 0, 'Missing required "#pragma stage vertex" for a standalone shader.', vscode.DiagnosticSeverity.Warning));
  if (isShader && !fragment) diagnostics.push(diagnostic(document, 0, 'Missing required "#pragma stage fragment" for a standalone shader.', vscode.DiagnosticSeverity.Warning));
  if (vertex && fragment && stages.filter(stage => stage.type === "vertex").length === 1 &&
      stages.filter(stage => stage.type === "fragment").length === 1 &&
      stages.indexOf(vertex) > stages.indexOf(fragment)) {
    diagnostics.push(diagnostic(document, fragment.line, 'Conventionally, the vertex stage appears before the fragment stage.', vscode.DiagnosticSeverity.Warning));
  }
  if (stages.filter(stage => stage.type === "vertex").length > 1 ||
      stages.filter(stage => stage.type === "fragment").length > 1) {
    diagnostics.push(diagnostic(document, 0, "A shader file may declare each stage only once."));
  }

  for (const issue of model.issues) {
    const source = issue.uri.toString() === document.uri.toString() ? "" : ` (${issue.uri.toString()}:${issue.line + 1})`;
    diagnostics.push(diagnostic(document, issue.rootLine, issue.message + source));
  }

  const semantic = buildSemanticModel(model);
  const issues = semanticIssues(model, semantic);
  if (isShader) issues.push(...outputIssues(model, semantic));
  for (const issue of issues) {
    const source = issue.uri.toString() === document.uri.toString() ? "" : ` (${issue.uri.toString()}:${issue.line + 1})`;
    diagnostics.push(diagnostic(document, issue.rootLine, issue.message + source, vscode.DiagnosticSeverity.Warning));
  }

  return diagnostics;
}

/** Check preset syntax, shader count and referenced shader paths. */
async function validatePreset(document) {
  const diagnostics = [];
  const lines = [];
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    if (!text.trim() || /^\s*#/.test(text)) continue;
    const assignment = presetAssignment(text, line);
    if (!assignment) {
      diagnostics.push(diagnostic(document, line, "Expected preset syntax: key = value"));
      continue;
    }
    lines.push(assignment);
  }

  const keys = lines;
  const shadersEntry = keys.find(entry => entry.key === "shaders");
  const parsedCount = shadersEntry && /^\d+$/.test(shadersEntry.value) ? Number(shadersEntry.value) : 0;
  const count = Number.isSafeInteger(parsedCount) && parsedCount > 0 ? parsedCount : 0;
  if (shadersEntry && !count) {
    diagnostics.push(diagnostic(document, shadersEntry.line, '"shaders" must be a positive integer.'));
  }

  const declaredParameters = new Set();
  for (const entry of keys) {
    const shader = /^shader(0|[1-9]\d*)$/.exec(entry.key);
    if (!shader || Number(shader[1]) >= count || !entry.value) continue;
    const resolved = vscode.Uri.joinPath(vscode.Uri.joinPath(document.uri, ".."), entry.value);
    if (!(await pathExists(resolved))) {
      diagnostics.push(diagnostic(document, entry.line, `Shader "${entry.value}" was not found.`));
      continue;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(resolved);
      const text = Buffer.from(bytes).toString("utf8");
      for (const match of text.matchAll(/^\s*#\s*pragma\s+parameter\s+([A-Za-z_]\w*)\b/gm)) {
        declaredParameters.add(match[1]);
      }
    } catch {}
  }

  for (const entry of keys) {
    if (/^(shader|filter_linear|wrap_mode|scale_type|scale_x|scale_y|mipmap_input|float_framebuffer|srgb_framebuffer|frame_count_mod)\d*$/.test(entry.key)) continue;
    if (/^[_A-Za-z][\w]*_(linear|wrap_mode|mipmap)$/.test(entry.key)) continue;
    if (PRESET_KEYS.includes(entry.key)) continue;
    if (!declaredParameters.size || declaredParameters.has(entry.key)) continue;
    // Preset keys unknown to the loaded passes may be valid per-parameter overrides in other workflows.
  }

  return diagnostics;
}

/** Register language providers, diagnostics and workspace event handlers. */
function activate(context) {
  const slangSelector = { language: "libretro-slang", scheme: "file" };
  const presetSelector = { language: "libretro-slang-preset", scheme: "file" };
  const diagnosticCollection = vscode.languages.createDiagnosticCollection("libretro-slang");
  const output = vscode.window.createOutputChannel("Libretro Slang");
  const semanticChanges = new vscode.EventEmitter();
  const generations = new Map();
  const dependencies = new Map();
  const signatureCache = new Map();
  const validationTimers = new Map();
  const pendingModels = new Set();
  context.subscriptions.push(diagnosticCollection, output, semanticChanges);

  /**
   * Cache compiler signature requests by executable, stage and version.
   * Compiler failures are logged and surfaced to the user.
   */
  async function getBuiltinSignatures(document, stage) {
    const executable = vscode.workspace.getConfiguration("libretro-slang").get("glslangValidatorPath", "glslangValidator");
    const first = document.lineAt(0).text.trim();
    const version = /^#\s*version\s+\d+(?:\s+es)?/.exec(first);
    const versionLine = version ? version[0] : "#version 450";
    const cacheKey = `${executable}\n${stage}\n${versionLine}`;
    if (!signatureCache.has(cacheKey)) signatureCache.set(cacheKey, builtinSignatures(executable, stage, versionLine));
    try {
      return await signatureCache.get(cacheKey);
    } catch (error) {
      signatureCache.delete(cacheKey);
      output.appendLine(`GLSL signature help unavailable: ${error.stack || error.message}`);
      vscode.window.showWarningMessage(`GLSL signature help unavailable: ${error.message}`);
      return null;
    }
  }

  /** Refresh diagnostics, discarding results superseded by a newer update. */
  async function updateDiagnostics(document) {
    if (!document) return;
    const key = document.uri.toString();
    const generation = (generations.get(key) || 0) + 1;
    generations.set(key, generation);
    let diagnostics;
    if (document.languageId === "libretro-slang") {
      const enabled = vscode.workspace.getConfiguration("libretro-slang").get("validateStructure", true);
      if (enabled) {
        let model;
        try {
          model = await shaderModel(document);
        } finally {
          if (generations.get(key) === generation) pendingModels.delete(key);
        }
        if (generations.get(key) !== generation) return;
        dependencies.set(key, model.dependencies);
        diagnostics = await validateSlang(document, model);
        if (generations.get(key) !== generation) return;
        const configuration = vscode.workspace.getConfiguration("libretro-slang");
        if (/\.slang$/i.test(document.uri.path) && configuration.get("validateGlsl", true) &&
            /^\s*#\s*version\s+\d+/.test(document.lineAt(0).text)) {
          try {
            const issues = await validateWithCompiler(model, configuration.get("glslangValidatorPath", "glslangValidator"));
            for (const issue of issues) {
              const source = issue.uri.toString() === key ? "" : ` (${issue.uri.toString()}:${issue.line + 1})`;
              diagnostics.push(diagnostic(document, issue.rootLine, issue.message + source,
                issue.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning));
            }
          } catch (error) {
            diagnostics.push(diagnostic(document, 0, `GLSL validation unavailable: ${error.message}`, vscode.DiagnosticSeverity.Warning));
            output.appendLine(`GLSL validation failed for ${key}: ${error.stack || error.message}`);
          }
        }
      } else {
        diagnostics = [];
        pendingModels.delete(key);
        dependencies.set(key, new Set());
      }
    } else if (document.languageId === "libretro-slang-preset") {
      diagnostics = await validatePreset(document);
    } else {
      return;
    }
    if (generations.get(key) === generation && !document.isClosed) diagnosticCollection.set(document.uri, diagnostics);
  }

  function schedule(document) {
    const key = document.uri.toString();
    generations.set(key, (generations.get(key) || 0) + 1);
    if (document.languageId === "libretro-slang") pendingModels.add(key);
    clearTimeout(validationTimers.get(key));
    validationTimers.set(key, setTimeout(() => {
      validationTimers.delete(key);
      updateDiagnostics(document).catch(error => {
        output.appendLine(`Failed to validate ${key}: ${error.stack || error.message}`);
      });
    }, 500));
  }

  /** Refresh a changed shader and open shaders that include the changed URI. */
  function refreshAffected(uri, changedDocument, closed = false) {
    const key = uri.toString();
    let affected = false;
    for (const document of vscode.workspace.textDocuments) {
      if (document.languageId !== "libretro-slang" || (closed && document === changedDocument)) continue;
      const documentKey = document.uri.toString();
      const known = dependencies.get(documentKey);
      if (documentKey === key || pendingModels.has(documentKey) || !known || known.has(key)) {
        schedule(document);
        affected = true;
      }
    }
    if (affected) semanticChanges.fire();
  }

  function refreshShaders() {
    semanticChanges.fire();
    vscode.workspace.textDocuments.filter(document => document.languageId === "libretro-slang").forEach(schedule);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(document => {
      if (document.languageId === "libretro-slang-preset") schedule(document);
      refreshAffected(document.uri, document);
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.languageId === "libretro-slang-preset") schedule(event.document);
      refreshAffected(event.document.uri, event.document);
    }),
    vscode.workspace.onDidSaveTextDocument(document => {
      if (document.languageId === "libretro-slang-preset") schedule(document);
      refreshAffected(document.uri, document);
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      const key = document.uri.toString();
      generations.set(key, (generations.get(key) || 0) + 1);
      dependencies.delete(key);
      pendingModels.delete(key);
      clearTimeout(validationTimers.get(key));
      validationTimers.delete(key);
      diagnosticCollection.delete(document.uri);
      refreshAffected(document.uri, document, true);
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("libretro-slang")) {
        signatureCache.clear();
        refreshShaders();
      }
    })
  );
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  const onFileChanged = uri => {
    if (pendingModels.size || [...dependencies.values()].some(files => files.has(uri.toString()))) refreshAffected(uri);
  };
  context.subscriptions.push(watcher, watcher.onDidCreate(onFileChanged), watcher.onDidChange(onFileChanged), watcher.onDidDelete(onFileChanged));
  vscode.workspace.textDocuments.forEach(schedule);
  context.subscriptions.push({ dispose() {
    for (const timer of validationTimers.values()) clearTimeout(timer);
    validationTimers.clear();
  } });

  context.subscriptions.push(vscode.languages.registerDocumentLinkProvider(slangSelector, {
    provideDocumentLinks(document) {
      const links = [];
      for (const include of collectIncludePaths(document)) {
        const text = document.lineAt(include.line).text;
        const start = text.indexOf("\"" + include.path + "\"");
        if (start < 0) continue;
        const target = resolveInclude(document.uri, include.path);
        const range = new vscode.Range(include.line, start + 1, include.line, start + 1 + include.path.length);
        links.push(new vscode.DocumentLink(range, target));
      }
      return links;
    }
  }));

  context.subscriptions.push(vscode.languages.registerDocumentLinkProvider(presetSelector, {
    provideDocumentLinks(document) {
      const links = [];
      const assignments = [];
      for (let line = 0; line < document.lineCount; line++) {
        const assignment = presetAssignment(document.lineAt(line).text, line);
        if (assignment) assignments.push(assignment);
      }
      const textureNames = new Set(assignments.filter(item => item.key === "textures")
        .flatMap(item => item.value.split(";").map(name => name.trim()).filter(Boolean)));
      for (const assignment of assignments) {
        if (!assignment.value || (!/^shader\d+$/.test(assignment.key) && !textureNames.has(assignment.key))) continue;
        const target = resolveInclude(document.uri, assignment.value);
        links.push(new vscode.DocumentLink(
          new vscode.Range(assignment.line, assignment.start, assignment.line, assignment.start + assignment.value.length),
          target
        ));
      }
      return links;
    }
  }));

  context.subscriptions.push(vscode.languages.registerDefinitionProvider(slangSelector, {
    async provideDefinition(document, position) {
      const range = document.getWordRangeAtPosition(position);
      if (!range) return null;
      const word = document.getText(range);
      const model = await shaderModel(document);
      const semantic = buildSemanticModel(model);
      const resolved = resolveAt(model, semantic, document.uri, range.start.line, range.start.character, word);
      const definitions = [...resolved.parameters, ...resolved.symbols].filter(item =>
        item.uri.toString() !== document.uri.toString() || item.line !== range.start.line ||
        item.character !== range.start.character);
      return [...new Map(definitions.map(item => [
        `${item.uri.toString()}:${item.line}:${item.character}`, item
      ])).values()].map(item =>
        new vscode.Location(item.uri, new vscode.Range(item.line, item.character, item.line, item.character + item.name.length)));
    }
  }));

  const tokenLegend = new vscode.SemanticTokensLegend(
    ["parameter", "function", "property", "variable", "struct"], ["declaration"]
  );
  context.subscriptions.push(vscode.languages.registerDocumentSemanticTokensProvider(slangSelector, {
    onDidChangeSemanticTokens: semanticChanges.event,
    async provideDocumentSemanticTokens(document, cancellationToken) {
      const model = await shaderModel(document);
      if (cancellationToken.isCancellationRequested) return null;
      const semantic = buildSemanticModel(model);
      const names = new Set([...semantic.symbols.map(symbol => symbol.name), ...model.parameters.map(parameter => parameter.name)]);
      const aliases = new Set();
      for (const alias of model.aliases) {
        for (const suffix of ["", "Size", "Feedback", "FeedbackSize"]) aliases.add(alias.name + suffix);
      }
      const positions = new Map();
      const add = (line, character, name, type, declaration) => {
        const key = `${line}:${character}`;
        if (!positions.has(key)) positions.set(key, { line, character, name, type, declaration });
      };
      for (const parameter of model.parameters) {
        if (parameter.uri.toString() === document.uri.toString()) add(parameter.line, parameter.character, parameter.name, 0, true);
      }
      for (const alias of model.aliases) {
        if (alias.uri.toString() === document.uri.toString()) add(alias.line, alias.character, alias.name, 3, true);
      }
      for (const token of semantic.tokens) {
        if (cancellationToken.isCancellationRequested) return null;
        if (token.entry.uri.toString() !== document.uri.toString()) continue;
        const builtin = builtinType(token.value) ||
          /^(Original|Source|OriginalHistory\d+|PassOutput\d+|PassFeedback\d+|User\d+|UserSize\d+)$/.test(token.value);
        if (!names.has(token.value)) {
          if (aliases.has(token.value)) add(token.entry.line, token.character, token.value, 3, false);
          continue;
        }
        const resolved = resolveAt(model, semantic, document.uri, token.entry.line, token.character, token.value);
        if (builtin && !resolved.symbols.some(symbol => symbol.kind === "local" || symbol.kind === "functionParameter")) continue;
        const symbol = resolved.symbols.find(item => item.uri.toString() === document.uri.toString() &&
          item.line === token.entry.line && item.character === token.character);
        const candidate = symbol || resolved.symbols[0];
        if (!candidate && !resolved.parameters.length) continue;
        const type = resolved.parameters.length || candidate.kind === "functionParameter" ? 0 :
          candidate.kind === "struct" ? 4 : candidate.kind === "function" ? 1 :
          candidate.kind === "uniformMember" ? 2 : 3;
        add(token.entry.line, token.character, token.value, type, Boolean(symbol));
      }
      const builder = new vscode.SemanticTokensBuilder(tokenLegend);
      for (const token of [...positions.values()].sort((a, b) => a.line - b.line || a.character - b.character)) {
        builder.push(token.line, token.character, token.name.length, token.type, token.declaration ? 1 : 0);
      }
      return builder.build();
    }
  }, tokenLegend));

  context.subscriptions.push(vscode.languages.registerHoverProvider(slangSelector, {
    async provideHover(document, position, cancellationToken) {
      const range = document.getWordRangeAtPosition(position);
      if (!range) return null;
      const word = document.getText(range);
      const model = await shaderModel(document);
      const semantic = buildSemanticModel(model);
      const resolved = resolveAt(model, semantic, document.uri, range.start.line, range.start.character, word);
      const declaration = resolved.parameters[0];
      const markdown = new vscode.MarkdownString();
      if (declaration) {
        markdown.appendMarkdown(`**Libretro parameter** \`${declaration.name}\`\n\n`);
        markdown.appendText(declaration.description);
        markdown.appendMarkdown("\n\n");
        markdown.appendText(declaration.values);
      } else {
        const expected = !resolved.symbols.some(symbol => symbol.kind === "local" || symbol.kind === "functionParameter") && builtinType(word);
        if (expected) markdown.appendMarkdown(`Libretro built-in uniform: \`${expected} ${word}\``);
        else if (!resolved.symbols.length) {
          const index = semantic.tokens.findIndex(token =>
            token.entry.uri.toString() === document.uri.toString() && token.entry.line === range.start.line &&
            token.character === range.start.character && token.value === word);
          if (index < 0 || !semantic.tokens[index + 1] || semantic.tokens[index + 1].value !== "(" ||
              (semantic.tokens[index - 1] && semantic.tokens[index - 1].value === ".") ||
              semantic.symbols.some(symbol => symbol.kind === "function" && symbol.name === word)) return null;
          if (cancellationToken && cancellationToken.isCancellationRequested) return null;
          const signatures = await getBuiltinSignatures(document, semantic.tokens[index].entry.stage || "fragment");
          if ((cancellationToken && cancellationToken.isCancellationRequested) || !signatures || !signatures.has(word)) return null;
          const { overloads, fallback } = rankBuiltinOverloads([...new Set(signatures.get(word))],
            callArgumentTypes(model, semantic, index));
          markdown.appendMarkdown(`**GLSL built-in** \`${word}\`\n\n`);
          if (Object.prototype.hasOwnProperty.call(BUILTIN_DESCRIPTIONS, word)) {
            markdown.appendText(BUILTIN_DESCRIPTIONS[word]);
            markdown.appendMarkdown("\n\n");
          }
          if (fallback) markdown.appendMarkdown("No candidate matched the inferred argument types; showing all overloads.\n\n");
          markdown.appendCodeblock(overloads.slice(0, 12).join("\n"), "glsl");
          if (overloads.length > 12) {
            markdown.appendMarkdown(`\n\nShowing 12 of ${overloads.length} overloads. Use signature help for the full list.`);
          }
          markdown.appendMarkdown("\n\n[GLSL reference](https://registry.khronos.org/OpenGL-Refpages/gl4/)");
          return new vscode.Hover(markdown, range);
        }
      }
      const seen = new Set();
      for (const symbol of resolved.symbols) {
        const signature = symbol.kind === "function" ? `${symbol.type} ${symbol.name}(${symbol.parameters.join(", ")})` :
          `${symbol.type} ${symbol.name}${symbol.array}`;
        const key = `${signature}\n${symbol.documentation}`;
        if (seen.has(key)) continue;
        seen.add(key);
        markdown.appendMarkdown("\n\n");
        markdown.appendCodeblock(signature, "glsl");
        if (symbol.documentation) {
          markdown.appendMarkdown("\n\n");
          markdown.appendText(symbol.documentation);
        }
      }
      if (declaration && declaration.documentation) {
        markdown.appendMarkdown("\n\n");
        markdown.appendText(declaration.documentation);
      }
      return new vscode.Hover(markdown, range);
    }
  }));

  context.subscriptions.push(vscode.languages.registerSignatureHelpProvider(slangSelector, {
    async provideSignatureHelp(document, position, cancellationToken) {
      const model = await shaderModel(document);
      const semantic = buildSemanticModel(model);
      const tokens = semantic.tokens.filter(token => token.entry.uri.toString() === document.uri.toString() &&
        (token.entry.line < position.line || (token.entry.line === position.line && token.character < position.character)));
      let depth = 0;
      let commas = 0;
      let name;
      let stage;
      for (let i = tokens.length - 1; i >= 0; i--) {
        const value = tokens[i].value;
        if (value === ")" || value === "]") depth++;
        else if (value === "(" || value === "[") {
          if (depth) depth--;
          else if (value === "(" && i && /^[A-Za-z_]\w*$/.test(tokens[i - 1].value)) {
            name = tokens[i - 1].value;
            stage = tokens[i - 1].entry.stage || "fragment";
            break;
          } else return null;
        } else if (value === "," && depth === 0) commas++;
        else if ((value === ";" || value === "{") && depth === 0) return null;
      }
      if (!name || /^(if|while|for|switch|bool|int|uint|float|double|[biud]?vec[234]|d?mat[234](?:x[234])?)$/.test(name) ||
          cancellationToken.isCancellationRequested) return null;
      if (semantic.symbols.some(symbol => symbol.kind === "function" && symbol.name === name)) return null;
      const signatures = await getBuiltinSignatures(document, stage);
      if (cancellationToken.isCancellationRequested || !signatures || !signatures.has(name)) return null;
      const result = new vscode.SignatureHelp();
      result.signatures = signatures.get(name).map(label => {
        const signature = new vscode.SignatureInformation(label);
        const args = label.slice(label.indexOf("(") + 1, label.lastIndexOf(")")).trim();
        signature.parameters = args ? args.split(/\s*,\s*/).map(arg => new vscode.ParameterInformation(arg)) : [];
        return signature;
      });
      result.activeSignature = Math.max(0, result.signatures.findIndex(signature => signature.parameters.length > commas));
      result.activeParameter = commas;
      return result;
    }
  }, "(", ","));

  context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(slangSelector, {
    provideDocumentSymbols(document) {
      const symbols = [];
      for (const declaration of findParameterDeclarations(document)) {
        symbols.push(new vscode.DocumentSymbol(
          declaration.name,
          declaration.description || "shader parameter",
          vscode.SymbolKind.Variable,
          lineRange(document, declaration.line),
          lineRange(document, declaration.line)
        ));
      }
      for (let line = 0; line < document.lineCount; line++) {
        const match = document.lineAt(line).text.match(/^\s*#\s*pragma\s+stage\s+(vertex|fragment)\s*$/i);
        if (match) {
          symbols.push(new vscode.DocumentSymbol(
            `${match[1]} stage`,
            "shader stage",
            vscode.SymbolKind.Class,
            lineRange(document, line),
            lineRange(document, line)
          ));
        }
      }
      return symbols;
    }
  }));

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(slangSelector, {
    provideCompletionItems(document, position) {
      const line = document.lineAt(position).text.substring(0, position.character);
      const items = [];
      if (/^\s*$/.test(line)) {
        for (const pragma of PRAGMAS) items.push(new vscode.CompletionItem(`#pragma ${pragma}`, vscode.CompletionItemKind.Keyword));
      }
      if (/^\s*#\s*pragma\s*$/i.test(line) || /^\s*#\s*pragma\s+\w*$/.test(line)) {
        for (const pragma of PRAGMAS) items.push(new vscode.CompletionItem(pragma, vscode.CompletionItemKind.Keyword));
      }
      for (const uniform of BUILTIN_UNIFORMS) {
        items.push(new vscode.CompletionItem(uniform, vscode.CompletionItemKind.Variable));
      }
      return items;
    }
  }, "#"));

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(presetSelector, {
    provideCompletionItems() {
      return PRESET_KEYS.map(key => new vscode.CompletionItem(key, vscode.CompletionItemKind.Property));
    }
  }, "="));
}

function deactivate() {}

module.exports = { activate, deactivate };
