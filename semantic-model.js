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

"use strict";

const { definitionComment } = require("./include-model");

const BUILTIN_TYPES = {
  MVP: "mat4", OutputSize: "vec4", FinalViewportSize: "vec4",
  FrameCount: "uint", FrameDirection: "int", Rotation: "uint",
  OriginalAspect: "float", OriginalAspectRotated: "float",
  OriginalFPS: "float", FrameTimeDelta: "uint"
};
const QUALIFIERS = new Set([
  "const", "in", "out", "inout", "uniform", "flat", "smooth", "noperspective",
  "centroid", "sample", "invariant", "highp", "mediump", "lowp", "precise"
]);
const BASIC_TYPES = /^(?:bool|int|uint|float|double|[biud]?vec[234]|d?mat[234](?:x[234])?|sampler\w+)$/;

function builtinType(name) {
  if (Object.prototype.hasOwnProperty.call(BUILTIN_TYPES, name)) return BUILTIN_TYPES[name];
  if (/^(OriginalSize|SourceSize|OriginalHistorySize\d+|PassOutputSize\d+|PassFeedbackSize\d+)$/.test(name)) return "vec4";
  return null;
}

function tokensFor(model) {
  const tokens = [];
  let conditionalDepth = 0;
  for (const entry of model.entries) {
    const directive = entry.text.match(/^\s*#\s*(\w+)/);
    if (directive) {
      if (/^(if|ifdef|ifndef)$/.test(directive[1])) conditionalDepth++;
      else if (directive[1] === "endif") conditionalDepth = Math.max(0, conditionalDepth - 1);
      continue;
    }
    const pattern = /[A-Za-z_]\w*|(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?[uUfF]?|[^\s]/g;
    for (const match of entry.text.matchAll(pattern)) {
      tokens.push({ value: match[0], entry, character: match.index, conditional: conditionalDepth > 0 });
    }
  }
  return tokens;
}

function matching(tokens, start, open, close) {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].value === open) depth++;
    if (tokens[i].value === close && --depth === 0) return i;
  }
  return -1;
}

function splitComma(tokens) {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (["(", "["].includes(tokens[i].value)) depth++;
    if ([")", "]"].includes(tokens[i].value)) depth--;
    if (tokens[i].value === "," && depth === 0) {
      parts.push(tokens.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(tokens.slice(start));
  return parts;
}

function locationOf(token) {
  return { uri: token.entry.uri, line: token.entry.line, character: token.character,
    rootLine: token.entry.rootLine, stage: token.entry.stage, conditional: token.conditional };
}

function declarations(tokens, kind, extra = {}, terminator) {
  let i = 0;
  let location = null;
  const qualifiers = [];
  while (i < tokens.length) {
    if (tokens[i].value === "layout" && tokens[i + 1] && tokens[i + 1].value === "(") {
      const end = matching(tokens, i + 1, "(", ")");
      if (end < 0) return [];
      const layout = tokens.slice(i + 2, end);
      for (let j = 0; j + 2 < layout.length; j++) {
        if (layout[j].value === "location" && layout[j + 1].value === "=" && /^\d+$/.test(layout[j + 2].value)) {
          location = Number(layout[j + 2].value);
        }
      }
      i = end + 1;
    } else if (QUALIFIERS.has(tokens[i].value)) {
      qualifiers.push(tokens[i++].value);
    } else {
      break;
    }
  }
  if (!tokens[i] || !/^[A-Za-z_]\w*$/.test(tokens[i].value)) return [];
  const type = tokens[i++].value;
  const result = [];
  for (const part of splitComma(tokens.slice(i))) {
    const name = part[0];
    if (!name || !/^[A-Za-z_]\w*$/.test(name.value)) continue;
    let array = "";
    if (part[1] && part[1].value === "[") {
      const end = matching(part, 1, "[", "]");
      if (end < 0) continue;
      array = part.slice(1, end + 1).map(token => token.value).join("");
    } else if (part[1] && part[1].value !== "=") {
      continue;
    }
    result.push({ ...locationOf(name), ...extra, name: name.value, type, array, kind, qualifiers, location,
      documentation: definitionComment(tokens[0], terminator),
      conditional: tokens.some(token => token.conditional) });
    location = null;
  }
  return result;
}

function buildSemanticModel(model) {
  const tokens = tokensFor(model);
  const symbols = [];
  const structNames = new Set();
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (tokens[i].value === "struct" && /^[A-Za-z_]\w*$/.test(tokens[i + 1].value) &&
        tokens[i + 2].value === "{") {
      structNames.add(tokens[i + 1].value);
      symbols.push({ ...locationOf(tokens[i + 1]), name: tokens[i + 1].value,
        type: "struct", kind: "struct", array: "",
        documentation: definitionComment(tokens[i], tokens[i + 2]) });
    }
  }
  function localDeclarations(begin, end) {
    const scopes = [{ start: begin, end }];
    let statement = begin + 1;
    let depth = 0;
    for (let j = begin + 1; j < end; j++) {
      const value = tokens[j].value;
      if (value === "(" || value === "[") depth++;
      else if (value === ")" || value === "]") depth--;
      if (depth !== 0) continue;
      if (value === "{") {
        const close = matching(tokens, j, "{", "}");
        if (close < 0 || close > end) break;
        scopes.push({ start: j, end: close });
        statement = j + 1;
      } else if (value === "}") {
        scopes.pop();
        statement = j + 1;
      } else if (value === ";") {
        const prefix = tokens.slice(statement, j);
        const found = declarations(prefix, "local", { scopeStart: scopes[scopes.length - 1].start,
          scopeEnd: scopes[scopes.length - 1].end }, tokens[j]);
        for (const symbol of found) {
          if (BASIC_TYPES.test(symbol.type) || structNames.has(symbol.type)) {
            symbol.declarationIndex = statement + prefix.findIndex(token =>
              token.entry.uri.toString() === symbol.uri.toString() &&
              token.entry.line === symbol.line && token.character === symbol.character);
            symbols.push(symbol);
          }
        }
        statement = j + 1;
      }
    }
  }
  let start = 0;
  let parens = 0;
  let brackets = 0;
  for (let i = 0; i < tokens.length; i++) {
    const value = tokens[i].value;
    let consumedBlock = false;
    if (value === "(") parens++;
    else if (value === ")") parens--;
    else if (value === "[") brackets++;
    else if (value === "]") brackets--;
    if (parens !== 0 || brackets !== 0) continue;
    if (value !== ";" && value !== "{") continue;
    const prefix = tokens.slice(start, i);
    const uniformIndex = prefix.findIndex(token => token.value === "uniform");
    const functionOpen = prefix.findIndex((token, index) =>
      token.value === "(" && index > 0 && prefix[index - 1].value !== "layout");
    if (functionOpen >= 2 && prefix[prefix.length - 1].value === ")" &&
        /^[A-Za-z_]\w*$/.test(prefix[functionOpen - 2].value) &&
        prefix.slice(0, functionOpen - 2).every(token => QUALIFIERS.has(token.value))) {
      const name = prefix[functionOpen - 1];
      const returnType = prefix[functionOpen - 2];
      if (returnType && /^[A-Za-z_]\w*$/.test(name.value) && /^[A-Za-z_]\w*$/.test(returnType.value)) {
        const args = prefix.slice(functionOpen + 1, -1);
        const parts = splitComma(args);
        const arity = args.length === 0 || (args.length === 1 && args[0].value === "void") ? 0 : parts.length;
        const parameters = arity === 0 ? [] : parts.map(part => part.map(token => token.value).join(" "));
        const parameterTypes = arity === 0 ? [] : parts.map(part => {
          if (part.some(token => token.value === "[")) return null;
          const type = part.find(token => !QUALIFIERS.has(token.value));
          return type ? type.value : null;
        });
        symbols.push({ ...locationOf(name), kind: "function", name: name.value,
          type: returnType.value, parameters, parameterTypes, arity, definition: value === "{",
          documentation: definitionComment(prefix[0], tokens[i]) });
        const bodyEnd = value === "{" ? matching(tokens, i, "{", "}") : i;
        if (bodyEnd >= 0) {
          for (const part of arity === 0 ? [] : parts) {
            let first = 0;
            while (part[first] && QUALIFIERS.has(part[first].value)) first++;
            const parameterName = part[first + 1];
            if (!part[first] || !parameterName || !/^[A-Za-z_]\w*$/.test(parameterName.value)) continue;
            const declarationIndex = tokens.indexOf(parameterName);
            symbols.push({ ...locationOf(parameterName), kind: "functionParameter", name: parameterName.value,
              type: part[first].value, array: "", scopeStart: declarationIndex, scopeEnd: bodyEnd,
              declarationIndex, documentation: definitionComment(part[0], part[part.length - 1]) });
          }
          if (value === "{") localDeclarations(i, bodyEnd);
        }
      }
    } else if (value === "{" && uniformIndex >= 0) {
      const end = matching(tokens, i, "{", "}");
      if (end < 0) break;
      const instance = tokens[end + 1] && /^[A-Za-z_]\w*$/.test(tokens[end + 1].value) ? tokens[end + 1].value : null;
      let memberStart = i + 1;
      for (let j = memberStart; j < end; j++) {
        if (tokens[j].value === ";") {
          symbols.push(...declarations(tokens.slice(memberStart, j), "uniformMember", { instance }, tokens[j]));
          memberStart = j + 1;
        }
      }
      i = end;
      while (i + 1 < tokens.length && tokens[i + 1].value !== ";") i++;
      if (tokens[i + 1]) i++;
      consumedBlock = true;
    } else if (value === ";") {
      symbols.push(...declarations(prefix, "variable", {}, tokens[i]));
    }
    if (value === "{" && !consumedBlock) {
      const end = matching(tokens, i, "{", "}");
      if (end < 0) break;
      i = end;
    }
    start = i + 1;
  }
  const tokenIndexes = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const key = `${token.entry.uri.toString()}:${token.entry.line}:${token.character}:${token.value}`;
    if (!tokenIndexes.has(key)) tokenIndexes.set(key, []);
    tokenIndexes.get(key).push(i);
  }
  const symbolsByName = new Map();
  for (const symbol of symbols) {
    if (!symbolsByName.has(symbol.name)) symbolsByName.set(symbol.name, []);
    symbolsByName.get(symbol.name).push(symbol);
  }
  return { tokens, symbols, tokenIndexes, symbolsByName };
}

function sameStage(a, b) {
  return !a || !b || a === b;
}

function callArguments(tokens, open) {
  const end = matching(tokens, open, "(", ")");
  if (end < 0) return null;
  const args = tokens.slice(open + 1, end);
  return args.length ? splitComma(args) : [];
}

function obviousType(tokens) {
  if (tokens.length === 1) {
    const value = tokens[0].value;
    if (/^(true|false)$/.test(value)) return "bool";
    if (/^\d+[uU]$/.test(value)) return "uint";
    if (/^\d+$/.test(value)) return "int";
    if (/^(?:\d+\.\d*|\.\d+|\d+[eE][+-]?\d+)(?:[eE][+-]?\d+)?[fF]?$/.test(value)) return "float";
  }
  if (tokens.length > 2 && tokens[1].value === "(" &&
      /^(bool|int|uint|float|vec[234]|ivec[234]|uvec[234]|bvec[234]|mat[234](?:x[234])?)$/.test(tokens[0].value) &&
      matching(tokens, 1, "(", ")") === tokens.length - 1) return tokens[0].value;
  return null;
}

function callArgumentTypes(model, semantic, index) {
  const call = semantic.tokens[index];
  const key = `${call.entry.uri.toString()}:${call.entry.line}:${call.character}:${call.value}`;
  const indexes = semantic.tokenIndexes.get(key) || [];

  function expressionType(tokens) {
    const obvious = obviousType(tokens);
    if (obvious) return obvious;
    if (tokens.length > 1 && (tokens[0].value === "+" || tokens[0].value === "-")) {
      return expressionType(tokens.slice(1));
    }
    if (tokens[0].value === "(" && matching(tokens, 0, "(", ")") === tokens.length - 1) {
      return expressionType(tokens.slice(1, -1));
    }
    if (tokens.length > 2 && tokens[1].value === "(" &&
        matching(tokens, 1, "(", ")") === tokens.length - 1) {
      const token = tokens[0];
      const result = resolveAt(model, semantic, token.entry.uri, token.entry.line, token.character, token.value);
      const functions = result.symbols.filter(symbol => symbol.kind === "function");
      if (functions.some(symbol => symbol.conditional)) return null;
      const types = [...new Set(functions.map(symbol => symbol.type))];
      return types.length === 1 ? types[0] : null;
    }
    if (tokens.length === 3 && tokens[1].value === ".") {
      const base = expressionType(tokens.slice(0, 1));
      const vector = /^(b|i|u|d)?vec([234])$/.exec(base || "");
      const swizzle = tokens[2].value;
      if (vector && /^(?:[xyzw]{1,4}|[rgba]{1,4}|[stpq]{1,4})$/.test(swizzle)) {
        const sets = ["xyzw", "rgba", "stpq"];
        const alphabet = sets.find(set => [...swizzle].every(char => set.includes(char)));
        if (!alphabet || [...swizzle].some(char => alphabet.indexOf(char) >= Number(vector[2]))) return null;
        const scalar = { b: "bool", i: "int", u: "uint", d: "double" }[vector[1]] || "float";
        return swizzle.length === 1 ? scalar : `${vector[1] || ""}vec${swizzle.length}`;
      }
      const member = tokens[2];
      const result = resolveAt(model, semantic, member.entry.uri, member.entry.line, member.character, member.value);
      const candidates = result.symbols.filter(symbol => symbol.kind === "uniformMember" &&
        symbol.instance === tokens[0].value);
      if (candidates.some(symbol => symbol.conditional || symbol.array)) return null;
      const types = [...new Set(candidates.map(symbol => symbol.type))];
      return types.length === 1 ? types[0] : null;
    }
    if (tokens.length !== 1 || !/^[A-Za-z_]\w*$/.test(tokens[0].value)) return null;
    const token = tokens[0];
    const result = resolveAt(model, semantic, token.entry.uri, token.entry.line, token.character, token.value);
    const candidates = result.symbols.filter(symbol =>
      ["local", "variable", "functionParameter", "uniformMember"].includes(symbol.kind));
    if (candidates.some(symbol => symbol.conditional || symbol.array ||
        (symbol.kind === "functionParameter" &&
          semantic.tokens[symbol.declarationIndex + 1] &&
          semantic.tokens[symbol.declarationIndex + 1].value === "["))) return null;
    const types = [...new Set(candidates.map(symbol => symbol.type))];
    return types.length === 1 ? types[0] : null;
  }
  const typesByCall = [];
  for (const callIndex of indexes) {
    let depth = 0;
    let brackets = 0;
    let end = -1;
    if (!semantic.tokens[callIndex + 1] || semantic.tokens[callIndex + 1].value !== "(") return null;
    for (let i = callIndex + 1; i < semantic.tokens.length; i++) {
      const value = semantic.tokens[i].value;
      if ([";", "{", "}"].includes(value)) break;
      if (value === "[") brackets++;
      else if (value === "]" && --brackets < 0) break;
      if (value === "(") depth++;
      else if (value === ")" && --depth === 0) {
        if (brackets === 0) end = i;
        break;
      }
    }
    if (end < 0) return null;
    const contents = semantic.tokens.slice(callIndex + 2, end);
    if (contents.some(token => token.conditional)) return null;
    const args = contents.length ? splitComma(contents) : [];
    if (args.some(arg => !arg.length)) return null;
    typesByCall.push(args.map(expressionType));
  }
  if (!typesByCall.length || typesByCall.some(types => types.length !== typesByCall[0].length)) return null;
  return typesByCall[0].map((type, i) => typesByCall.every(types => types[i] === type) ? type : null);
}

function resolveAt(model, semantic, uri, line, character, name) {
  const tokens = semantic.tokens;
  const indexes = semantic.tokenIndexes.get(`${uri.toString()}:${line}:${character}:${name}`) || [];
  const namedSymbols = semantic.symbolsByName.get(name) || [];
  const parameters = model.parameters.filter(parameter => parameter.name === name);
  if (!indexes.length) {
    const isParameter = parameters.some(parameter => parameter.uri.toString() === uri.toString() &&
      parameter.line === line && parameter.character === character);
    return {
      parameters: isParameter ? parameters : [],
      symbols: isParameter ? namedSymbols.filter(symbol =>
        symbol.kind === "uniformMember" && symbol.name === name) : []
    };
  }
  const results = [];
  let localMatch = false;
  for (const index of indexes) {
    const token = tokens[index];
    const structs = namedSymbols.filter(symbol => symbol.kind === "struct" && sameStage(symbol.stage, token.entry.stage));
    if (structs.length && !(tokens[index - 1] && tokens[index - 1].value === ".")) {
      results.push(...structs);
      continue;
    }
    if (tokens[index + 1] && tokens[index + 1].value === "(") {
      const args = callArguments(tokens, index + 1);
      let candidates = namedSymbols.filter(symbol =>
        symbol.kind === "function" && symbol.name === name && sameStage(symbol.stage, token.entry.stage) &&
        (args === null || symbol.arity === args.length));
      if (args) {
        const types = args.map(obviousType);
        if (types.every(Boolean)) {
          const exact = candidates.filter(symbol => symbol.parameterTypes.every((type, i) => type === types[i]));
          if (exact.length) candidates = exact;
        }
      }
      results.push(...candidates);
    } else {
      const members = tokens[index - 1] && tokens[index - 1].value === "." && tokens[index - 2];
      const locals = members ? [] : namedSymbols.filter(symbol =>
        (symbol.kind === "local" || symbol.kind === "functionParameter") &&
        sameStage(symbol.stage, token.entry.stage) && index >= symbol.declarationIndex && index <= symbol.scopeEnd);
      if (locals.length) {
        locals.sort((a, b) => b.scopeStart - a.scopeStart || b.declarationIndex - a.declarationIndex);
        results.push(locals[0]);
        localMatch = true;
        continue;
      }
      results.push(...namedSymbols.filter(symbol =>
        symbol.kind !== "function" && symbol.kind !== "local" && symbol.kind !== "functionParameter" &&
        symbol.kind !== "struct" && symbol.name === name && sameStage(symbol.stage, token.entry.stage) &&
        (members ? symbol.kind === "uniformMember" && symbol.instance === members.value :
          symbol.kind !== "uniformMember" || !symbol.instance)));
      const own = namedSymbols.find(symbol => symbol.kind === "variable" && symbol.name === name &&
        symbol.uri.toString() === uri.toString() && symbol.line === line && symbol.character === character);
      if (own && own.location !== null) {
        const counterpart = own.stage === "vertex" && own.qualifiers.includes("out") ? "fragment" :
          own.stage === "fragment" && own.qualifiers.includes("in") ? "vertex" : null;
        if (counterpart) results.push(...semantic.symbols.filter(symbol => symbol.kind === "variable" &&
          symbol.stage === counterpart && symbol.location === own.location &&
          symbol.qualifiers.includes(counterpart === "vertex" ? "out" : "in")));
      }
    }
  }
  const unique = new Map(results.map(symbol => [`${symbol.uri.toString()}:${symbol.line}:${symbol.character}`, symbol]));
  const isCall = indexes.some(index => tokens[index + 1] && tokens[index + 1].value === "(");
  const isMember = indexes.some(index => tokens[index - 1] && tokens[index - 1].value === ".");
  const matchedMember = [...unique.values()].some(symbol => symbol.kind === "uniformMember");
  return { parameters: isCall || localMatch || (isMember && !matchedMember) ? [] : parameters, symbols: [...unique.values()] };
}

function semanticIssues(model, semantic) {
  const issues = [];
  const parameterNames = new Set(model.parameters.map(parameter => parameter.name));
  for (const symbol of semantic.symbols) {
    if (symbol.kind !== "uniformMember" || symbol.conditional || symbol.array) continue;
    const expected = builtinType(symbol.name) || (parameterNames.has(symbol.name) ? "float" : null);
    if (expected && symbol.type !== expected &&
        /^(bool|int|uint|float|double|[biud]?vec[234]|d?mat[234](?:x[234])?)$/.test(symbol.type)) {
      issues.push({ ...symbol, message: `Uniform "${symbol.name}" must have type ${expected}, not ${symbol.type}.` });
    }
  }
  const stages = new Set(model.entries.map(entry => entry.stage).filter(Boolean));
  if (!stages.has("vertex") || !stages.has("fragment") || model.issues.length) return issues;
  const outputs = semantic.symbols.filter(symbol => symbol.kind === "variable" && symbol.stage === "vertex" &&
    symbol.qualifiers.includes("out") && symbol.location !== null && !symbol.conditional);
  for (const input of semantic.symbols.filter(symbol => symbol.kind === "variable" && symbol.stage === "fragment" &&
    symbol.qualifiers.includes("in") && symbol.location !== null && !symbol.conditional)) {
    const output = outputs.find(symbol => symbol.location === input.location);
    if (output && (input.type !== output.type || input.array !== output.array) &&
        /^(float|int|uint|vec[234]|ivec[234]|uvec[234])$/.test(input.type) &&
        /^(float|int|uint|vec[234]|ivec[234]|uvec[234])$/.test(output.type) &&
        (!input.array || /^\[\d+\]$/.test(input.array)) && (!output.array || /^\[\d+\]$/.test(output.array))) {
      issues.push({ ...input, message: `Fragment input at location ${input.location} has type ${input.type}${input.array}, but vertex output has type ${output.type}${output.array}.` });
    }
  }
  return issues;
}

function outputIssues(model, semantic) {
  const issues = [];
  if (model.issues.length || model.missingOptional) return issues;
  const main = stage => model.entries.some(entry => /^\s*#\s*pragma\s+stage\s+/i.test(entry.text) && entry.stage === stage) &&
    semantic.symbols.some(symbol => symbol.kind === "function" && symbol.name === "main" &&
      symbol.definition && symbol.arity === 0 && (symbol.stage === stage || !symbol.stage));
  const vertex = main("vertex");
  const fragment = main("fragment");
  const tokens = semantic.tokens;
  const assignment = (name, stage) => tokens.some((token, index) => {
    if (token.value !== name || (token.entry.stage && token.entry.stage !== stage) ||
        (tokens[index - 1] && tokens[index - 1].value === ".")) return false;
    let next = index + 1;
    if (tokens[next] && tokens[next].value === "." && tokens[next + 1]) next += 2;
    if (tokens[next] && tokens[next].value === "[") {
      const end = matching(tokens, next, "[", "]");
      if (end < 0) return false;
      next = end + 1;
    }
    if (!tokens[next]) return false;
    const simple = tokens[next].value === "=" && (!tokens[next + 1] || tokens[next + 1].value !== "=");
    const compound = ["+", "-", "*", "/", "%", "&", "|", "^"].includes(tokens[next].value) &&
      tokens[next + 1] && tokens[next + 1].value === "=";
    if (!simple && !compound) return false;
    const resolved = resolveAt(model, semantic, token.entry.uri, token.entry.line, token.character, name);
    return !resolved.symbols.some(symbol => symbol.kind === "local" || symbol.kind === "functionParameter");
  });
  const uncertain = stage => model.entries.some(entry => (!entry.stage || entry.stage === stage) &&
    /^\s*#\s*(?:define|if|ifdef|ifndef|elif|else)\b/.test(entry.text));
  const stageEntry = stage => model.entries.find(entry => /^\s*#\s*pragma\s+stage\s+/i.test(entry.text) && entry.stage === stage);
  if (vertex && !uncertain("vertex") && !assignment("gl_Position", "vertex")) {
    issues.push({ ...stageEntry("vertex"), message: "No assignment to gl_Position was found in the vertex stage." });
  }
  const outputs = semantic.symbols.filter(symbol => symbol.kind === "variable" && (symbol.stage === "vertex" || !symbol.stage) &&
    symbol.qualifiers.includes("out") && symbol.location !== null);
  const fragmentOutputs = semantic.symbols.filter(symbol => symbol.kind === "variable" && (symbol.stage === "fragment" || !symbol.stage) &&
    symbol.qualifiers.includes("out") && symbol.location === 0 && !symbol.conditional);
  if (fragment && fragmentOutputs.length === 0 && !uncertain("fragment")) {
    issues.push({ ...stageEntry("fragment"), message: "No fragment output at location 0 was found." });
  }
  if (fragment && fragmentOutputs.length === 1 && !uncertain("fragment") &&
      !assignment(fragmentOutputs[0].name, "fragment")) {
    issues.push({ ...fragmentOutputs[0], message: `No assignment to fragment output "${fragmentOutputs[0].name}" at location 0 was found.` });
  }
  const simple = symbol => /^(float|int|uint|vec[234]|ivec[234]|uvec[234])$/.test(symbol.type) && !symbol.array;
  if (vertex && fragment && !uncertain("vertex") && !uncertain("fragment") &&
      outputs.every(output => simple(output) && !output.conditional)) {
    const inputs = semantic.symbols.filter(symbol => symbol.kind === "variable" && (symbol.stage === "fragment" || !symbol.stage) &&
      symbol.qualifiers.includes("in") && symbol.location !== null && !symbol.conditional && simple(symbol));
    const checkedOutputs = new Set();
    for (const input of inputs) {
      const matchingOutput = outputs.find(output => output.location === input.location);
      if (!matchingOutput) {
        issues.push({ ...input, message: `Fragment input "${input.name}" at location ${input.location} has no vertex output at that location.` });
      } else if (!checkedOutputs.has(matchingOutput) && !assignment(matchingOutput.name, "vertex")) {
        issues.push({ ...matchingOutput, message: `No assignment to vertex output "${matchingOutput.name}" at location ${input.location} was found.` });
        checkedOutputs.add(matchingOutput);
      }
    }
  }
  return issues;
}

module.exports = { builtinType, buildSemanticModel, resolveAt, semanticIssues, outputIssues, callArgumentTypes };
